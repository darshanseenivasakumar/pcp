// WorkspaceFs backed by VS Code: open editors are read and written through the document
// (so unsaved buffers are respected and the change is undoable); closed files go to disk.
// Path safety (no escapes, no .git / .env) comes from safeResolve.
import * as vscode from "vscode";

import type { WorkspaceFs } from "../core/hunks";
import { nodeWorkspaceFs, safeResolve } from "../core/hunks";

function openDoc(abs: string): vscode.TextDocument | undefined {
  const target = vscode.Uri.file(abs).fsPath.toLowerCase();
  return vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath.toLowerCase() === target);
}

export function vscodeWorkspaceFs(root: string): WorkspaceFs {
  const disk = nodeWorkspaceFs(root);
  return {
    async read(p) {
      const doc = openDoc(safeResolve(root, p));
      return doc ? doc.getText() : disk.read(p);
    },
    async write(p, content) {
      const abs = safeResolve(root, p);
      const doc = openDoc(abs);
      if (!doc) return disk.write(p, content);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), content);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code refused the edit to ${p}`);
      await doc.save();
    },
    remove: (p) => disk.remove(p),
  };
}
