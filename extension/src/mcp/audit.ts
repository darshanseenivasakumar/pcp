// Audit log: one entry per tool call (name, tier, args summary, who approved it, outcome, time).
// Kept in memory for the audit view and optionally appended to a JSONL file.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { Tier } from "./tiers";

export type AuditOutcome = "ok" | "error" | "denied";
export type AuditSource = "mcp" | "agent" | "panel";

export interface AuditEntry {
  id: string;
  /** ISO-8601 */
  time: string;
  tool: string;
  tier: Tier;
  /** Argument summary, at most 160 characters, secrets masked. */
  args: string;
  approvedBy: string;
  outcome: AuditOutcome;
  durationMs: number;
  source: AuditSource;
  detail?: string;
}

export type AuditListener = (entry: AuditEntry) => void;

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\b(AKIA|ASIA)[0-9A-Z]{12,}/g,
  /\bxox[abpr]-[A-Za-z0-9-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];
const SECRET_ASSIGN = /\b(password|passwd|secret|token|api_key|apikey)(["']?\s*[:=]\s*)(["']?)[^\s"',}]{3,}/gi;

/** Replaces anything that looks like a credential with a masked stub ("ghp_****"). */
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRETS) {
    out = out.replace(re, (m) => {
      if (m.startsWith("-----BEGIN")) return "-----BEGIN PRIVATE KEY-----****";
      const cut = m.search(/[_-]|\s/);
      return `${cut > 0 && cut <= 10 ? m.slice(0, cut + 1) : m.slice(0, 4)}****`;
    });
  }
  return out.replace(SECRET_ASSIGN, (_m, k: string, sep: string, q: string) => `${k}${sep}${q}****`);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Short, masked, single-line summary of tool arguments (long strings are elided first). */
export function summarizeArgs(args: unknown, max = 160): string {
  let text: string;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const parts = Object.entries(args as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        const s = typeof v === "string" ? maskSecrets(v) : maskSecrets(JSON.stringify(v) ?? "");
        const flat = s.replace(/\s+/g, " ");
        const shown = flat.length > 60 ? `${flat.slice(0, 57)}… (${s.length} chars)` : flat;
        return `${k}=${typeof v === "string" ? JSON.stringify(shown) : shown}`;
      });
    text = parts.join(" ");
  } else {
    text = maskSecrets(JSON.stringify(args) ?? String(args)).replace(/\s+/g, " ");
  }
  return clip(text, max);
}

export class AuditLog {
  private readonly items: AuditEntry[] = [];
  private readonly listeners = new Set<AuditListener>();
  private readonly jsonlPath?: string;
  private readonly max: number;
  private warned = false;

  constructor(opts: { jsonlPath?: string; max?: number } = {}) {
    this.jsonlPath = opts.jsonlPath;
    this.max = opts.max ?? 1000;
  }

  append(e: Omit<AuditEntry, "id" | "time">): AuditEntry {
    const entry: AuditEntry = {
      id: randomUUID(),
      time: new Date().toISOString(),
      ...e,
      args: clip(maskSecrets(e.args).replace(/\s+/g, " "), 160),
      ...(e.detail === undefined ? {} : { detail: clip(maskSecrets(e.detail), 500) }),
    };
    this.items.push(entry);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    if (this.jsonlPath) this.persist(this.jsonlPath, entry);
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch (err) {
        console.error("PCP audit listener failed:", err);
      }
    }
    return entry;
  }

  /** Newest last. A copy: callers cannot rewrite history. */
  entries(): AuditEntry[] {
    return this.items.map((e) => ({ ...e }));
  }

  onChange(listener: AuditListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private persist(path: string, entry: AuditEntry): void {
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (err) {
      if (!this.warned) console.warn(`PCP audit log could not write ${path}:`, err);
      this.warned = true;
    }
  }
}
