// TrueForge agent backend (@truefoundry/trueforge-sdk). The agent runs in TrueForge with this
// extension's MCP server attached by name; tier >= 2 tools need approval, which TrueForge
// surfaces as `tool.approval_required` and we answer through PCP's own approval gate.
//
// APIs used (see DECISIONS.md): sessions.create({agent:{spec}}), sessions.createTurnStream,
// sessions.createTurnEvents (user.tool_approval), sessions.subscribeToTurn (resume after a pause).
import { CancelledError } from "../api/client";
import type { AgentBackend, Proposal } from "./loop";
import type { ProposeInput } from "./prompt";
import { buildUserPrompt, extractDiff, SYSTEM_PROMPT } from "./prompt";

/** The subset of TrueForge stream events we act on (structural, so tests can fake them). */
export type TfEvent =
  | { type: "turn.created"; id: string; turnId: string }
  | { type: "model.message.delta"; id: string; content?: string | null }
  | {
      type: "model.message";
      id: string;
      content?: string | { type: string; text?: string }[] | null;
      toolCalls?: { id: string; function: { name: string; arguments: string } }[];
      model?: { name: string };
    }
  | { type: "tool.approval_required"; id: string; threadId: string; toolCalls: { id: string; sourceEventId: string }[] }
  | {
      type: "turn.done";
      id: string;
      state:
        | { status: "done"; output: { content?: unknown } | null }
        | { status: "error"; message: string }
        | { status: "cancelled" };
    }
  | { type: string; id: string };

export interface TrueForgeLike {
  sessions: {
    create(req: unknown): Promise<{ data: { id: string } }>;
    createTurnStream(sessionId: string, req: unknown, opts?: unknown): Promise<AsyncIterable<TfEvent>>;
    createTurnEvents(sessionId: string, turnId: string, req: unknown): Promise<unknown>;
    subscribeToTurn(sessionId: string, turnId: string, req: unknown, opts?: unknown): Promise<AsyncIterable<TfEvent>>;
  };
}

export interface ToolApprovalRequest {
  tool: string;
  args: unknown;
}

export interface TrueForgeOptions {
  baseUrl: string;
  model: string;
  /** Name of this extension's MCP server in TrueForge Settings > Connectors. */
  mcpServerName?: string;
  token?: string;
  /** Asks the developer (via PCP's ApprovalGate). Return true to allow. */
  approve: (req: ToolApprovalRequest) => Promise<boolean>;
  onLog?: (line: string) => void;
  onDelta?: (text: string) => void;
  /** For tests: inject a client instead of importing the SDK. */
  client?: TrueForgeLike;
  timeoutSeconds?: number;
}

/** Tools TrueForge must pause on (tier >= 2), in addition to anything the server marks destructive. */
export const APPROVAL_TOOLS = ["run_tests", "run_command", "write_file", "@destructive"];

function contentText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: { text?: string }) => p?.text ?? "").join("");
  return "";
}

/** "pcp-editor__run_tests" / "pcp-editor.run_tests" -> "run_tests" */
export function bareToolName(name: string): string {
  const m = /(?:__|\.|\/)([^_./][^./]*)$/.exec(name);
  return m ? m[1]! : name;
}

export class TrueForgeBackend implements AgentBackend {
  readonly name = "TrueForge";
  private sessionId?: string;
  private clientPromise?: Promise<TrueForgeLike>;

  constructor(private readonly o: TrueForgeOptions) {
    if (!o.model) throw new Error("Set pcp.trueforge.model (provider/model as configured in TrueForge).");
  }

  private client(): Promise<TrueForgeLike> {
    if (this.o.client) return Promise.resolve(this.o.client);
    this.clientPromise ??= import("@truefoundry/trueforge-sdk").then(
      (m) =>
        new m.TrueForge({
          baseUrl: this.o.baseUrl,
          ...(this.o.token ? { token: this.o.token } : {}),
          timeoutInSeconds: this.o.timeoutSeconds ?? 600,
        }) as unknown as TrueForgeLike,
    );
    return this.clientPromise;
  }

