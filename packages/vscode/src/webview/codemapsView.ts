import * as vscode from "vscode";
import type { AskResult, BackendOption, Codemap, CodemapSuggestion, ProgressEvent, Trace } from "../engineClient.js";

interface CodemapsViewHandlers {
  generate(query: string): Promise<void>;
  open(codemap: Codemap): void;
  quiz(codemap: Codemap): void;
  delete(codemap: Codemap): Promise<void>;
  selectModel(): Promise<void>;
  refresh(): Promise<void>;
  suggest(): Promise<void>;
  /** Reveal a specific location in the editor from the in-sidebar detail view. */
  reveal(repoRoot: string, location: { file: string; start_line: number; end_line: number }): void;
  /** Answer a follow-up question about the codemap, grounded in real files. */
  ask(codemap: Codemap, question: string): Promise<AskResult>;
}

/** The prompt-first roots workflow hosted directly in the activity-bar sidebar. */
export class CodemapsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "roots.codemaps";

  private view: vscode.WebviewView | undefined;
  private codemaps: Codemap[] = [];
  private backends: BackendOption[] = [];
  private progress: ProgressEvent | undefined;
  private generatingQuery = "";
  private suggestions: CodemapSuggestion[] = [];
  private suggestionsLoading = false;
  private suggestionsError = "";
  /** When set, the sidebar shows this codemap's traces inline (Windsurf-style). */
  private detail: Codemap | undefined;
  private detailSnippets = new Map<string, string>();

  constructor(private readonly handlers: CodemapsViewHandlers) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage(
      (message: {
        type?: string;
        query?: string;
        id?: string;
        location?: { file: string; start_line: number; end_line: number };
        requestId?: number;
        question?: string;
      }) => {
        const codemap = this.codemaps.find((item) => item.id === message.id);
        if (message.type === "ask" && this.detail && typeof message.requestId === "number" && message.question) {
          void this.handleAsk(this.detail, message.requestId, message.question);
          return;
        }
        if (message.type === "generate" && message.query?.trim()) {
          void this.handlers.generate(message.query.trim());
        } else if (message.type === "open" && codemap) {
          // Clicking a card opens the codemap's detail inline in the sidebar.
          this.detail = codemap;
          this.detailSnippets.clear();
          this.render();
        } else if (message.type === "openEditor" && codemap) {
          // The explicit "open editor" button opens the full panel tab.
          this.handlers.open(codemap);
        } else if (message.type === "back") {
          this.detail = undefined;
          this.detailSnippets.clear();
          this.render();
        } else if (message.type === "reveal" && message.location && this.detail) {
          this.handlers.reveal(this.detail.repo.root, message.location);
        } else if (message.type === "quiz" && codemap) {
          this.handlers.quiz(codemap);
        } else if (message.type === "delete" && codemap) {
          if (this.detail?.id === codemap.id) this.detail = undefined;
          void this.handlers.delete(codemap);
        } else if (message.type === "selectModel") {
          void this.handlers.selectModel();
        } else if (message.type === "refresh") {
          void this.handlers.refresh();
        } else if (message.type === "suggest") {
          void this.handlers.suggest();
        }
      }
    );
    this.render();
  }

  setData(codemaps: Codemap[], backends: BackendOption[]): void {
    this.codemaps = codemaps;
    this.backends = backends;
    if (this.detail) {
      this.detail = codemaps.find((item) => item.id === this.detail?.id);
    }
    this.render();
  }

  setGenerating(query: string): void {
    this.generatingQuery = query;
    this.progress = { phase: "research", message: "Starting repository research" };
    this.render();
  }

  setProgress(progress: ProgressEvent): void {
    this.progress = progress;
    this.render();
  }

  clearProgress(): void {
    this.generatingQuery = "";
    this.progress = undefined;
    this.render();
  }

  setSuggestionsLoading(): void {
    this.suggestionsLoading = true;
    this.suggestionsError = "";
    this.render();
  }

  setSuggestions(suggestions: CodemapSuggestion[]): void {
    this.suggestions = suggestions;
    this.suggestionsLoading = false;
    this.suggestionsError = suggestions.length === 0 ? "The model did not return usable suggestions." : "";
    this.render();
  }

  setSuggestionsError(message: string): void {
    this.suggestionsLoading = false;
    this.suggestionsError = message;
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = this.html();
  }

  /** Run a follow-up question and post the answer back into the sidebar chat. */
  private async handleAsk(codemap: Codemap, requestId: number, question: string): Promise<void> {
    const post = (payload: Record<string, unknown>) =>
      void this.view?.webview.postMessage({ type: "answer", requestId, ...payload });
    try {
      const result = await this.handlers.ask(codemap, question);
      post({ answer: result.answer, citations: result.citations, repoRoot: codemap.repo.root });
    } catch (err) {
      post({ error: err instanceof Error ? err.message : String(err) });
    }
  }


  /** Live status card: which file the agent is reading and what it's looking for. */
  private progressCard(progress: ProgressEvent): string {
    const file = progress.file ? baseName(progress.file) : "";
    const step = progress.step ? `Step ${progress.step}` : progress.phase === "synthesis" ? "Synthesis" : "Research";
    const activity =
      progress.phase === "synthesis" ? "Synthesizing codemap" : progress.message || "Researching the repository";
    const detail = progress.detail && progress.detail !== progress.file ? progress.detail : "";
    return `<section class="progress-card">
      <div class="progress-head"><span class="spinner"></span><strong>Generating codemap</strong><span class="progress-step">${escapeHtml(step)}</span></div>
      <div class="progress-query">${escapeHtml(this.generatingQuery)}</div>
      <div class="progress-activity">${escapeHtml(activity)}</div>
      ${file ? `<div class="progress-file">${ICON.file}<span>${escapeHtml(file)}</span></div>` : ""}
      ${detail ? `<div class="progress-detail">${escapeHtml(detail)}</div>` : ""}
      <div class="progress-track"><span></span></div>
    </section>`;
  }

  private html(): string {
    const nonce = String(Math.random()).slice(2);
    const config = vscode.workspace.getConfiguration("roots");
    const kind = config.get<string>("backend.kind", "anthropic");
    const configuredModel = config.get<string>("backend.model", "");
    const baseUrl = config.get<string>("backend.baseUrl", "");
    const backend = this.backends.find((item) => item.kind === kind && (item.baseUrl ?? "") === baseUrl);
    const model = configuredModel || backend?.defaultModel || kind;
    const cards = this.codemaps.map(codemapCard).join("");
    const suggestions = this.suggestions.map(suggestionCard).join("");
    const progress = this.progress ? this.progressCard(this.progress) : "";

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { --border: var(--vscode-widget-border, rgba(128,128,128,.24)); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-textLink-foreground); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 12px 30px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
  button, textarea { font: inherit; }
  .icon-btn { display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; padding:0; border:0; border-radius:5px; color:var(--muted); background:transparent; cursor:pointer; }
  .icon-btn:hover { color:var(--vscode-foreground); background:var(--vscode-toolbar-hoverBackground); }
  .icon-btn svg { width:15px; height:15px; }
  textarea { width:100%; min-height:64px; max-height:132px; resize:vertical; padding:9px 10px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--border)); border-radius:5px; outline:none; line-height:1.4; }
  textarea:focus { border-color:var(--vscode-focusBorder); }
  .generate-row { display:grid; grid-template-columns:minmax(0, 1.4fr) minmax(92px, 0.9fr); gap:8px; margin-top:8px; }
  .model, .generate { height:30px; border-radius:4px; cursor:pointer; }
  .model { display:flex; align-items:center; gap:4px; overflow:hidden; padding:0 8px; text-align:left; color:var(--vscode-foreground); background:transparent; border:1px solid var(--border); }
  .model span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .model svg { flex:none; width:13px; height:13px; opacity:.7; }
  .model:hover { background:var(--vscode-list-hoverBackground); border-color:var(--vscode-focusBorder); }
  .generate { border:0; color:var(--vscode-button-foreground); background:var(--vscode-button-background); font-weight:600; }
  .generate:hover { background:var(--vscode-button-hoverBackground); }
  .generate:disabled { opacity:.55; cursor:default; }
  .section-head { display:flex; align-items:center; justify-content:space-between; margin:19px 0 9px; }
  .section-head h3 { margin:0; font-size:13px; font-weight:650; }
  .count { color:var(--muted); font-size:11px; margin-left:6px; font-weight:400; }
  .empty { color:var(--muted); text-align:center; padding:42px 12px; }
  .suggestions { display:flex; flex-direction:column; gap:7px; }
  .suggestion { width:100%; padding:10px 11px; text-align:left; color:var(--vscode-foreground); background:transparent; border:1px solid var(--border); border-radius:6px; cursor:pointer; }
  .suggestion:hover { background:var(--vscode-list-hoverBackground); border-color:var(--vscode-focusBorder); }
  .suggestion-title { display:block; font-weight:600; line-height:1.35; }
  .suggestion-description { display:block; margin-top:3px; color:var(--muted); font-size:12px; line-height:1.35; }
  .suggestion-state { padding:10px 2px; color:var(--muted); font-size:12px; }
  .mini-spinner { display:inline-block; width:11px; height:11px; margin-right:7px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; vertical-align:-1px; }
  .map-card { position:relative; display:block; width:100%; margin-bottom:7px; padding:10px 36px 9px 11px; text-align:left; color:var(--vscode-foreground); background:transparent; border:1px solid var(--border); border-radius:6px; cursor:pointer; }
  .map-card:hover { background:var(--vscode-list-hoverBackground); border-color:var(--vscode-focusBorder); }
  .map-title { display:block; font-weight:600; line-height:1.35; }
  .map-meta { display:block; margin-top:4px; color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .map-model { color:var(--accent); }
  .quiz { position:absolute; right:7px; top:7px; display:inline-flex; align-items:center; justify-content:center; width:24px; height:24px; border:0; border-radius:4px; color:var(--muted); background:transparent; cursor:pointer; opacity:0; transition:opacity .12s; }
  .map-card:hover .quiz, .quiz:focus { opacity:1; }
  .quiz:hover { color:var(--vscode-foreground); background:var(--vscode-toolbar-hoverBackground); }
  .quiz svg { width:14px; height:14px; }
  .progress-card { margin-top:17px; padding:12px; border:1px solid var(--border); border-radius:6px; background:var(--vscode-sideBarSectionHeader-background); }
  .progress-head { display:flex; align-items:center; gap:8px; }
  .progress-step { margin-left:auto; font-size:11px; color:var(--muted); font-weight:400; }
  .spinner { width:14px; height:14px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; }
  .progress-query { margin:8px 0; color:var(--muted); line-height:1.35; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
  .progress-activity { font-size:12px; color:var(--vscode-foreground); line-height:1.4; }
  .progress-file { display:flex; align-items:center; gap:6px; margin-top:6px; font-size:12px; color:var(--accent); overflow:hidden; }
  .progress-file svg { flex:none; width:13px; height:13px; }
  .progress-file span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family, monospace); }
  .progress-detail { margin-top:4px; font-size:11px; color:var(--muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--vscode-editor-font-family, monospace); }
  .progress-track { height:3px; margin-top:9px; overflow:hidden; border-radius:2px; background:var(--border); }
  .progress-track span { display:block; width:35%; height:100%; background:var(--vscode-progressBar-background); animation:travel 1.5s ease-in-out infinite alternate; }
  @keyframes spin { to { transform:rotate(360deg); } } @keyframes travel { to { transform:translateX(185%); } }
  /* Detail view */
  .detail-head { display:flex; align-items:center; gap:6px; margin-bottom:10px; }
  .back { display:inline-flex; align-items:center; gap:5px; padding:4px 8px 4px 6px; border:0; border-radius:5px; color:var(--vscode-foreground); background:transparent; cursor:pointer; }
  .back:hover { background:var(--vscode-toolbar-hoverBackground); }
  .back svg { width:14px; height:14px; }
  .detail-actions { margin-left:auto; display:flex; gap:2px; }
  .detail-title { margin:0 0 4px; font-size:14px; font-weight:650; line-height:1.35; }
  .detail-meta { color:var(--muted); font-size:11px; margin-bottom:12px; }
  .overview { font-size:12px; line-height:1.5; color:var(--vscode-foreground); padding:10px 12px; margin-bottom:14px; border:1px solid var(--border); border-radius:8px; background:var(--vscode-textBlockQuote-background, transparent); }
  .overview .ref { font-family:var(--vscode-editor-font-family, monospace); font-size:10.5px; color:var(--vscode-textLink-activeForeground, var(--accent)); background:color-mix(in srgb, var(--accent) 14%, transparent); border:1px solid color-mix(in srgb, var(--accent) 32%, transparent); border-radius:4px; padding:0 4px; }
  .overview .ref-link { cursor:pointer; }
  .overview .ref-link:hover { background:color-mix(in srgb, var(--accent) 26%, transparent); border-color:var(--accent); }
  .chat { border-top:1px solid var(--border); margin-top:16px; padding-top:14px; }
  .chat-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:10px; }
  .chat-thread { display:flex; flex-direction:column; gap:10px; margin-bottom:12px; }
  .chat-empty { font-size:12px; color:var(--muted); }
  .msg { font-size:12px; line-height:1.5; padding:8px 10px; border-radius:8px; border:1px solid var(--border); }
  .msg-user { align-self:flex-end; max-width:88%; color:var(--vscode-foreground); background:color-mix(in srgb, var(--accent) 10%, transparent); border-color:color-mix(in srgb, var(--accent) 28%, transparent); }
  .msg-assistant { color:var(--vscode-foreground); background:var(--vscode-textBlockQuote-background, transparent); }
  .msg-error { color:var(--vscode-errorForeground); border-color:color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent); background:color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent); }
  .msg-thinking { color:var(--muted); font-style:italic; }
  .msg .cites { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .msg .cite { font-family:var(--vscode-editor-font-family, monospace); font-size:10.5px; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border:1px solid var(--border); border-radius:4px; padding:1px 6px; cursor:pointer; }
  .msg .cite:hover { border-color:var(--vscode-focusBorder); }
  .chat-form { display:flex; gap:6px; align-items:flex-end; }
  .chat-input { min-height:36px; }
  .chat-send { display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; flex:none; border:0; border-radius:5px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; }
  .chat-send svg { width:15px; height:15px; }
  .chat-send:hover { background:var(--vscode-button-hoverBackground); }
  .chat-send:disabled { opacity:.55; cursor:default; }
  .trace-num { display:flex; align-items:center; justify-content:center; width:19px; height:19px; flex:0 0 19px; border-radius:50%; font-size:10px; font-weight:600; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); }
  .trace-loc { display:inline-flex; align-items:center; gap:4px; margin-left:6px; padding:1px 6px; border-radius:4px; font-size:10.5px; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border:1px solid var(--border); cursor:pointer; font-family:var(--vscode-editor-font-family, monospace); white-space:nowrap; }
  .trace-loc:hover { color:var(--vscode-badge-foreground); border-color:var(--vscode-focusBorder); }
  .section { border-top:1px solid var(--border); padding:10px 0 8px; }
  .section:last-child { border-bottom:1px solid var(--border); }
  .section-head { display:flex; align-items:center; gap:9px; width:100%; background:none; border:0; padding:0; color:inherit; font:inherit; text-align:left; cursor:default; }
  .section-head[data-toggle] { cursor:pointer; }
  .section-title { font-weight:650; font-size:12.5px; flex:1; line-height:1.35; }
  .section-chevron { display:flex; color:var(--muted); transition:transform .12s ease; }
  .section[data-open="true"] .section-chevron { transform:rotate(90deg); }
  .section-summary { color:var(--muted); line-height:1.45; margin:5px 0 0 28px; font-size:11.5px; }
  .section-children { margin:8px 0 0 9px; padding-left:15px; border-left:1px solid var(--border); display:none; }
  .section[data-open="true"] .section-children { display:block; }
  .sub { padding:5px 0; }
  .sub-head { display:flex; align-items:center; gap:8px; }
  .sub-num { display:flex; align-items:center; justify-content:center; min-width:20px; height:17px; padding:0 5px; border-radius:9px; font-size:9.5px; font-weight:600; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border:1px solid var(--border); font-family:var(--vscode-editor-font-family, monospace); }
  .sub-title { font-weight:550; font-size:11.5px; flex:1; line-height:1.35; }
  .sub-summary { color:var(--muted); line-height:1.45; margin:3px 0 0 28px; font-size:11px; }
  .source-line { margin:5px 0 0 28px; padding:6px 8px; overflow-x:auto; color:var(--vscode-editor-foreground); background:var(--vscode-textCodeBlock-background); border:1px solid var(--border); border-radius:4px; font:10.5px/1.5 var(--vscode-editor-font-family, monospace); white-space:pre; tab-size:2; }
  .source-line code { display:block; }
  .expandable.collapsed { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
  .see-more { margin:3px 0 0 28px; padding:0; border:0; color:var(--vscode-textLink-foreground); background:transparent; font-size:10.5px; cursor:pointer; }
  .see-more:hover { text-decoration:underline; }
  .guide { display:none; margin:8px 0 2px 28px; padding:8px 10px; border-left:2px solid var(--accent); background:var(--vscode-textBlockQuote-background, transparent); font-size:11px; line-height:1.5; white-space:pre-line; }
  .guide[data-open="true"] { display:block; }
  .guide strong { display:block; margin:0 0 2px; color:var(--vscode-foreground); font-size:10.5px; text-transform:uppercase; }
  .guide-toggle { margin:5px 0 0 28px; padding:0; border:0; color:var(--vscode-textLink-foreground); background:transparent; font-size:10.5px; cursor:pointer; }
  .guide-toggle:hover { text-decoration:underline; }
</style></head><body>
  ${this.detail ? this.detailBody(this.detail) : this.listBody({ cards, suggestions, backend, kind, model, progress })}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  ${this.detail ? this.detailScript() : this.listScript()}
</script></body></html>`;
  }

  private listBody(ctx: {
    cards: string;
    suggestions: string;
    backend: BackendOption | undefined;
    kind: string;
    model: string;
    progress: string;
  }): string {
    const { cards, suggestions, backend, kind, model, progress } = ctx;
    return `
  <textarea id="query" placeholder="Enter a starting point for a new codemap" ${this.progress ? "disabled" : ""}></textarea>
  <div class="generate-row">
    <button class="model" id="model" title="Change model"><span>${escapeHtml(backend?.label || kind)} · ${escapeHtml(model)}</span>${ICON.chevron}</button>
    <button class="generate" id="generate" ${this.progress ? "disabled" : ""}>Generate</button>
  </div>
  ${progress}
  <div class="section-head">
    <h3>Suggestions from repository</h3>
    <button class="icon-btn" id="suggest" title="Ask ${escapeHtml(backend?.label || kind)} for new suggestions">${ICON.refresh}</button>
  </div>
  <section class="suggestions">
    ${this.suggestionsLoading ? `<div class="suggestion-state"><span class="mini-spinner"></span>Asking the model...</div>` : suggestions}
    ${!this.suggestionsLoading && this.suggestionsError ? `<div class="suggestion-state">${escapeHtml(this.suggestionsError)}</div>` : ""}
    ${!this.suggestionsLoading && !this.suggestionsError && !suggestions ? `<div class="suggestion-state">Generate ideas based on this repository.</div>` : ""}
  </section>
  <div class="section-head"><h3>Your Codemaps <span class="count">${this.codemaps.length}</span></h3></div>
  <main>${cards || `<div class="empty">No codemaps found for this repository.</div>`}</main>`;
  }

  private detailBody(codemap: Codemap): string {
    const date = new Date(codemap.created_at).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const byId = new Map(codemap.traces.map((t) => [t.id, t]));
    const childIds = new Set(codemap.traces.flatMap((t) => t.children ?? []));
    const roots = codemap.traces.filter((t) => !childIds.has(t.id));
    const rows = roots
      .map((trace, index) => sectionRow(trace, index + 1, byId, this.detailSnippets))
      .join("");
    const overview = codemap.overview
      ? `<div class="overview">${renderOverview(codemap.overview, codemap.traces)}</div>`
      : "";
    return `
  <div class="detail-head">
    <button class="back" id="back">${ICON.back}<span>Codemaps</span></button>
    <div class="detail-actions">
      <button class="icon-btn" id="detail-chat" title="Ask a question">${ICON.chat}</button>
      <button class="icon-btn" id="open-editor" title="Open full map in editor">${ICON.expand}</button>
      <button class="icon-btn" id="detail-quiz" title="Quiz me">${ICON.quiz}</button>
    </div>
  </div>
  <h2 class="detail-title">${escapeHtml(codemap.query)}</h2>
  <div class="detail-meta">${escapeHtml(codemap.model.backend)} · ${escapeHtml(codemap.model.model_name)} · ${escapeHtml(codemap.model.mode)} · ${date}</div>
  ${overview}
  <main>${rows || `<div class="empty">This codemap has no traces.</div>`}</main>
  <section class="chat" id="chat">
    <div class="chat-title">Ask a question</div>
    <div class="chat-thread" id="chat-thread"><div class="chat-empty" id="chat-empty">Ask anything about this codemap. Answers cite real files.</div></div>
    <form class="chat-form" id="chat-form">
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="Ask about this code…"></textarea>
      <button class="chat-send" id="chat-send" type="submit">${ICON.send}</button>
    </form>
  </section>`;
  }

  private listScript(): string {
    return `
  const query = document.getElementById('query');
  const previous = vscode.getState();
  if (previous?.query) query.value = previous.query;
  query.addEventListener('input', () => vscode.setState({ query: query.value }));
  document.getElementById('generate').addEventListener('click', () => vscode.postMessage({ type:'generate', query:query.value }));
  document.getElementById('model').addEventListener('click', () => vscode.postMessage({ type:'selectModel' }));
  document.getElementById('suggest').addEventListener('click', () => vscode.postMessage({ type:'suggest' }));
  query.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') vscode.postMessage({ type:'generate', query:query.value }); });
  for (const card of document.querySelectorAll('.map-card')) {
    card.addEventListener('click', () => vscode.postMessage({ type:'open', id:card.dataset.id }));
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') vscode.postMessage({ type:'open', id:card.dataset.id }); });
  }
  for (const button of document.querySelectorAll('.quiz')) button.addEventListener('click', (event) => { event.stopPropagation(); vscode.postMessage({ type:'quiz', id:button.dataset.id }); });
  for (const suggestion of document.querySelectorAll('.suggestion')) suggestion.addEventListener('click', () => {
    query.value = suggestion.dataset.query;
    vscode.setState({ query: query.value });
    query.focus();
  });`;
  }

  private detailScript(): string {
    const id = this.detail ? escapeHtml(this.detail.id) : "";
    return `
  document.getElementById('back').addEventListener('click', () => vscode.postMessage({ type:'back' }));
  document.getElementById('open-editor').addEventListener('click', () => vscode.postMessage({ type:'openEditor', id:'${id}' }));
  document.getElementById('detail-quiz').addEventListener('click', () => vscode.postMessage({ type:'quiz', id:'${id}' }));
  for (const head of document.querySelectorAll('.section-head[data-toggle]')) head.addEventListener('click', (event) => {
    if (event.target.closest('.trace-loc')) return;
    const section = head.closest('.section');
    section.dataset.open = section.dataset.open === 'true' ? 'false' : 'true';
  });
  for (const loc of document.querySelectorAll('.trace-loc')) loc.addEventListener('click', (event) => {
    event.stopPropagation();
    vscode.postMessage({
      type:'reveal',
      location:{ file: loc.dataset.file, start_line: Number(loc.dataset.start), end_line: Number(loc.dataset.end) }
    });
  });
  for (const button of document.querySelectorAll('.see-more')) button.addEventListener('click', () => {
    const summary = button.previousElementSibling;
    const collapsed = summary.classList.toggle('collapsed');
    button.textContent = collapsed ? 'See more' : 'See less';
  });
  for (const button of document.querySelectorAll('.guide-toggle')) button.addEventListener('click', () => {
    const guide = button.previousElementSibling;
    const open = guide.dataset.open !== 'true';
    guide.dataset.open = String(open);
    button.textContent = open ? 'Hide AI generated guide' : 'Show AI generated guide';
  });
  const revealLoc = (el) => vscode.postMessage({
    type:'reveal',
    location:{ file: el.dataset.file, start_line: Number(el.dataset.start), end_line: Number(el.dataset.end) }
  });
  for (const ref of document.querySelectorAll('.ref-link')) ref.addEventListener('click', () => revealLoc(ref));

  // --- Chat / Ask a question ---
  const chatThread = document.getElementById('chat-thread');
  const chatEmpty = document.getElementById('chat-empty');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatSection = document.getElementById('chat');
  const chatButton = document.getElementById('detail-chat');
  let requestSeq = 0;
  const pending = new Map();
  const baseNameOf = (p) => (p || '').split(/[\\\\/]/).pop() || p;
  const escapeText = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

  if (chatButton) chatButton.addEventListener('click', () => {
    chatSection.scrollIntoView({ behavior:'smooth', block:'start' });
    chatInput.focus();
  });

  function addMessage(role, html) {
    if (chatEmpty) chatEmpty.style.display = 'none';
    const el = document.createElement('div');
    el.className = 'msg msg-' + role;
    el.innerHTML = html;
    chatThread.appendChild(el);
    chatThread.scrollIntoView({ block:'end' });
    return el;
  }

  function wireCitations(scope) {
    for (const c of scope.querySelectorAll('.cite')) c.addEventListener('click', () => revealLoc(c));
  }

  function submitQuestion() {
    const question = (chatInput.value || '').trim();
    if (!question) return;
    addMessage('user', escapeText(question));
    const thinking = addMessage('thinking', 'Thinking…');
    const requestId = ++requestSeq;
    pending.set(requestId, thinking);
    chatInput.value = '';
    chatSend.disabled = true;
    vscode.postMessage({ type:'ask', requestId, question });
  }

  chatForm.addEventListener('submit', (event) => { event.preventDefault(); submitQuestion(); });
  chatInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submitQuestion(); }
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.type !== 'answer') return;
    const bubble = pending.get(msg.requestId);
    if (!bubble) return;
    pending.delete(msg.requestId);
    chatSend.disabled = false;
    if (msg.error) {
      bubble.className = 'msg msg-error';
      bubble.textContent = msg.error;
      return;
    }
    bubble.className = 'msg msg-assistant';
    let html = escapeText(msg.answer);
    const cites = Array.isArray(msg.citations) ? msg.citations : [];
    if (cites.length) {
      html += '<div class="cites">' + cites.map((c) =>
        '<span class="cite" data-file="' + escapeText(c.file) + '" data-start="' + c.start_line + '" data-end="' + c.end_line + '">' +
        escapeText(baseNameOf(c.file)) + ':' + c.start_line + '</span>'
      ).join('') + '</div>';
    }
    bubble.innerHTML = html;
    wireCitations(bubble);
  });`;
  }
}

function locTagHtml(loc: Trace["locations"][number] | undefined): string {
  if (!loc) return "";
  return `<span class="trace-loc" data-file="${escapeHtml(loc.file)}" data-start="${loc.start_line}" data-end="${loc.end_line}">${escapeHtml(baseName(loc.file))}:${loc.start_line}</span>`;
}

/** A top-level section (numbered 1, 2, 3…) with its nested sub-steps. */
function sectionRow(
  trace: Trace,
  num: number,
  byId: Map<string, Trace>,
  snippets: Map<string, string>
): string {
  const children = (trace.children ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is Trace => Boolean(c));
  const subs = children
    .map((child, i) => childRow(child, `${num}${String.fromCharCode(97 + i)}`, snippets.get(child.id)))
    .join("");
  const collapsible = subs
    ? `<div class="section-children">${subs}</div>`
    : "";
  return `<section class="section" data-open="${subs ? "true" : "false"}">
    <button class="section-head" ${subs ? 'data-toggle="1"' : ""}>
      <span class="trace-num">${num}</span>
      <span class="section-title">${escapeHtml(trace.title)}</span>
      ${subs ? `<span class="section-chevron">${ICON.chevron}</span>` : locTagHtml(trace.locations?.[0])}
    </button>
    ${summaryHtml(trace.summary, "section-summary")}
    ${guideHtml(trace)}
    ${collapsible}
  </section>`;
}

/** A nested concrete sub-step (numbered 1a, 1b…). */
function childRow(trace: Trace, label: string, snippet: string | undefined): string {
  return `<div class="sub">
    <div class="sub-head">
      <span class="sub-num">${escapeHtml(label)}</span>
      <span class="sub-title">${escapeHtml(trace.title)}</span>
      ${locTagHtml(trace.locations?.[0])}
    </div>
    ${summaryHtml(trace.summary, "sub-summary")}
    ${snippet ? `<pre class="source-line"><code>${escapeHtml(snippet)}</code></pre>` : ""}
  </div>`;
}

function summaryHtml(summary: string, className: string): string {
  if (!summary) return "";
  const long = summary.length > 180;
  return `<div class="${className}${long ? " expandable collapsed" : ""}">${escapeHtml(summary)}</div>${
    long ? '<button class="see-more">See more</button>' : ""
  }`;
}

function guideHtml(trace: Trace): string {
  const motivation = trace.motivation
    ? `<strong>Motivation</strong>${escapeHtml(trace.motivation)}`
    : "";
  const details = trace.details
    ? `<strong>Details</strong>${escapeHtml(trace.details)}`
    : "";
  if (!motivation && !details) return "";
  return `<div class="guide" data-open="false">${motivation}${details}</div><button class="guide-toggle">Show AI generated guide</button>`;
}

/**
 * Render overview text, turning [tN] refs into chips. Refs that map to a real
 * trace location become clickable (jump to file:line); unknown ids stay plain.
 */
function renderOverview(text: string, traces: Trace[]): string {
  const byId = new Map(traces.map((t) => [t.id, t]));
  return escapeHtml(text).replace(/\[([^\]]+)\]/g, (_m, id: string) => {
    const loc = byId.get(id)?.locations?.[0];
    if (!loc) return `<span class="ref">${escapeHtml(id)}</span>`;
    return `<span class="ref ref-link" data-file="${escapeHtml(loc.file)}" data-start="${loc.start_line}" data-end="${loc.end_line}" title="Open ${escapeHtml(baseName(loc.file))}:${loc.start_line}">${escapeHtml(id)}</span>`;
  });
}

function codemapCard(codemap: Codemap): string {
  const date = new Date(codemap.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `<article class="map-card" data-id="${escapeHtml(codemap.id)}" role="button" tabindex="0">
    <span class="map-title">${escapeHtml(codemap.query)}</span>
    <span class="map-meta">${date} · ${codemap.traces.length} steps · <span class="map-model">${escapeHtml(codemap.model.model_name)}</span></span>
    <span class="quiz" role="button" data-id="${escapeHtml(codemap.id)}" title="Quiz me">${ICON.quiz}</span>
  </article>`;
}

function suggestionCard(suggestion: CodemapSuggestion): string {
  return `<button class="suggestion" data-query="${escapeHtml(suggestion.query)}">
    <span class="suggestion-title">${escapeHtml(suggestion.title)}</span>
    <span class="suggestion-description">${escapeHtml(suggestion.description)}</span>
  </button>`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Lucide-style inline icons (stroke follows currentColor). */
const ICON = {
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  quiz: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
} as const;

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}