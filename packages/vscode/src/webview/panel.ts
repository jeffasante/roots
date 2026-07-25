import * as vscode from "vscode";
import type { AskResult, Codemap, Confidence, Location, Trace } from "../engineClient.js";

/** Answers a follow-up question about the codemap. Wired from extension.ts. */
export type AskHandler = (codemap: Codemap, question: string) => Promise<AskResult>;

/** Webview panel that renders a codemap's mermaid diagram and trace summary. */
export class CodemapPanel {
  private static current: CodemapPanel | undefined;
  private static askHandler: AskHandler | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private codemap: Codemap | undefined;

  /** Provide the Q&A handler once during activation. */
  static configure(ask: AskHandler): void {
    CodemapPanel.askHandler = ask;
  }

  static show(codemap: Codemap): void {
    if (CodemapPanel.current) {
      CodemapPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      CodemapPanel.current.render(codemap);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "roots.codemap",
      "roots — Codemap",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    CodemapPanel.current = new CodemapPanel(panel);
    CodemapPanel.current.render(codemap);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    // Webview -> extension messages: jump to file, or ask a follow-up question.
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; repoRoot?: string; location?: Location; requestId?: number; question?: string }) => {
        if (msg?.type === "openLocation" && msg.repoRoot && msg.location) {
          void vscode.commands.executeCommand("roots.openLocation", msg.repoRoot, msg.location);
          return;
        }
        if (msg?.type === "ask" && typeof msg.question === "string" && typeof msg.requestId === "number") {
          void this.handleAsk(msg.requestId, msg.question);
        }
      },
      null,
      this.disposables
    );
  }

  /** Run a follow-up question and post the answer back into the chat thread. */
  private async handleAsk(requestId: number, question: string): Promise<void> {
    if (!this.codemap) return;
    const ask = CodemapPanel.askHandler;
    if (!ask) {
      void this.panel.webview.postMessage({
        type: "answer",
        requestId,
        error: "Chat is not available. Reload the window and try again.",
      });
      return;
    }
    try {
      const result = await ask(this.codemap, question);
      void this.panel.webview.postMessage({
        type: "answer",
        requestId,
        answer: result.answer,
        citations: result.citations,
        repoRoot: this.codemap.repo.root,
      });
    } catch (err) {
      void this.panel.webview.postMessage({
        type: "answer",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private render(codemap: Codemap): void {
    this.codemap = codemap;
    this.panel.title = `roots — ${codemap.query.slice(0, 40)}`;
    // Load code snippets (extension host can read files) then render.
    void loadSnippets(codemap).then((snippets) => {
      this.panel.webview.html = this.html(codemap, snippets);
    });
  }

  private html(codemap: Codemap, snippets: Map<string, string>): string {
    const nonce = String(Math.random()).slice(2);
    const diagram = codemap.diagram?.content ?? "flowchart TD\n  A[No diagram produced]";
    const traceList = renderTraceTree(codemap.traces, snippets);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src https://cdn.jsdelivr.net; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net;" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css" />
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
    padding: 0;
    margin: 0;
    line-height: 1.5;
  }
  .header {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--vscode-editor-background);
  }
  .header .title { min-width: 0; }
  h1 { font-size: 0.98rem; font-weight: 600; margin: 0; }
  .meta { color: var(--muted); font-size: 0.78rem; margin-top: 3px; }
  .actions { display: flex; gap: 4px; flex-shrink: 0; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.78rem;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
  }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
  .btn.active { border-color: var(--accent); color: var(--accent); }
  .content { padding: 16px 18px 40px; }

  /* Map (diagram) view */
  .mermaid {
    background: var(--vscode-editor-background);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    overflow: auto;
  }
  .diagram-error { color: var(--muted); font-size: 0.85rem; }
  [hidden] { display: none !important; }

  /* Overview */
  .overview { font-size: 0.85rem; line-height: 1.55; padding: 12px 14px; margin-bottom: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--vscode-textBlockQuote-background, transparent); }
  .overview .ref { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.72rem; color: var(--vscode-textLink-activeForeground, var(--accent)); background: color-mix(in srgb, var(--accent) 14%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); border-radius: 4px; padding: 0 4px; }
  .overview button.ref-link { cursor: pointer; }
  .overview button.ref-link:hover { background: color-mix(in srgb, var(--accent) 26%, transparent); border-color: var(--accent); }

  /* Ask (chat) */
  .chat { margin-top: 24px; border-top: 1px solid var(--border); padding-top: 16px; }
  .chat-title { font-size: 0.82rem; font-weight: 600; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
  .chat-thread { display: flex; flex-direction: column; gap: 10px; margin-bottom: 12px; }
  .chat-empty { color: var(--muted); font-size: 0.82rem; }
  .msg { font-size: 0.85rem; line-height: 1.55; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); }
  .msg.user { background: color-mix(in srgb, var(--accent) 8%, transparent); border-color: color-mix(in srgb, var(--accent) 28%, transparent); }
  .msg.assistant { background: var(--vscode-textBlockQuote-background, transparent); white-space: pre-wrap; }
  .msg.error { color: var(--vscode-errorForeground, #f14c4c); border-color: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 40%, transparent); }
  .msg .role { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 4px; }
  .msg .cites { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .msg .cite { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.72rem; color: var(--vscode-textLink-activeForeground, var(--accent)); background: color-mix(in srgb, var(--accent) 14%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); border-radius: 4px; padding: 1px 6px; cursor: pointer; }
  .msg .cite:hover { background: color-mix(in srgb, var(--accent) 26%, transparent); border-color: var(--accent); }
  .msg.thinking { color: var(--muted); font-style: italic; }
  .chat-form { display: flex; gap: 8px; align-items: flex-end; }
  .chat-input {
    flex: 1; resize: vertical; min-height: 38px; max-height: 160px;
    font-family: var(--vscode-font-family); font-size: 0.85rem; line-height: 1.4;
    padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--vscode-input-border, var(--border));
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  }
  .chat-input:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .chat-send {
    padding: 8px 14px; border-radius: 8px; border: 1px solid var(--accent);
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    cursor: pointer; font-size: 0.82rem;
  }
  .chat-send:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
  .chat-send:disabled { opacity: 0.5; cursor: default; }

  /* Trace tree */
  .tree { display: flex; flex-direction: column; gap: 2px; }
  .node { position: relative; }
  .node-row {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
  }
  .node-row[data-file] { cursor: pointer; }
  .node-row:hover, .node-row:focus-visible { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
  .node-row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .label {
    flex-shrink: 0;
    min-width: 26px;
    height: 22px;
    padding: 0 7px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 0.72rem; font-weight: 600;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border-radius: 6px;
  }
  .body { min-width: 0; flex: 1; }
  .node-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .node-title { font-weight: 600; font-size: 0.9rem; min-width: 0; }

  /* Right-aligned file:line tag on the title row (image-2 style). */
  .loc-tag {
    flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.72rem;
    color: var(--muted);
    background: none; border: none; padding: 0; cursor: pointer;
    white-space: nowrap;
  }
  .loc-tag:hover { color: var(--accent); text-decoration: underline; }

  /* Inline code snippet: the actual line under each step. */
  .code {
    margin: 6px 0 4px;
    padding: 6px 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.08));
    border: 1px solid var(--border);
    border-radius: 6px;
    overflow-x: auto;
    white-space: pre;
  }
  .code code { font-family: inherit; }

  /* Confidence badges — restrained, honest, softly bordered. */
  .conf {
    display: inline-flex; align-items: center;
    margin-left: 8px;
    font-size: 0.66rem; font-weight: 600; letter-spacing: 0.02em;
    text-transform: uppercase;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid transparent;
    vertical-align: middle;
  }
  .conf-verified {
    color: var(--vscode-charts-green, #3fb950);
    border-color: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 10%, transparent);
  }
  .conf-located {
    color: var(--muted);
    border-color: var(--border);
    background: transparent;
  }
  .conf-unverified {
    color: var(--vscode-charts-red, #f85149);
    border-color: color-mix(in srgb, var(--vscode-charts-red, #f85149) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-charts-red, #f85149) 8%, transparent);
  }
  .conf-grounded {
    margin-left: 6px;
    font-size: 0.68rem;
    color: var(--muted);
    vertical-align: middle;
  }
  .summary { color: var(--muted); font-size: 0.85rem; margin-top: 2px; }
  .summary.collapsed {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .toggle-guide {
    background: none; border: none; padding: 0; margin-top: 4px;
    color: var(--accent); font-size: 0.8rem; cursor: pointer;
  }
  .toggle-guide:hover { text-decoration: underline; }
  .locs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .loc {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.74rem;
    color: var(--muted);
    padding: 2px 7px;
    border: 1px solid var(--border);
    border-radius: 5px;
    cursor: pointer;
    background: transparent;
  }
  .loc:hover { color: var(--accent); border-color: var(--accent); }
  .children {
    margin-left: 19px;
    border-left: 1px solid var(--border);
    padding-left: 10px;
  }
  .children .node-row { padding-top: 6px; padding-bottom: 6px; }
  .katex { font-size: 1em; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">
      <h1>${escapeHtml(codemap.query)}</h1>
      <div class="meta">${escapeHtml(codemap.model.backend)} · ${escapeHtml(codemap.model.model_name)} · ${escapeHtml(
      codemap.model.mode
    )} · ${escapeHtml(codemap.created_at)}</div>
    </div>
    <div class="actions">
      <button class="btn active" id="view-text" title="List view">List</button>
      <button class="btn" id="view-map" title="Map view">Map</button>
    </div>
  </div>

  <div class="content">
    <div id="text-view">
      ${
        codemap.overview
          ? `<div class="overview">${renderOverviewRefs(codemap.overview, codemap.traces)}</div>`
          : ""
      }
      <div class="tree">${traceList}</div>

      <section class="chat" id="chat">
        <div class="chat-title">Ask a question</div>
        <div class="chat-thread" id="chat-thread">
          <div class="chat-empty" id="chat-empty">Ask a follow-up about this codemap — answers cite the exact files and lines.</div>
        </div>
        <form class="chat-form" id="chat-form">
          <textarea class="chat-input" id="chat-input" rows="1" placeholder="e.g. Where is the backend factory called?"></textarea>
          <button type="submit" class="chat-send" id="chat-send">Ask</button>
        </form>
      </section>
    </div>
    <div id="map-view" hidden>
      <div class="mermaid" id="diagram"></div>
    </div>
  </div>

  <script type="module" nonce="${nonce}">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";
    import renderMathInElement from "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.mjs";

    const vscodeApi = acquireVsCodeApi();
    const diagramSource = ${JSON.stringify(diagram)};
    const repoRoot = ${JSON.stringify(codemap.repo.root)};

    // Initialize mermaid up front so the first Map click can't race the setup.
    const isDark = document.body.classList.contains("vscode-dark") ||
      matchMedia("(prefers-color-scheme: dark)").matches;
    mermaid.initialize({ startOnLoad: false, theme: isDark ? "dark" : "default" });

    // View toggle (List <-> Map). Mermaid renders lazily on first Map open.
    const textView = document.getElementById("text-view");
    const mapView = document.getElementById("map-view");
    const btnText = document.getElementById("view-text");
    const btnMap = document.getElementById("view-map");
    let diagramRendered = false;

    function setView(map) {
      textView.hidden = map;
      mapView.hidden = !map;
      btnMap.classList.toggle("active", map);
      btnText.classList.toggle("active", !map);
      if (map && !diagramRendered) renderDiagram();
    }
    btnText.addEventListener("click", () => setView(false));
    btnMap.addEventListener("click", () => setView(true));

    async function renderDiagram() {
      diagramRendered = true;
      const el = document.getElementById("diagram");
      try {
        const { svg } = await mermaid.render("roots-graph", diagramSource);
        el.innerHTML = svg;
      } catch (err) {
        el.innerHTML = '<div class="diagram-error">Diagram could not be rendered: ' +
          String(err && err.message ? err.message : err) + '</div>';
      }
    }

    // Per-trace guide expand/collapse.
    for (const btn of document.querySelectorAll(".toggle-guide")) {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const summary = btn.previousElementSibling;
        const collapsed = summary.classList.toggle("collapsed");
        btn.textContent = collapsed ? "See more" : "See less";
      });
    }

    // Location badges, file:line tags, and overview refs all jump to the file.
    for (const el of document.querySelectorAll(".loc, .loc-tag, .ref-link")) {
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        vscodeApi.postMessage({
          type: "openLocation",
          repoRoot,
          location: {
            file: el.dataset.file,
            start_line: Number(el.dataset.start),
            end_line: Number(el.dataset.end),
          },
        });
      });
    }

    // The whole grounded trace box opens its primary code citation.
    for (const row of document.querySelectorAll(".node-row[data-file]")) {
      const open = () => vscodeApi.postMessage({
        type: "openLocation",
        repoRoot,
        location: {
          file: row.dataset.file,
          start_line: Number(row.dataset.start),
          end_line: Number(row.dataset.end),
        },
      });
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    }

    // ---- Ask a question (chat) ----
    const chatThread = document.getElementById("chat-thread");
    const chatEmpty = document.getElementById("chat-empty");
    const chatForm = document.getElementById("chat-form");
    const chatInput = document.getElementById("chat-input");
    const chatSend = document.getElementById("chat-send");
    let askSeq = 0;
    const pendingAsk = new Map();

    function escapeText(s) {
      return String(s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function baseNameOf(file) {
      const parts = String(file).split(/[\\\\/]/);
      return parts[parts.length - 1] || file;
    }

    function addMessage(cls, role, html) {
      if (chatEmpty) chatEmpty.remove();
      const el = document.createElement("div");
      el.className = "msg " + cls;
      el.innerHTML = '<div class="role">' + role + '</div>' + html;
      chatThread.appendChild(el);
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return el;
    }

    function wireCitations(container) {
      for (const chip of container.querySelectorAll(".cite")) {
        chip.addEventListener("click", () => {
          vscodeApi.postMessage({
            type: "openLocation",
            repoRoot,
            location: {
              file: chip.dataset.file,
              start_line: Number(chip.dataset.start),
              end_line: Number(chip.dataset.end),
            },
          });
        });
      }
    }

    function submitQuestion() {
      const question = (chatInput.value || "").trim();
      if (!question) return;
      addMessage("user", "You", escapeText(question));
      chatInput.value = "";
      const thinking = addMessage("assistant thinking", "roots", "Thinking…");
      const requestId = ++askSeq;
      pendingAsk.set(requestId, thinking);
      chatSend.disabled = true;
      vscodeApi.postMessage({ type: "ask", requestId, question });
    }

    if (chatForm) {
      chatForm.addEventListener("submit", (event) => {
        event.preventDefault();
        submitQuestion();
      });
    }
    if (chatInput) {
      chatInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          submitQuestion();
        }
      });
    }

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.type !== "answer") return;
      const target = pendingAsk.get(msg.requestId);
      if (!target) return;
      pendingAsk.delete(msg.requestId);
      if (pendingAsk.size === 0) chatSend.disabled = false;
      if (msg.error) {
        target.className = "msg error";
        target.innerHTML = '<div class="role">roots</div>' + escapeText(msg.error);
        return;
      }
      let html = '<div class="role">roots</div>' + escapeText(msg.answer || "");
      if (Array.isArray(msg.citations) && msg.citations.length) {
        const chips = msg.citations.map((c) =>
          '<span class="cite" data-file="' + escapeText(c.file) + '" data-start="' + c.start_line +
          '" data-end="' + c.end_line + '">' + escapeText(baseNameOf(c.file)) + ':' + c.start_line + '</span>'
        ).join("");
        html += '<div class="cites">' + chips + '</div>';
      }
      target.className = "msg assistant";
      target.innerHTML = html;
      wireCitations(target);
    });

    // Render LaTeX ($...$ inline, $$...$$ block) across the whole document.
    renderMathInElement(document.body, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$", right: "$", display: false },
        { left: "\\\\(", right: "\\\\)", display: false },
        { left: "\\\\[", right: "\\\\]", display: true },
      ],
      throwOnError: false,
    });
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    CodemapPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

