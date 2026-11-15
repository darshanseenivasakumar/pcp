"""Model gateway with automatic failover (Task C evidence).

primary -> retry once (short backoff) -> secondary. Every call has a timeout,
and every attempt is journaled with which model answered and how long the
failover took.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

import httpx

from pcp_verifier.contracts import LLMMessage, LLMRequest, LLMResponse

RETRY_BACKOFF_S = 0.3


class ProviderError(RuntimeError):
    pass


class GatewayError(RuntimeError):
    def __init__(self, errors: list[str]):
        super().__init__("all models failed: " + " | ".join(errors))
        self.errors = errors


class Provider(Protocol):
    name: str

    async def complete(
        self, messages: list[LLMMessage], max_tokens: int | None, timeout: float
    ) -> str: ...


@dataclass
class OpenAICompatProvider:
    """Any OpenAI-compatible /chat/completions endpoint (OpenAI, Azure, Anthropic compat, vLLM, Ollama...)."""

    name: str
    base_url: str
    model: str
    api_key: str = ""

    async def complete(self, messages, max_tokens, timeout) -> str:
        if not self.base_url or not self.model:
            raise ProviderError(f"{self.name}: base_url/model not configured")
        headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}
        body = {"model": self.model, "messages": [m.model_dump() for m in messages]}
        if max_tokens:
            body["max_tokens"] = max_tokens
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(
                    self.base_url.rstrip("/") + "/chat/completions", json=body, headers=headers
                )
        except httpx.TimeoutException as e:
            raise ProviderError(f"{self.name}: timeout after {timeout:.0f}s") from e
        except httpx.HTTPError as e:
            raise ProviderError(f"{self.name}: {type(e).__name__}: {e}") from e
        if resp.status_code >= 400:
            raise ProviderError(f"{self.name}: HTTP {resp.status_code} {resp.reason_phrase}")
        try:
            return resp.json()["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, ValueError) as e:
            raise ProviderError(f"{self.name}: malformed response") from e


@dataclass
class FakeProvider:
    """Scriptable provider for tests, the bench and the Task C demo.

    mode: "ok" | "fail" | "timeout" | "flaky" (fails once, then ok)
    """

    name: str
    mode: str = "ok"
    reply: str = '{"verdict": "confirm", "confidence": 0.9}'
    delay_s: float = 0.0
    calls: int = 0

    async def complete(self, messages, max_tokens, timeout) -> str:
        self.calls += 1
        if self.delay_s:
            await asyncio.sleep(min(self.delay_s, timeout))
        if self.mode == "fail" or (self.mode == "flaky" and self.calls == 1):
            raise ProviderError(f"{self.name}: HTTP 503 Service Unavailable (simulated)")
        if self.mode == "timeout":
            await asyncio.sleep(timeout)
            raise ProviderError(f"{self.name}: timeout after {timeout:.0f}s (simulated)")
        return self.reply


Journal = Callable[[dict], None]


class Gateway:
    def __init__(
        self,
        primary: Provider,
        secondary: Provider | None,
        timeout_s: float = 20.0,
        journal: Journal | None = None,
    ):
        self.primary, self.secondary = primary, secondary
        self.timeout_s = timeout_s
        self.journal = journal

    async def _try(self, provider: Provider, req: LLMRequest, label: str, errors: list[str]):
        t0 = time.monotonic()
        try:
            text = await asyncio.wait_for(
                provider.complete(req.messages, req.max_tokens, self.timeout_s), self.timeout_s + 1
            )
            self._log(req, provider.name, label, True, t0, None)
            return text
        except (ProviderError, TimeoutError) as e:
            msg = str(e) or f"{provider.name}: timeout after {self.timeout_s:.0f}s"
            errors.append(f"{label}: {msg}")
            self._log(req, provider.name, label, False, t0, msg)
            return None

    def _log(self, req, model, label, ok, t0, error):
        if self.journal:
            self.journal(
                {
                    "purpose": req.purpose,
                    "model": model,
                    "attempt": label,
                    "ok": ok,
                    "latency_ms": int((time.monotonic() - t0) * 1000),
                    "error": error,
                }
            )

    async def complete(self, req: LLMRequest) -> LLMResponse:
        start = time.monotonic()
        errors: list[str] = []
        text = await self._try(self.primary, req, "primary", errors)
        if text is None:
            await asyncio.sleep(RETRY_BACKOFF_S)
            text = await self._try(self.primary, req, "primary retry", errors)
        if text is not None:
            return LLMResponse(
                text=text, model_used=f"primary:{self.primary.name}", failover_ms=0, errors=errors
            )
        if self.secondary is None:
            raise GatewayError(errors)
        failover_ms = int((time.monotonic() - start) * 1000)
        text = await self._try(self.secondary, req, "secondary", errors)
        if text is None:
            raise GatewayError(errors)
        return LLMResponse(
            text=text,
            model_used=f"secondary:{self.secondary.name}",
            failover_ms=failover_ms,
            failed_over=True,
            errors=errors,
        )


def _provider_from_env(prefix: str) -> Provider | None:
    kind = os.environ.get(f"{prefix}_PROVIDER", "").strip().lower()
    model = os.environ.get(f"{prefix}_MODEL", "").strip()
    if kind == "fake":
        return FakeProvider(
            name=model or f"fake-{prefix.split('_')[-1].lower()}",
            mode=os.environ.get(f"{prefix}_FAKE_MODE", "ok"),
        )
    base = os.environ.get(f"{prefix}_BASE_URL", "").strip()
    if kind in {"", "openai_compat"} and base and model:
        return OpenAICompatProvider(
            name=model, base_url=base, model=model, api_key=os.environ.get(f"{prefix}_API_KEY", "")
        )
    return None


def gateway_from_env(journal: Journal | None = None) -> Gateway | None:
    primary = _provider_from_env("PCP_PRIMARY")
    secondary = _provider_from_env("PCP_SECONDARY")
    if primary is None and secondary is None:
        return None
    if primary is None:
        primary, secondary = secondary, None
    return Gateway(primary, secondary, float(os.environ.get("PCP_LLM_TIMEOUT_S", "20")), journal)
