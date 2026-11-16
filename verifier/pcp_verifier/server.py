"""PCP verifier HTTP API (AGENTS.md section 4.4). Default http://127.0.0.1:8765

POST /verify                 start a verification         -> {patch_id}
GET  /verify/{id}/events     live progress (SSE)
GET  /verify/{id}            Verdict (200) or {"status": "running"} (202)
POST /verify/{id}/cancel     kill the sandbox; nothing is written
POST /llm/complete           model gateway with failover
GET  /llm/status             which models are configured, last failover
POST /llm/simulate           demo: make the primary model fail (ok|fail|timeout)
GET  /health                 liveness

Security: /verify runs the patch's tests, i.e. code. The server binds to
localhost, rejects browser origins (CSRF), and can require PCP_API_TOKEN.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from sse_starlette import EventSourceResponse

from pcp_verifier import __version__
from pcp_verifier.contracts import (
    Event,
    Health,
    LLMRequest,
    LLMResponse,
    LLMSimulateRequest,
    LLMStatus,
    Verdict,
    VerifyRequest,
    VerifyResponse,
)
from pcp_verifier.core.proof_runner import FrozenState
from pcp_verifier.gateway import GatewayError, gateway_from_env
from pcp_verifier.journal import Journal
from pcp_verifier.pipeline import ChainState, RunHandle, verify

ALLOWED_ORIGIN_PREFIXES = (
    "vscode-webview://",
    "vscode-file://",
    "http://127.0.0.1",
    "http://localhost",
)


@dataclass
class RunState:
    patch_id: str
    root_id: str
    request: VerifyRequest
    handle: RunHandle
    events: list[Event] = field(default_factory=list)
    changed: asyncio.Condition = field(default_factory=asyncio.Condition)
    verdict: Verdict | None = None
    frozen: FrozenState | None = None
    task: asyncio.Task | None = None
    done: bool = False


class Registry:
    def __init__(self, journal: Journal):
        self.runs: dict[str, RunState] = {}
        self.journal = journal

    def get(self, patch_id: str) -> RunState:
        run = self.runs.get(patch_id)
        if run is None:
            raise HTTPException(404, f"unknown patch_id {patch_id}")
        return run

    def chain_for(self, previous_patch_id: str | None) -> tuple[ChainState, str | None, int | None]:
        """(chain, root_id, previous attempt) inherited from the previous attempt."""
        if not previous_patch_id:
            return ChainState(), None, None
        prev = self.runs.get(previous_patch_id)
        if prev is not None:
            if not prev.done or prev.verdict is None:
                raise HTTPException(409, f"previous patch {previous_patch_id} is still running")
            return (
                ChainState(prev.frozen, list(prev.verdict.score_history)),
                prev.root_id,
                prev.verdict.attempt,
            )
        row = self.journal.get_run(previous_patch_id)
        if row is None or not row.get("verdict_json"):
            raise HTTPException(404, f"unknown previous_patch_id {previous_patch_id}")
        verdict = Verdict.model_validate_json(row["verdict_json"])
        frozen = (
            FrozenState.from_dict(json.loads(row["frozen_json"])) if row["frozen_json"] else None
        )
        return ChainState(frozen, list(verdict.score_history)), row["root_id"], verdict.attempt


def create_app(journal: Journal | None = None, gateway=None) -> FastAPI:
    journal = journal or Journal()
    gateway = gateway if gateway is not None else gateway_from_env(journal.log_llm)
    registry = Registry(journal)

    @asynccontextmanager
    async def lifespan(_app):
        yield
        for run in registry.runs.values():  # shutdown: kill every sandbox
            run.handle.cancel()

    app = FastAPI(title="PCP verifier", version=__version__, lifespan=lifespan)
    app.state.registry = registry
    app.state.journal = journal
    app.state.gateway = gateway

    @app.middleware("http")
    async def guard(request: Request, call_next):
        origin = request.headers.get("origin")
        if origin and not origin.startswith(ALLOWED_ORIGIN_PREFIXES):
            return JSONResponse({"detail": f"origin {origin} not allowed"}, status_code=403)
        token = os.environ.get("PCP_API_TOKEN")
        if token and request.url.path != "/health" and request.headers.get("x-pcp-token") != token:
            return JSONResponse({"detail": "missing or wrong X-PCP-Token"}, status_code=401)
        return await call_next(request)

    # ------------------------------------------------------------------ health
    @app.get("/health", response_model=Health)
    async def health() -> Health:
        sandbox = "docker" if os.environ.get("PCP_SANDBOX", "local") == "docker" else "local-temp"
        return Health(status="ok", version=__version__, sandbox=sandbox)

    # ------------------------------------------------------------------ verify
    @app.post("/verify", response_model=VerifyResponse)
    async def start(req: VerifyRequest) -> VerifyResponse:
        if not Path(req.repo_root).is_dir():
            raise HTTPException(400, f"repo_root does not exist: {req.repo_root}")
        chain, root_id, prev_attempt = registry.chain_for(req.previous_patch_id)
        if prev_attempt is not None and req.attempt != prev_attempt + 1:
            raise HTTPException(
                422, f"attempt must be {prev_attempt + 1} (previous attempt was {prev_attempt})"
            )
        if prev_attempt is None and req.attempt != 1:
            raise HTTPException(
                422, "attempt > 1 needs previous_patch_id (the frozen tests live there)"
            )
        patch_id = str(uuid.uuid4())
        run = RunState(patch_id, root_id or patch_id, req, RunHandle(patch_id))
        registry.runs[patch_id] = run
        journal.start_run(
            patch_id, run.root_id, req.previous_patch_id, req.task, req.repo_root, req.attempt
        )

        def emit(event: Event) -> None:
            run.events.append(event)
            asyncio.get_running_loop().create_task(_notify(run))

        async def work():
            try:
                result = await verify(
                    req, patch_id, chain=chain, emit=emit, handle=run.handle, gateway=gateway
                )
                run.verdict, run.frozen = result.verdict, result.frozen
                journal.finish_run(result.verdict, result.frozen.to_dict(), result.latency_ms)
            except Exception as e:  # noqa: BLE001 - a failed run must still end its stream, loudly
                emit(
                    Event(
                        patch_id=patch_id,
                        stage="verdict",
                        status="failed",
                        message=f"internal error: {e}",
                    )
                )
            finally:
                run.done = True
                await _notify(run)

        run.task = asyncio.create_task(work())
        return VerifyResponse(patch_id=patch_id)

    @app.get("/verify/{patch_id}/events")
    async def events(patch_id: str, request: Request):
        run = registry.get(patch_id)

        async def stream():
            sent = 0
            while True:
                while sent < len(run.events):
                    ev = run.events[sent]
                    sent += 1
                    yield {"event": ev.stage, "id": str(sent), "data": ev.model_dump_json()}
                if run.done and sent >= len(run.events):
                    return
                if await request.is_disconnected():
                    return
                async with run.changed:
                    with suppress(TimeoutError):
                        await asyncio.wait_for(run.changed.wait(), timeout=1.0)

        return EventSourceResponse(stream(), ping=10)

    @app.get("/verify/{patch_id}", response_model=Verdict)
    async def result(patch_id: str):
        run = registry.get(patch_id)
        if run.verdict is None:
            status = "failed" if run.done else "running"
            code = 500 if run.done else 202
            last = run.events[-1].message if run.events else ""
            return JSONResponse(
                {"patch_id": patch_id, "status": status, "message": last}, status_code=code
            )
        return run.verdict

    @app.post("/verify/{patch_id}/cancel")
    async def cancel(patch_id: str):
        run = registry.get(patch_id)
        if run.done:
            return {"patch_id": patch_id, "cancelled": False, "reason": "already finished"}
        run.handle.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(run.task), timeout=10)
        except TimeoutError:
            run.task.cancel()
        return {"patch_id": patch_id, "cancelled": True}

    # ------------------------------------------------------------------ llm
    @app.post("/llm/complete", response_model=LLMResponse)
    async def llm_complete(req: LLMRequest) -> LLMResponse:
        if gateway is None:
            raise HTTPException(
                503, "no model configured (set PCP_PRIMARY_* / PCP_SECONDARY_* in .env)"
            )
        try:
            return await gateway.complete(req)
        except GatewayError as e:
            raise HTTPException(502, {"message": str(e), "errors": e.errors}) from e

    @app.get("/llm/status", response_model=LLMStatus)
    async def llm_status() -> LLMStatus:
        if gateway is None:
            return LLMStatus(configured=False)
        return gateway.status()

    @app.post("/llm/simulate", response_model=LLMStatus)
    async def llm_simulate(req: LLMSimulateRequest) -> LLMStatus:
        """Task C demo: break the primary model live (fail = HTTP 503, timeout = hang)."""
        if gateway is None:
            raise HTTPException(
                503, "no model configured (set PCP_PRIMARY_* / PCP_SECONDARY_* in .env)"
            )
        if os.environ.get("PCP_ALLOW_SIMULATE", "1") == "0":
            raise HTTPException(403, "simulation disabled (PCP_ALLOW_SIMULATE=0)")
        gateway.simulate(req.primary)
        return gateway.status()

    return app


async def _notify(run: RunState) -> None:
    async with run.changed:
        run.changed.notify_all()


def _load_dotenv() -> None:
    from pcp_verifier.contracts import REPO_ROOT

    env = REPO_ROOT / ".env"
    if not env.is_file():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_app: FastAPI | None = None


def __getattr__(name: str):
    # `uvicorn pcp_verifier.server:app` builds the app lazily (so importing this module in tests
    # never opens the real journal)
    global _app
    if name == "app":
        if _app is None:
            _load_dotenv()
            _app = create_app()
        return _app
    raise AttributeError(name)


def main() -> None:
    import uvicorn

    _load_dotenv()
    uvicorn.run(
        create_app(),
        host=os.environ.get("PCP_HOST", "127.0.0.1"),
        port=int(os.environ.get("PCP_PORT", "8765")),
    )


if __name__ == "__main__":
    main()