  async propose(input: ProposeInput, signal?: AbortSignal): Promise<Proposal> {
    const tf = await this.client();
    const reqOpts = { abortSignal: signal, timeoutInSeconds: this.o.timeoutSeconds ?? 600 };
    if (!this.sessionId) {
      const created = await tf.sessions.create({
        agent: {
          spec: {
            model: { name: this.o.model },
            instructions: SYSTEM_PROMPT,
            ...(this.o.mcpServerName
              ? { mcpServers: [{ name: this.o.mcpServerName, requireApprovalForTools: APPROVAL_TOOLS }] }
              : {}),
          },
        },
        metadata: { source: "pcp-vscode" },
      });
      this.sessionId = created.data.id;
      this.o.onLog?.(`TrueForge session ${this.sessionId} (model ${this.o.model})`);
    }
    const sid = this.sessionId;
    let stream = await tf.sessions.createTurnStream(
      sid,
      { input: [{ type: "user.message", content: buildUserPrompt(input) }] },
      reqOpts,
    );

    const toolCalls = new Map<string, { name: string; arguments: string }>();
    let turnId = "";
    let lastEventId = "";
    let streamed = "";
    let lastMessage = "";
    let modelName: string | undefined;

    for (;;) {
      let paused: Extract<TfEvent, { type: "tool.approval_required" }> | undefined;
      let finished: string | undefined;
      for await (const ev of stream) {
        if (signal?.aborted) throw new CancelledError();
        lastEventId = ev.id;
        switch (ev.type) {
          case "turn.created":
            turnId = (ev as { turnId: string }).turnId;
            break;
          case "model.message.delta": {
            const c = (ev as { content?: string | null }).content;
            if (c) {
              streamed += c;
              this.o.onDelta?.(c);
            }
            break;
          }
          case "model.message": {
            const m = ev as Extract<TfEvent, { type: "model.message" }>;
            for (const call of m.toolCalls ?? []) toolCalls.set(call.id, call.function);
            const text = contentText(m.content);
            if (text) lastMessage = text;
            modelName = m.model?.name ?? modelName;
            break;
          }
          case "tool.approval_required":
            paused = ev as Extract<TfEvent, { type: "tool.approval_required" }>;
            break;
          case "turn.done": {
            const st = (ev as Extract<TfEvent, { type: "turn.done" }>).state;
            if (st.status === "error") throw new Error(`TrueForge turn failed: ${st.message}`);
            if (st.status === "cancelled") throw new CancelledError("TrueForge turn cancelled");
            finished = contentText(st.output?.content) || lastMessage || streamed;
            break;
          }
        }
      }
      if (finished !== undefined) {
        return { diff: extractDiff(finished), text: finished, modelUsed: modelName ?? this.o.model };
      }
      if (!paused) throw new Error("TrueForge stream ended without turn.done");

      const events = [];
      for (const ref of paused.toolCalls) {
        const fn = toolCalls.get(ref.id);
        const tool = bareToolName(fn?.name ?? "unknown tool");
        let args: unknown = fn?.arguments;
        try {
          args = JSON.parse(fn?.arguments ?? "null");
        } catch {
          /* keep the raw string */
        }
        const ok = await this.o.approve({ tool, args });
        this.o.onLog?.(`TrueForge asked to run ${tool}: ${ok ? "allowed" : "denied"}`);
        events.push({
          type: "user.tool_approval",
          threadId: paused.threadId,
          toolCallId: ref.id,
          approval: ok ? { status: "allow" } : { status: "deny", reason: "Denied by the developer in PCP" },
        });
      }
      await tf.sessions.createTurnEvents(sid, turnId, { events });
      stream = await tf.sessions.subscribeToTurn(sid, turnId, { afterEventId: lastEventId }, reqOpts);
    }
  }
}
