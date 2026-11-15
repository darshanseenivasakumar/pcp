import * as vscode from "vscode";

import { VerifierClient } from "./api/client";

function client(): VerifierClient {
  const cfg = vscode.workspace.getConfiguration("pcp");
  return new VerifierClient({
    baseUrl: cfg.get<string>("verifierUrl", "http://127.0.0.1:8765"),
    timeoutMs: cfg.get<number>("requestTimeoutMs", 15000),
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "pcp.checkHealth";
  context.subscriptions.push(status);

  const refresh = async (announce: boolean) => {
    try {
      const h = await client().health();
      status.text = "$(shield) PCP";
      status.tooltip = `Verifier ok (v${h.version}, sandbox ${h.sandbox})`;
      if (announce) void vscode.window.showInformationMessage(`PCP verifier is up: v${h.version}, sandbox ${h.sandbox}.`);
    } catch (err) {
      status.text = "$(warning) PCP offline";
      status.tooltip = (err as Error).message;
      if (announce) void vscode.window.showErrorMessage((err as Error).message);
    }
    status.show();
  };

  context.subscriptions.push(vscode.commands.registerCommand("pcp.checkHealth", () => refresh(true)));
  void refresh(false);
}

export function deactivate(): void {}
