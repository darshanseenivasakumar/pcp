// Shared webview shell: strict CSP with a nonce, VS Code theme colours, and a tiny DOM helper.
// Webviews never call the verifier themselves (the server rejects browser origins); they post
// messages to the extension host, which owns every HTTP call and every disk write.
import { randomBytes } from "node:crypto";
import type * as vscode from "vscode";

export function nonce(): string {
  return randomBytes(16).toString("base64");
}

export const BASE_CSS = `
:root { --green:#2ea043; --yellow:#d29922; --amber:#db6d28; --red:#da3633; --muted:var(--vscode-descriptionForeground); }
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  background: var(--vscode-editor-background); padding: 12px 16px 40px; line-height: 1.45; }
h1 { font-size: 1.25em; margin: 0 0 4px; } h2 { font-size: 1.05em; margin: 18px 0 8px; }
.muted { color: var(--muted); } .small { font-size: .9em; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.card { border: 1px solid var(--vscode-panel-border, #8884); border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 3px;
  padding: 4px 12px; cursor: pointer; font: inherit; }
button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
button.danger { background: var(--red); color: #fff; }
button:disabled { opacity: .45; cursor: default; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: .85em; font-weight: 600; border: 1px solid currentColor; }
.green { color: var(--green); } .yellow { color: var(--yellow); } .amber { color: var(--amber); } .red { color: var(--red); }
.bg-green { background: var(--green); } .bg-yellow { background: var(--yellow); } .bg-amber { background: var(--amber); } .bg-red { background: var(--red); }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #8883); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
code, pre { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
pre { margin: 0; overflow-x: auto; }
`;

/** DOM helper available to every webview script (textContent only: model output is never parsed as HTML). */
export const DOM_HELPERS = `
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
function md(text) { // **bold**, \`code\`, "- " bullets; everything else is plain text
  const out = h('div', {});
  let list = null;
  for (const line of String(text || '').split('\\n')) {
    const bullet = /^\\s*[-*] (.*)$/.exec(line);
    const target = bullet ? (list ||= out.appendChild(h('ul', {}))) : (list = null, out.appendChild(h('div', {})));
    const node = bullet ? target.appendChild(h('li', {})) : target;
    const src = bullet ? bullet[1] : line;
    for (const part of src.split(/(\\*\\*[^*]+\\*\\*|\`[^\`]+\`)/)) {
      if (!part) continue;
      if (part.startsWith('**')) node.append(h('strong', {}, part.slice(2, -2)));
      else if (part.startsWith('\`')) node.append(h('code', {}, part.slice(1, -1)));
      else node.append(part);
    }
  }
  return out;
}
const vscode = acquireVsCodeApi();
`;

export function page(webview: vscode.Webview, title: string, css: string, script: string): string {
  const n = nonce();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>${BASE_CSS}${css}</style></head><body><div id="app"></div>
<script nonce="${n}">${DOM_HELPERS}${script}</script></body></html>`;
}
