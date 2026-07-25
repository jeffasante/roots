import * as vscode from "vscode";
import type { BackendOption } from "../engineClient.js";

/**
 * A read-only catalog of the inference backends roots can use. Answers the
 * "what models can we add?" question: each backend is a click-to-expand card
 * showing its mode (cloud/local), default model, key requirement, and base URL.
 * Purely informational — generation still happens through the picker in
 * `roots.generateCodemap`.
 */
export class BackendsPanel {
  private static current: BackendsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private backends: BackendOption[] = [];

  static show(backends: BackendOption[]): void {
    if (BackendsPanel.current) {
      BackendsPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      BackendsPanel.current.render(backends);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "roots.backends",
      "roots — Models",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    BackendsPanel.current = new BackendsPanel(panel);
    BackendsPanel.current.render(backends);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; idx?: number }) => {
        if (msg?.type === "generate") {
          void vscode.commands.executeCommand("roots.generateCodemap");
        } else if (msg?.type === "selectModel") {
          void vscode.commands.executeCommand("roots.selectModel");
        } else if (msg?.type === "useBackend" && typeof msg.idx === "number") {
          const option = this.backends[msg.idx];
          if (option) void vscode.commands.executeCommand("roots.useBackend", option);
        }
      },
      null,
      this.disposables
    );
  }

  private render(backends: BackendOption[]): void {
    this.backends = backends;
    this.panel.webview.html = this.html(backends);
  }

  private html(backends: BackendOption[]): string {
    const nonce = String(Math.random()).slice(2);
    const cards = backends.map((b, i) => backendCard(b, i)).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    --border: var(--vscode-widget-border, rgba(128,128,128,0.25));
    --muted: color-mix(in srgb, var(--vscode-foreground) 60%, transparent);
    --accent: var(--vscode-textLink-foreground);
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    margin: 0; padding: 0; line-height: 1.5;
  }
  .header {
    padding: 10px 16px; border-bottom: 1px solid var(--border);
    background: var(--vscode-editor-background);
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  h1 { font-size: 0.9rem; font-weight: 600; margin: 0; }
  .meta { color: var(--muted); font-size: 0.75rem; margin-top: 2px; }
  .content { max-width: 640px; margin: 0 auto; padding: 12px 16px 32px; display: flex; flex-direction: column; gap: 4px; }
  .card { border: 1px solid var(--border); border-radius: 7px; overflow: hidden; }
  .card + .card { margin-top: 0; }
  .card-head {
    display: flex; align-items: center; gap: 8px;
    padding: 7px 12px; cursor: pointer; user-select: none;
  }
  .card-head:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.05)); }
  .chev { color: var(--muted); font-size: 0.7rem; transition: transform 0.15s; width: 10px; text-align: center; }
  .card.open .chev { transform: rotate(90deg); }
  .name { font-weight: 600; font-size: 0.85rem; flex: 1; min-width: 0; }
  .tag {
    font-size: 0.62rem; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--muted);
  }
  .desc { color: var(--muted); font-size: 0.77rem; }
  .card-body { display: none; padding: 0 12px 10px 30px; }
  .card.open .card-body { display: block; }
  .row { display: flex; gap: 8px; font-size: 0.78rem; padding: 2px 0; }
  .row .k { color: var(--muted); min-width: 92px; }
  .row .v { font-family: var(--vscode-editor-font-family, monospace); }
  .btn {
    display: inline-flex; align-items: center; gap: 6px; font-size: 0.78rem;
    padding: 4px 11px; border: 1px solid var(--border); border-radius: 6px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer;
  }
  .btn:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); border-color: color-mix(in srgb, var(--vscode-foreground) 30%, transparent); }
</style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Models roots can use</h1>
      <div class="meta">Bring your own key for cloud backends, or run a local one. Click a backend to view details.</div>
    </div>
    <button class="btn" id="generate">Generate codemap</button>
  </div>
  <div class="content">${cards}</div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();
    for (const head of document.querySelectorAll(".card-head")) {
      head.addEventListener("click", () => head.parentElement.classList.toggle("open"));
    }
    document.getElementById("generate").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "generate" });
    });
    for (const btn of document.querySelectorAll(".use-btn")) {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        vscodeApi.postMessage({ type: "useBackend", idx: Number(btn.dataset.idx) });
      });
    }
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    BackendsPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function backendCard(b: BackendOption, i: number): string {
  const open = i === 0 ? " open" : "";
  const rows = [
    ["Default model", b.defaultModel],
    ["API key", b.requiresApiKey ? "required" : "not required"],
    b.baseUrl ? ["Base URL", b.baseUrl] : null,
  ].filter(Boolean) as [string, string][];

  const body = rows
    .map((r) => `<div class="row"><span class="k">${escapeHtml(r[0])}</span><span class="v">${escapeHtml(r[1])}</span></div>`)
    .join("");

  return `<div class="card${open}">
    <div class="card-head">
      <span class="chev">▸</span>
      <span class="name">${escapeHtml(b.label)}</span>
      <span class="tag">${escapeHtml(b.mode)}</span>
    </div>
    <div class="card-body">
      <div class="desc" style="margin-bottom:6px;">${escapeHtml(b.description)}</div>
      ${body}
      <button class="btn use-btn" data-idx="${i}" style="margin-top:10px;">Use this backend</button>
    </div>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
