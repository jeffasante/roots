import * as vscode from "vscode";
import type { BackendOption } from "../engineClient.js";

/** A single selectable model row, flattened from the backend catalog. */
export interface ModelChoice {
  /** Backend kind (anthropic | openai | ollama | cellm). */
  kind: BackendOption["kind"];
  /** Base URL for the backend, if any. */
  baseUrl?: string;
  /** The model id sent to the API. */
  model: string;
  /** Whether this backend needs an API key. */
  requiresApiKey: boolean;
  /** Whether this is the bare "Custom OpenAI-compatible" option (needs a URL prompt). */
  customEndpoint?: boolean;
}

/** Identifies the currently-active selection so the picker can mark it. */
export interface CurrentSelection {
  kind: string;
  model: string;
  baseUrl: string;
}

/**
 * A single searchable modal for choosing an inference model (image-2 style):
 * every provider's models are listed together in one grouped, filterable
 * table. Picking a row resolves the backend + model in one action instead of
 * the old two-step quick-pick. Selection is handed back to the caller via the
 * promise returned from {@link ModelPickerPanel.pick}.
 */
export class ModelPickerPanel {
  private static current: ModelPickerPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private resolve?: (choice: ModelChoice | undefined) => void;
  private settled = false;

  /**
   * Open the picker and resolve with the chosen model (or undefined if the
   * user closed it without choosing).
   */
  static pick(backends: BackendOption[], current: CurrentSelection): Promise<ModelChoice | undefined> {
    if (ModelPickerPanel.current) {
      ModelPickerPanel.current.panel.reveal(vscode.ViewColumn.Active);
      ModelPickerPanel.current.render(backends, current);
      return ModelPickerPanel.current.awaitChoice();
    }
    const panel = vscode.window.createWebviewPanel(
      "roots.modelPicker",
      "roots — Choose a model",
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ModelPickerPanel.current = new ModelPickerPanel(panel);
    ModelPickerPanel.current.render(backends, current);
    return ModelPickerPanel.current.awaitChoice();
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => {
      this.settle(undefined);
      ModelPickerPanel.current = undefined;
      for (const d of this.disposables) d.dispose();
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; choice?: ModelChoice }) => {
        if (msg?.type === "select" && msg.choice) {
          this.settle(msg.choice);
        } else if (msg?.type === "cancel") {
          this.settle(undefined);
        }
      },
      null,
      this.disposables
    );
  }

  private awaitChoice(): Promise<ModelChoice | undefined> {
    this.settled = false;
    return new Promise<ModelChoice | undefined>((res) => {
      this.resolve = res;
    });
  }

  private settle(choice: ModelChoice | undefined): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve?.(choice);
    this.resolve = undefined;
    // Close the modal once a choice is made or it's cancelled.
    this.panel.dispose();
  }

  private render(backends: BackendOption[], current: CurrentSelection): void {
    this.panel.webview.html = this.html(backends, current);
  }

  private html(backends: BackendOption[], current: CurrentSelection): string {
    const nonce = String(Math.random()).slice(2);
    const groups = backends.map((b) => backendGroup(b, current)).join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root {
    --border: var(--vscode-widget-border, rgba(128,128,128,0.25));
    --muted: color-mix(in srgb, var(--vscode-foreground) 55%, transparent);
    --accent: var(--vscode-textLink-foreground);
    --row-hover: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08));
    --row-active: var(--vscode-list-activeSelectionBackground, rgba(80,120,255,0.18));
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 0; line-height: 1.4; font-size: 13px;
  }
  .wrap { max-width: 860px; margin: 0 auto; padding: 16px 18px 40px; }
  h1 { font-size: 0.95rem; font-weight: 600; margin: 0 0 2px; }
  .sub { color: var(--muted); font-size: 0.78rem; margin-bottom: 14px; }
  .search {
    width: 100%; padding: 8px 11px; margin-bottom: 14px;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    font-size: 0.82rem; outline: none;
  }
  .search:focus { border-color: var(--accent); }
  .group { margin-bottom: 6px; }
  .group-head {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 4px 5px; font-size: 0.72rem; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted);
    border-bottom: 1px solid var(--border);
  }
  .group-head .key { font-size: 0.62rem; font-weight: 500; text-transform: none; letter-spacing: 0; }
  .row {
    display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px;
    padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent;
  }
  .row:hover { background: var(--row-hover); }
  .row.active { background: var(--row-active); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  .row .left { min-width: 0; }
  .row .name { font-weight: 600; font-size: 0.84rem; display: flex; align-items: center; gap: 7px; }
  .row .name .check { color: var(--accent); font-size: 0.75rem; }
  .row .id { color: var(--muted); font-size: 0.72rem; font-family: var(--vscode-editor-font-family, monospace); margin-top: 1px; }
  .row .note { color: var(--muted); font-size: 0.75rem; margin-top: 1px; }
  .row .right { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  .pill {
    font-size: 0.62rem; font-weight: 500; letter-spacing: 0.03em; text-transform: uppercase;
    color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px;
  }
  .pill.key { color: var(--vscode-editorWarning-foreground, #d19a66); border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #d19a66) 40%, transparent); }
  .empty { color: var(--muted); font-size: 0.8rem; padding: 20px 4px; text-align: center; display: none; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Choose a model</h1>
    <div class="sub">Bring your own key for cloud providers, or run a local model. Pick a row to make it the default for the next codemap.</div>
    <input class="search" id="search" type="text" placeholder="Search models or providers…" autofocus />
    <div id="list">${groups}</div>
    <div class="empty" id="empty">No models match your search.</div>
  </div>

  <script nonce="${nonce}">
    const vscodeApi = acquireVsCodeApi();

    function choose(el) {
      vscodeApi.postMessage({
        type: "select",
        choice: {
          kind: el.dataset.kind,
          baseUrl: el.dataset.baseurl || undefined,
          model: el.dataset.model,
          requiresApiKey: el.dataset.key === "1",
          customEndpoint: el.dataset.custom === "1",
        },
      });
    }

    const rows = Array.from(document.querySelectorAll(".row"));
    for (const row of rows) {
      row.addEventListener("click", () => choose(row));
    }

    const search = document.getElementById("search");
    const empty = document.getElementById("empty");
    function applyFilter() {
      const q = search.value.trim().toLowerCase();
      let any = false;
      for (const group of document.querySelectorAll(".group")) {
        let groupVisible = false;
        for (const row of group.querySelectorAll(".row")) {
          const hay = row.dataset.search || "";
          const show = q === "" || hay.includes(q);
          row.style.display = show ? "" : "none";
          if (show) { groupVisible = true; any = true; }
        }
        group.style.display = groupVisible ? "" : "none";
      }
      empty.style.display = any ? "none" : "block";
    }
    search.addEventListener("input", applyFilter);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") vscodeApi.postMessage({ type: "cancel" });
      if (e.key === "Enter") {
        const first = rows.find((r) => r.style.display !== "none");
        if (first) choose(first);
      }
    });
    search.focus();
  </script>
</body>
</html>`;
  }

}

/** Render one provider group with its models (or a single default-model row). */
function backendGroup(b: BackendOption, current: CurrentSelection): string {
  const isActiveBackend = b.kind === current.kind && (b.baseUrl ?? "") === current.baseUrl;
  const keyPill = b.requiresApiKey ? `<span class="pill key">API key</span>` : "";
  const modePill = `<span class="pill">${escapeHtml(b.mode)}</span>`;

  const models =
    b.models?.length
      ? b.models.map((m) => ({ id: m.id, label: m.label, note: m.note ?? "" }))
      : [{ id: b.defaultModel, label: b.customEndpoint ? "Custom model id" : b.defaultModel, note: b.description }];

  const rows = models
    .map((m) => {
      const active = isActiveBackend && m.id === current.model;
      const search = `${b.label} ${m.label} ${m.id} ${m.note} ${b.mode}`.toLowerCase();
      return `<div class="row${active ? " active" : ""}"
        data-kind="${escapeHtml(b.kind)}"
        data-baseurl="${escapeHtml(b.baseUrl ?? "")}"
        data-model="${escapeHtml(m.id)}"
        data-key="${b.requiresApiKey ? "1" : "0"}"
        data-custom="${b.customEndpoint ? "1" : "0"}"
        data-search="${escapeHtml(search)}">
        <div class="left">
          <div class="name">${active ? '<span class="check">✓</span>' : ""}${escapeHtml(m.label)}</div>
          ${b.customEndpoint ? "" : `<div class="id">${escapeHtml(m.id)}</div>`}
          ${m.note ? `<div class="note">${escapeHtml(m.note)}</div>` : ""}
        </div>
        <div class="right">${keyPill}${modePill}</div>
      </div>`;
    })
    .join("");

  return `<div class="group">
    <div class="group-head"><span>${escapeHtml(b.label)}</span><span class="key">${escapeHtml(b.description)}</span></div>
    ${rows}
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
