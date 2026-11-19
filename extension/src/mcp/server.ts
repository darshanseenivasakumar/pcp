// The editor's MCP server: streamable HTTP on 127.0.0.1, path /mcp, stateless (a fresh
// McpServer + transport per request). TrueForge connects to it by URL. Every tool call goes
// through ToolRunner, so tiers, approvals and the audit log apply to MCP calls too.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ToolRunner } from "./tools";

export interface McpServerHandle {
  url: string;
  close(): Promise<void>;
}

export interface McpServerOptions {
  port: number;
  host?: string;
  runner: ToolRunner;
  /** Name reported to MCP clients. */
  name?: string;
  /** Request bodies larger than this are refused (default 10 MB). */
  maxBodyBytes?: number;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** DNS-rebinding guard: a browser page from another origin must not drive the editor tools. */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "") return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function buildServer(runner: ToolRunner, name: string): McpServer {
  const server = new McpServer({ name, version: "0.1.0" });
  for (const spec of runner.list()) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: `[tier ${spec.tier}] ${spec.description}`,
        inputSchema: spec.inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          destructiveHint: spec.destructive,
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const out = await runner.call(spec.name, args ?? {}, "mcp");
        return { content: [{ type: "text" as const, text: out.text }], isError: !out.ok };
      },
    );
  }
  return server;
}

function sendJsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        fail(new SyntaxError("request body is not valid JSON"));
      }
    });
    req.on("error", fail);
  });
}

export async function startMcpServer(opts: McpServerOptions): Promise<McpServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const name = opts.name ?? "pcp-editor";
  const limit = opts.maxBodyBytes ?? 10 * 1024 * 1024;

  const http = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path !== "/mcp") return sendJsonRpcError(res, 404, -32000, "Not found: the MCP endpoint is /mcp");
      if (!isAllowedOrigin(req.headers.origin)) {
        return sendJsonRpcError(res, 403, -32000, "Forbidden: requests from non-local origins are refused");
      }
      if (req.method !== "POST") return sendJsonRpcError(res, 405, -32000, "Method not allowed (stateless server: POST only)");

      let body: unknown;
      try {
        body = await readBody(req, limit);
      } catch (e) {
        return sendJsonRpcError(res, e instanceof SyntaxError ? 400 : 413, -32700, (e as Error).message);
      }
      const server = buildServer(opts.runner, name);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        console.error("PCP MCP request failed:", e);
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      }
    })();
  });

  await new Promise<void>((done, fail) => {
    http.once("error", fail);
    http.listen(opts.port, host, () => {
      http.off("error", fail);
      done();
    });
  });
  const { port } = http.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${urlHost}:${port}/mcp`,
    close: () =>
      new Promise<void>((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  };
}
