// Shared fixtures for the mcp-*.test.ts files (not a test file itself).
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PcpEvent, Verdict, VerifyRequest } from "../src/contracts";
import { AuditLog } from "../src/mcp/audit";
import type { ApprovalQuestion, Prompter } from "../src/mcp/tiers";
import { ApprovalGate } from "../src/mcp/tiers";
import type { ToolHost, WriteGate } from "../src/mcp/tools";
import { ToolRunner } from "../src/mcp/tools";

export const REPO = join(__dirname, "..", "..");
export const TINY = join(REPO, "fixtures", "tiny_repo");
export const diffFixture = (name: string) => readFileSync(join(TINY, "diffs", name), "utf8");
export const example = <T>(name: string): T =>
  JSON.parse(readFileSync(join(REPO, "contracts", "examples", name), "utf8")) as T;

/** A fresh copy of fixtures/tiny_repo in a temp dir. */
export function tempRepo(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "pcp-mcp-"));
  cpSync(TINY, root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export class FakePrompter implements Prompter {
  readonly asked: ApprovalQuestion[] = [];
  constructor(public answer: boolean) {}
  async ask(q: ApprovalQuestion): Promise<boolean> {
    this.asked.push(q);
    return this.answer;
  }
}

export class FakeVerifier {
  readonly requests: VerifyRequest[] = [];
  constructor(private readonly verdict: Verdict) {}
  async verify(req: VerifyRequest) {
    this.requests.push(req);
    return { patch_id: this.verdict.patch_id };
  }
  async *events(patchId: string): AsyncGenerator<PcpEvent> {
    yield { patch_id: patchId, stage: "proof", status: "started", message: "Running tests" };
    yield { patch_id: patchId, stage: "verdict", status: "done", message: this.verdict.decision };
  }
  async waitForVerdict(_patchId: string) {
    return this.verdict;
  }
}

export class FakeWriteGate implements WriteGate {
  readonly patchId = "p-1";
  readonly accepted = new Set<string>();
  readonly applied: string[] = [];
  isAccepted(hunkId: string) {
    return this.accepted.has(hunkId);
  }
  async applyAccepted(hunkId: string) {
    this.applied.push(hunkId);
    return { file: "src/tiny/mathx.py", action: "write" };
  }
}

export function setup(opts: { root: string; answer?: boolean; allowList?: string[]; writeGate?: WriteGate }) {
  const prompter = new FakePrompter(opts.answer ?? false);
  const gate = new ApprovalGate({ allowList: opts.allowList ?? ["pytest", "git diff"], prompter });
  const audit = new AuditLog();
  const verifier = new FakeVerifier(example<Verdict>("verdict_repair.json"));
  const host: ToolHost = {
    root: opts.root,
    verifier,
    task: () => "Make parse_bool also treat on as true.",
    writeGate: () => opts.writeGate,
  };
  const runner = new ToolRunner(host, gate, audit);
  return { prompter, gate, audit, verifier, runner };
}