/**
 * Read a one-line code snippet for each trace from its first location, so the
 * List view can show the actual code under each step (image-2 style). Best
 * effort: unreadable files just yield no snippet. Runs in the extension host,
 * which has file-system access the webview lacks.
 */
async function loadSnippets(codemap: Codemap): Promise<Map<string, string>> {
  const root = codemap.repo.root;
  const snippets = new Map<string, string>();
  const path = require("node:path") as typeof import("node:path");

  await Promise.all(
    codemap.traces.map(async (trace) => {
      const loc = trace.locations[0];
      if (!loc) return;
      try {
        const uri = vscode.Uri.file(path.resolve(root, loc.file));
        const bytes = await vscode.workspace.fs.readFile(uri);
        const lines = Buffer.from(bytes).toString("utf8").split(/\r?\n/);
        const idx = Math.max(0, loc.start_line - 1);
        const raw = (lines[idx] ?? "").trim();
        if (raw) snippets.set(trace.id, raw.length > 120 ? raw.slice(0, 117) + "…" : raw);
      } catch {
        // Unreadable (deleted/moved file): skip the snippet, keep the step.
      }
    })
  );
  return snippets;
}

/**
 * Renders traces as a nested, numbered tree (1, 1a, 1b, 2, ...) following the
 * `children` links. Root traces are ones never referenced as a child.
 */
