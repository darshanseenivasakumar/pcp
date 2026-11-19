import { describe, expect, it } from "vitest";

import { SseParser } from "../src/api/sse";

describe("SseParser", () => {
  it("parses messages split across arbitrary chunks", () => {
    const p = new SseParser();
    const text = 'id: 0\ndata: {"a":1}\n\nid: 1\nevent: pcp\ndata: {"b":\ndata: 2}\n\n';
    const out = [];
    for (const ch of text) out.push(...p.feed(ch));
    expect(out).toEqual([
      { event: "message", data: '{"a":1}', id: "0" },
      { event: "pcp", data: '{"b":\n2}', id: "1" },
    ]);
    expect(p.lastEventId).toBe("1");
  });

  it("handles CRLF and lone CR line endings, comments and retry", () => {
    const p = new SseParser();
    const out = p.feed(": keep-alive\r\nretry: 1500\r\ndata: x\r\n\r\ndata: y\r\r");
    // the final lone \r may be half of a \r\n, so "y" waits for the next byte
    expect(out.map((m) => m.data)).toEqual(["x"]);
    expect(p.feed("data: z\n\n").map((m) => m.data)).toEqual(["y", "z"]);
    expect(p.retryMs).toBe(1500);
  });

  it("does not split a CRLF that arrives in two chunks", () => {
    const p = new SseParser();
    expect(p.feed("data: x\r")).toEqual([]);
    expect(p.feed("\n\r\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("ignores events with no data and drops partial messages on reset", () => {
    const p = new SseParser();
    expect(p.feed("event: ping\n\n")).toEqual([]);
    p.feed("id: 7\n\ndata: half");
    p.resetPartial();
    expect(p.feed("data: whole\n\n")).toEqual([{ event: "message", data: "whole", id: "7" }]);
  });
});
