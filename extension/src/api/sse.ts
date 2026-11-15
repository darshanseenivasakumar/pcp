// Minimal, spec-following Server-Sent Events parser (WHATWG "event stream interpretation").
// Fed text chunks of any size; returns complete messages as they finish.

export interface SseMessage {
  event: string; // "message" when the server sends no `event:` field
  data: string;
  id?: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  /** Last id seen on the stream, for the Last-Event-ID header on reconnect. */
  lastEventId: string | undefined;
  /** Server-requested reconnection delay (`retry:` field), if any. */
  retryMs: number | undefined;

  /** Drop a half-received message after a dropped connection. Keeps lastEventId and retryMs. */
  resetPartial(): void {
    this.buffer = "";
    this.data = [];
    this.event = "";
  }

  feed(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    // Lines end in \r\n, \n or \r. Keep a trailing lone \r in the buffer: it may be half of \r\n.
    for (;;) {
      const m = /\r\n|\n|\r(?!$)/.exec(this.buffer);
      if (!m) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryMs = Number(value);
        break;
    }
    return undefined;
  }

  private dispatch(): SseMessage | undefined {
    if (this.id !== undefined) this.lastEventId = this.id;
    if (this.data.length === 0) {
      this.event = "";
      return undefined;
    }
    const msg: SseMessage = { event: this.event || "message", data: this.data.join("\n") };
    if (this.id !== undefined) msg.id = this.id;
    this.data = [];
    this.event = "";
    return msg;
  }
}