function renderTraceTree(traces: Trace[], snippets: Map<string, string>): string {
  const byId = new Map(traces.map((t) => [t.id, t]));
  const childIds = new Set<string>();
  for (const t of traces) for (const c of t.children ?? []) childIds.add(c);
  const roots = traces.filter((t) => !childIds.has(t.id));

  const seen = new Set<string>();
  const render = (trace: Trace, label: string): string => {
    if (seen.has(trace.id)) return "";
    seen.add(trace.id);

    const kids = (trace.children ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is Trace => Boolean(t));
    const childHtml = kids
      .map((k, i) => render(k, `${label}${String.fromCharCode(97 + i)}`))
      .join("");

    // Primary location gets a right-aligned file:line tag on the title row
    // (image-2 style); any additional locations render as badges below.
    const primary = trace.locations[0];
    const primaryTag = primary
      ? `<button class="loc-tag" data-file="${escapeHtml(primary.file)}" data-start="${primary.start_line}" data-end="${primary.end_line}" title="${escapeHtml(
          primary.file
        )}:${primary.start_line}-${primary.end_line}">${escapeHtml(baseName(primary.file))}:${primary.start_line}</button>`
      : "";

    // Inline code snippet from the first location (the actual line of code).
    const snippet = snippets.get(trace.id);
    const codeHtml = snippet
      ? `<pre class="code"><code>${escapeHtml(snippet)}</code></pre>`
      : "";

    const extraLocs = trace.locations.slice(1);
    const locs = extraLocs
      .map(
        (l) =>
          `<button class="loc" data-file="${escapeHtml(l.file)}" data-start="${l.start_line}" data-end="${l.end_line}">${escapeHtml(
            l.file
          )}:${l.start_line}-${l.end_line}</button>`
      )
      .join("");

    const guideParts = [
      trace.motivation ? `Motivation\n${trace.motivation}` : "",
      trace.details ? `Details\n${trace.details}` : "",
    ].filter(Boolean);
    const guide = guideParts.join("\n\n");
    const displayedSummary = guide ? `${trace.summary}\n\n${guide}` : trace.summary;
    // Long summaries and generated guides get a "See more" toggle.
    const longSummary = displayedSummary.length > 160;
    const summaryClass = longSummary ? "summary collapsed" : "summary";
    const toggle = longSummary
      ? `<button class="toggle-guide">See more</button>`
      : "";

    const rowLocation = primary
      ? ` data-file="${escapeHtml(primary.file)}" data-start="${primary.start_line}" data-end="${primary.end_line}" role="button" tabindex="0" title="Open ${escapeHtml(primary.file)}:${primary.start_line}"`
      : "";

    return `<div class="node">
      <div class="node-row"${rowLocation}>
        <span class="label">${label}</span>
        <div class="body">
          <div class="node-head">
            <span class="node-title">${escapeHtml(trace.title)}${confidenceBadge(trace.confidence)}</span>
            ${primaryTag}
          </div>
          ${codeHtml}
          <div class="${summaryClass}" style="white-space:pre-line">${escapeHtml(displayedSummary)}</div>
          ${toggle}
          ${locs ? `<div class="locs">${locs}</div>` : ""}
        </div>
      </div>
      ${childHtml ? `<div class="children">${childHtml}</div>` : ""}
    </div>`;
  };

  return roots.map((t, i) => render(t, String(i + 1))).join("");
}

