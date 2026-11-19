import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { McpServerHandle } from "../src/mcp/server";
import { isAllowedOrigin, startMcpServer } from "../src/mcp/server";
import { FakeWriteGate, setup, tempRepo } from "./mcp-helpers";

let repo: ReturnType<typeof tempRepo>;
let server: McpServerHandle | undefined;
let client: Client | undefined;

beforeEach(() => {
  repo = tempRepo();
});
afterEach(async () => {
  await client?.close().catch(() => undefined);
  await server?.close();
  client = undefined;
  server = undefined;
  repo.cleanup();
});

async function connect() {
  const s = setup({ root: repo.root, answer: false, writeGate: new FakeWriteGate() });
  server = await startMcpServer({ port: 0, runner: s.runner });
  client = new Client({ name: "pcp-test", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  return { ...s, client, url: server.url };
}

const textOf = (r: Record<string, unknown>) =>
  ((r.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");

describe("MCP over streamable HTTP", () => {
  it("lists every tool with annotations", async () => {
    const { client, url } = await connect();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["apply_patch_to_shadow", "git_diff", "grep", "list_dir", "read_file", "run_command", "run_tests", "write_file"].sort(),
    );
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("read_file")?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(byName.get("write_file")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: false });
    expect(byName.get("run_command")?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get("read_file")?.inputSchema.properties).toHaveProperty("path");
    expect(byName.get("read_file")?.title).toBe("Read file");
  });

  it("read_file succeeds, write_file without an accepted hunk is an error", async () => {
    const { client, audit } = await connect();
    const read = await client.callTool({ name: "read_file", arguments: { path: "src/tiny/mathx.py" } });
    expect(read.isError).toBeFalsy();
    expect(textOf(read)).toContain("def parse_bool");

    const write = await client.callTool({ name: "write_file", arguments: { hunk_id: "h1" } });
    expect(write.isError).toBe(true);
    expect(textOf(write)).toContain("accepted in the PCP review panel");

    expect(audit.entries().map((e) => [e.tool, e.source, e.outcome])).toEqual([
      ["read_file", "mcp", "ok"],
      ["write_file", "mcp", "denied"],
    ]);
  });

  it("refuses non-local origins and non-POST requests", async () => {
    const { url } = await connect();
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const evil = await fetch(url, { method: "POST", body, headers: { ...headers, origin: "http://evil.example" } });
    expect(evil.status).toBe(403);
    const get = await fetch(url, { method: "GET" });
    expect(get.status).toBe(405);
    const local = await fetch(url, { method: "POST", body, headers: { ...headers, origin: "http://localhost:3000" } });
    expect(local.status).toBe(200);
  });

  it("isAllowedOrigin", () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:8790")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:1")).toBe(true);
    expect(isAllowedOrigin("http://localhost.evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(false);
  });
});