/**
 * Honest, restrained badge for a trace's confidence. Three states, mapped
 * straight off the Confidence signal — no invented certainty:
 *   verified  — location resolves AND a symbol was matched at the cited line.
 *   located   — location resolves by file+line only (weaker evidence).
 *   unverified — no location survived verification.
 * When a grounding score is present it's shown as a subtle suffix.
 */
function confidenceBadge(c?: Confidence): string {
  if (!c) return "";
  let cls: string;
  let text: string;
  let title: string;
  if (!c.location_verified) {
    cls = "conf conf-unverified";
    text = "unverified";
    title = "No cited location survived verification.";
  } else if (c.location_evidence === "symbol") {
    cls = "conf conf-verified";
    text = "verified";
    title = "Location resolves and a named symbol was matched at the cited lines.";
  } else {
    cls = "conf conf-located";
    text = "located";
    title = "File and line range exist, but no symbol was matched.";
  }

  let grounded = "";
  if (typeof c.summary_grounded === "number") {
    const pct = Math.round(c.summary_grounded * 100);
    grounded = ` <span class="conf-grounded" title="How well a second read of the code supports the summary.">${pct}% grounded</span>`;
  }

  return ` <span class="${cls}" title="${escapeHtml(title)}">${text}</span>${grounded}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render overview text, turning [tN] references into clickable chips that jump
 * to the referenced trace's primary file:line. Refs without a real location
 * (or unknown ids) stay as plain, non-clickable chips.
 */
function renderOverviewRefs(text: string, traces: Trace[]): string {
  const byId = new Map(traces.map((t) => [t.id, t]));
  return escapeHtml(text).replace(/\[([^\]]+)\]/g, (_match, id: string) => {
    const loc = byId.get(id)?.locations?.[0];
    if (!loc) return `<span class="ref">${escapeHtml(id)}</span>`;
    return `<button class="ref ref-link" data-file="${escapeHtml(loc.file)}" data-start="${loc.start_line}" data-end="${loc.end_line}" title="Open ${escapeHtml(baseName(loc.file))}:${loc.start_line}">${escapeHtml(id)}</button>`;
  });
}

/** Last path segment, for the compact right-aligned file:line tag. */
function baseName(file: string): string {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1] || file;
}
