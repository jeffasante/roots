import * as vscode from "vscode";
import type {
  AskResult,
  BackendOption,
  Codemap,
  CodemapSuggestion,
  ProgressEvent,
  SuggestionIntensity,
  Trace,
} from "../engineClient.js";

/** The user-selectable representations of a codemap in the detail view. */
export type CodemapViewMode = "overview" | "diagram" | "json";

/** A node in the derived codemap graph artifact. */
interface GraphNode {
  id: string;
  label: string;
  kind: string;
  file?: string;
  range?: { start: number; end: number };
  role: string;
  confidence: number;
  subgraph: string;
}

/** A typed edge between two graph nodes. */
interface GraphEdge {
  from: string;
  to: string;
  type: string;
}

/** A collapsible grouping of nodes (a top-level trace and its descendants). */
interface GraphSubgraph {
  id: string;
  label: string;
}

/** The full graph artifact rendered by the graph / JSON views. */
interface CodemapGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs: GraphSubgraph[];
}

interface CodemapsViewHandlers {
  generate(query: string): Promise<void>;
  open(codemap: Codemap): void;
  quiz(codemap: Codemap): void;
  delete(codemap: Codemap): Promise<void>;
  selectModel(): Promise<void>;
  refresh(): Promise<void>;
  suggest(intensity: SuggestionIntensity): Promise<void>;
  /** Reveal a specific location in the editor from the in-sidebar detail view. */
  reveal(repoRoot: string, location: { file: string; start_line: number; end_line: number }): void;
  /** Answer a follow-up question about the codemap, grounded in real files. */
  ask(codemap: Codemap, question: string): Promise<AskResult>;
  /** The set of favorited codemap ids, persisted across sessions. */
  favorites(): string[];
  /** Toggle a codemap's favorite state and persist the change. */
  toggleFavorite(id: string): Promise<void>;
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
  private suggestionIntensity: SuggestionIntensity = "intermediate";
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
        attachContext?: boolean;
        intensity?: SuggestionIntensity;
      }) => {
        const codemap = this.codemaps.find((item) => item.id === message.id);
        if (message.type === "ask" && this.detail && typeof message.requestId === "number" && message.question) {
          void this.handleAsk(this.detail, message.requestId, message.question, message.attachContext !== false);
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
        } else if (message.type === "favorite" && message.id) {
          void this.handlers.toggleFavorite(message.id).then(() => this.render());
        } else if (message.type === "selectModel") {
          void this.handlers.selectModel();
        } else if (message.type === "refresh") {
          void this.handlers.refresh();
        } else if (message.type === "suggest") {
          if (message.intensity) this.suggestionIntensity = message.intensity;
          void this.handlers.suggest(this.suggestionIntensity);
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
  private async handleAsk(
    codemap: Codemap,
    requestId: number,
    question: string,
    attachContext = true,
  ): Promise<void> {
    const post = (payload: Record<string, unknown>) =>
      void this.view?.webview.postMessage({ type: "answer", requestId, ...payload });
    try {
      // When the user detaches context, strip the codemap traces/overview so the
      // agent answers from the live repo alone rather than the codemap summary.
      const grounding: Codemap = attachContext ? codemap : { ...codemap, overview: "", traces: [] };
      const result = await this.handlers.ask(grounding, question);
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
    const favorites = new Set(this.handlers.favorites());
    // Favorited codemaps float to the top; the rest keep their existing order.
    const ordered = [...this.codemaps].sort(
      (a, b) => Number(favorites.has(b.id)) - Number(favorites.has(a.id)),
    );
    const cards = ordered.map((codemap) => codemapCard(codemap, favorites.has(codemap.id))).join("");
    const favoriteCount = this.codemaps.filter((c) => favorites.has(c.id)).length;
    const suggestions = this.suggestions.map(suggestionCard).join("");
    const progress = this.progress ? this.progressCard(this.progress) : "";

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' https://cdn.jsdelivr.net;" />
<style>
  :root { --border: var(--vscode-widget-border, rgba(128,128,128,.24)); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-textLink-foreground); }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 12px 30px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: 13px; }
  button, textarea, input { font: inherit; }
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
  .intensity { display:inline-flex; width:auto; max-width:100%; gap:2px; margin:0 0 9px; padding:2px; border:1px solid var(--border); border-radius:6px; background:var(--vscode-editor-background); }
  .intensity-opt { flex:0 0 auto; min-width:74px; padding:3px 9px; border:0; border-radius:4px; background:transparent; color:var(--muted); font:inherit; font-size:10.5px; line-height:18px; cursor:pointer; }
  .intensity-opt:hover:not([aria-pressed="true"]) { background:var(--vscode-list-hoverBackground); color:var(--vscode-foreground); }
  .intensity-opt[aria-pressed="true"] { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
  .intensity-opt:disabled { opacity:.5; cursor:default; }
  .suggestions { display:flex; flex-direction:column; gap:7px; }
  .suggestion { width:100%; padding:10px 11px; text-align:left; color:var(--vscode-foreground); background:transparent; border:1px solid var(--border); border-radius:6px; cursor:pointer; }
  .suggestion:hover { background:var(--vscode-list-hoverBackground); border-color:var(--vscode-focusBorder); }
  .suggestion-title { display:block; font-weight:600; line-height:1.35; }
  .suggestion-description { display:block; margin-top:3px; color:var(--muted); font-size:12px; line-height:1.35; }
  .suggestion-state { padding:10px 2px; color:var(--muted); font-size:12px; }
  .mini-spinner { display:inline-block; width:11px; height:11px; margin-right:7px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .8s linear infinite; vertical-align:-1px; }
  .library-head { gap:8px; margin-bottom:7px; }
  .library-filter { display:inline-flex; gap:1px; margin-left:auto; padding:2px; border:1px solid var(--border); border-radius:6px; background:var(--vscode-editor-background); }
  .filter-opt { display:inline-flex; align-items:center; gap:4px; min-height:22px; padding:2px 7px; border:0; border-radius:4px; color:var(--muted); background:transparent; font-size:10.5px; cursor:pointer; }
  .filter-opt:hover:not(:disabled) { color:var(--vscode-foreground); background:var(--vscode-toolbar-hoverBackground); }
  .filter-opt[aria-pressed="true"] { color:var(--vscode-foreground); background:var(--vscode-list-activeSelectionBackground); }
  .filter-opt:disabled { opacity:.42; cursor:default; }
  .filter-opt svg { width:11px; height:11px; }
  .filter-count { min-width:14px; padding:0 3px; border-radius:7px; text-align:center; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); font-size:9px; line-height:14px; }
  .library-search { position:relative; margin-bottom:7px; }
  .library-search-icon { position:absolute; left:8px; top:50%; display:flex; color:var(--muted); pointer-events:none; transform:translateY(-50%); }
  .library-search-icon svg { width:13px; height:13px; }
  .library-search input { width:100%; height:28px; padding:3px 28px 3px 27px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--border)); border-radius:5px; outline:none; font-size:11.5px; }
  .library-search input:focus { border-color:var(--vscode-focusBorder); }
  .map-card { position:relative; display:flex; align-items:flex-start; width:100%; min-height:54px; margin-bottom:4px; padding:8px 8px 7px 10px; text-align:left; color:var(--vscode-foreground); background:transparent; border:1px solid var(--border); border-radius:5px; cursor:pointer; }
  .map-card:hover, .map-card:focus-visible { background:var(--vscode-list-hoverBackground); border-color:var(--vscode-focusBorder); outline:none; }
  .map-main { min-width:0; flex:1; padding-right:4px; }
  .map-title { display:-webkit-box; overflow:hidden; font-weight:600; font-size:12px; line-height:1.3; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
  .map-meta { display:block; margin-top:3px; color:var(--muted); font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .map-model { color:var(--accent); }
  .map-actions { display:flex; flex:none; gap:1px; margin-left:2px; }
  .map-act { display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; padding:0; border:0; border-radius:4px; color:var(--muted); background:transparent; cursor:pointer; opacity:0; }
  .map-card:hover .map-act, .map-act:focus-visible, .map-act.is-active { opacity:1; }
  .map-act:hover, .map-act:focus-visible { color:var(--vscode-foreground); background:var(--vscode-toolbar-hoverBackground); outline:none; }
  .map-act.star.is-active { color:var(--vscode-charts-yellow, #d7ba7d); }
  .map-act.danger:hover, .map-act.danger:focus-visible { color:var(--vscode-errorForeground); }
  .map-act svg { width:13px; height:13px; }
  .library-empty { padding:22px 8px; color:var(--muted); text-align:center; font-size:11.5px; }
  @media (max-width:330px) { .filter-opt span:not(.filter-count) { display:none; } .intensity-opt { min-width:64px; padding-inline:7px; } }
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
  .diagram-view { position:relative; height:max(440px, calc(100vh - 126px)); min-height:440px; margin-top:10px; overflow:hidden; border:1px solid var(--border); border-radius:6px; background:var(--vscode-editor-background); cursor:grab; }
  .diagram-view[data-dragging="true"] { cursor:grabbing; }
  .diagram-stage { width:max-content; min-width:100%; min-height:100%; padding:30px; transform-origin:0 0; }
  .diagram-stage svg { display:block; max-width:none; height:auto; }
  .diagram-stage .node { cursor:pointer; }
  .diagram-stage .node:hover rect, .diagram-stage .node:hover polygon, .diagram-stage .node:hover circle { stroke:var(--vscode-focusBorder) !important; stroke-width:2px !important; }
  .diagram-controls { position:absolute; z-index:2; right:8px; top:8px; display:flex; flex-direction:column; gap:3px; padding:3px; border:1px solid var(--border); border-radius:5px; background:var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow:0 2px 8px rgba(0,0,0,.18); }
  .diagram-controls .icon-btn { background:transparent; }
  .diagram-loading, .diagram-error { padding:18px; color:var(--muted); font-size:11.5px; }
  /* View-mode tabs */
  .view-tabs { display:inline-flex; gap:2px; margin:12px 0 4px; padding:2px; border:1px solid var(--border); border-radius:7px; background:var(--vscode-editor-background); }
  .view-tab { display:inline-flex; align-items:center; gap:5px; padding:4px 10px; border:0; border-radius:5px; background:transparent; color:var(--muted); font-size:11.5px; font-weight:500; cursor:pointer; }
  .view-tab svg { width:14px; height:14px; }
  .view-tab:hover { color:var(--vscode-foreground); }
  .view-tab[aria-selected="true"] { color:var(--vscode-foreground); background:var(--vscode-toolbar-hoverBackground); }
  .view-panel[hidden] { display:none; }
  /* Interactive graph view */
  .graph-toolbar, .mermaid-toolbar, .json-toolbar { display:flex; align-items:center; justify-content:space-between; margin:8px 0 6px; }
  .graph-count { font-size:11px; color:var(--muted); }
  .graph-controls, .mermaid-controls { display:flex; gap:2px; padding:2px; border:1px solid var(--border); border-radius:5px; }
  .graph-view { position:relative; height:max(440px, calc(100vh - 168px)); min-height:440px; overflow:hidden; border:1px solid var(--border); border-radius:6px; background:var(--vscode-editor-background); cursor:grab; }
  .graph-view[data-dragging="true"] { cursor:grabbing; }
  .graph-stage { width:max-content; min-width:100%; padding:16px; transform-origin:0 0; display:flex; flex-direction:column; gap:14px; }
  .graph-subgraph { border:1px solid var(--border); border-radius:8px; padding:10px; background:var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
  .graph-subgraph-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); margin-bottom:8px; }
  .graph-subgraph-nodes { display:flex; flex-wrap:wrap; gap:8px; }
  .graph-node { display:flex; flex-direction:column; gap:3px; width:210px; text-align:left; padding:8px 10px; border:1px solid var(--border); border-radius:7px; background:var(--vscode-editor-background); color:var(--vscode-foreground); cursor:pointer; }
  .graph-node:hover { border-color:var(--vscode-focusBorder); }
  .graph-node-head { display:flex; align-items:center; justify-content:space-between; }
  .graph-node-kind { font-size:9.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); }
  .graph-node-conf { font-size:9.5px; color:var(--muted); }
  .graph-node-label { font-size:12px; font-weight:500; line-height:1.3; }
  .graph-node-loc { font-size:10.5px; color:var(--muted); font-family:var(--vscode-editor-font-family, monospace); }
  .graph-node-edges { display:flex; flex-wrap:wrap; gap:4px; margin-top:2px; }
  .graph-edge-label { font-size:10px; color:var(--muted); }
  .graph-role-section { border-left:2px solid var(--vscode-focusBorder); }
  .graph-role-lifecycle { opacity:.82; }
  .graph-empty { padding:18px; color:var(--muted); font-size:11.5px; }
  /* Mermaid view */
  .mermaid-view { position:relative; height:max(440px, calc(100vh - 168px)); min-height:440px; overflow:hidden; border:1px solid var(--border); border-radius:6px; background:var(--vscode-editor-background); cursor:grab; }
  .mermaid-view[data-dragging="true"] { cursor:grabbing; }
  .mermaid-view .diagram-stage svg { display:block; max-width:none; height:auto; }
  .mermaid-view .node { cursor:pointer; }
  .mermaid-view .node:hover rect, .mermaid-view .node:hover polygon, .mermaid-view .node:hover circle { stroke:var(--vscode-focusBorder) !important; stroke-width:2px !important; }
  #view-mermaid.fullscreen, #view-graph.fullscreen { position:fixed; inset:0; z-index:50; margin:0; padding:12px; background:var(--vscode-editor-background); overflow:auto; }
  #view-mermaid.fullscreen .mermaid-view, #view-graph.fullscreen .graph-view { height:calc(100vh - 60px); }
  .mermaid-source, .json-view { margin:8px 0 0; padding:12px; border:1px solid var(--border); border-radius:6px; background:var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); overflow:auto; max-height:max(440px, calc(100vh - 200px)); }
  .mermaid-source code, .json-view code { font-family:var(--vscode-editor-font-family, monospace); font-size:11.5px; line-height:1.55; white-space:pre; color:var(--vscode-foreground); }
  .mermaid-source[hidden] { display:none; }
  .icon-btn.is-active { color:var(--vscode-foreground); background:var(--vscode-toolbar-hoverBackground); }
  .chat-popover { position:fixed; z-index:40; top:52px; right:12px; width:min(360px, calc(100vw - 24px)); max-height:min(70vh, 520px); display:flex; flex-direction:column; padding:12px; border:1px solid var(--border); border-radius:10px; background:var(--vscode-editorWidget-background, var(--vscode-editor-background)); box-shadow:0 12px 32px rgba(0,0,0,.34); animation:chat-pop .12s ease-out; }
  .chat-popover[hidden] { display:none; }
  @keyframes chat-pop { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:none; } }
  .chat-popover-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .chat-popover-title { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .chat-thread { display:flex; flex-direction:column; gap:10px; margin-bottom:10px; overflow-y:auto; }
  .chat-empty { font-size:12px; color:var(--muted); }
  .msg { font-size:12px; line-height:1.5; padding:8px 10px; border-radius:8px; border:1px solid var(--border); }
  .msg-user { align-self:flex-end; max-width:88%; color:var(--vscode-foreground); background:color-mix(in srgb, var(--accent) 10%, transparent); border-color:color-mix(in srgb, var(--accent) 28%, transparent); }
  .msg-assistant { color:var(--vscode-foreground); background:var(--vscode-textBlockQuote-background, transparent); }
  .msg-error { color:var(--vscode-errorForeground); border-color:color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent); background:color-mix(in srgb, var(--vscode-errorForeground) 8%, transparent); }
  .msg-thinking { color:var(--muted); font-style:italic; }
  .markdown > :first-child { margin-top:0; }
  .markdown > :last-child { margin-bottom:0; }
  .markdown p { margin:0 0 7px; }
  .markdown ul, .markdown ol { margin:5px 0 7px; padding-left:20px; }
  .markdown li { margin:2px 0; }
  .markdown code { padding:1px 4px; border-radius:3px; color:var(--vscode-textPreformat-foreground); background:var(--vscode-textCodeBlock-background); font:inherit; font-family:var(--vscode-editor-font-family, monospace); }
  .markdown pre { margin:7px 0; padding:8px; overflow-x:auto; border:1px solid var(--border); border-radius:4px; background:var(--vscode-textCodeBlock-background); }
  .markdown pre code { padding:0; background:transparent; font-size:10.5px; white-space:pre; }
  .markdown a { color:var(--vscode-textLink-foreground); }
  .msg .cites { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
  .msg .cite { font-family:var(--vscode-editor-font-family, monospace); font-size:10.5px; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border:1px solid var(--border); border-radius:4px; padding:1px 6px; cursor:pointer; }
  .msg .cite:hover { border-color:var(--vscode-focusBorder); }
  .chat-form { display:flex; flex-direction:column; gap:0; padding:6px 6px 6px; border:1px solid var(--vscode-input-border, var(--border)); border-radius:8px; background:var(--vscode-input-background); }
  .chat-form:focus-within { border-color:var(--vscode-focusBorder); }
  .chat-input { min-height:34px; max-height:120px; padding:4px 4px; border:0; border-radius:0; background:transparent; resize:none; }
  .chat-input:focus { border:0; }
  .chat-form-actions { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-top:2px; }
  .chat-context { display:inline-flex; align-items:center; max-width:70%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:2px 8px; border:1px solid var(--border); border-radius:12px; color:var(--muted); background:transparent; font-size:11px; cursor:pointer; }
  .chat-context[aria-pressed="true"] { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 40%, transparent); background:color-mix(in srgb, var(--accent) 12%, transparent); }
  .chat-context:hover { border-color:var(--vscode-focusBorder); }
  .chat-send { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; flex:none; border:0; border-radius:6px; color:var(--vscode-button-foreground); background:var(--vscode-button-background); cursor:pointer; }
  .chat-send svg { width:14px; height:14px; }
  .chat-send:hover { background:var(--vscode-button-hoverBackground); }
  .chat-send:disabled { opacity:.55; cursor:default; }
  .trace-num { display:flex; align-items:center; justify-content:center; width:19px; height:19px; flex:0 0 19px; border-radius:50%; font-size:10px; font-weight:600; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); }
  .trace-loc { display:inline-flex; align-items:center; gap:4px; margin-left:6px; padding:1px 6px; border-radius:4px; font-size:10.5px; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border:1px solid var(--border); cursor:pointer; font-family:var(--vscode-editor-font-family, monospace); white-space:nowrap; }
  .trace-loc:hover { color:var(--vscode-badge-foreground); border-color:var(--vscode-focusBorder); }
  .section { border-top:1px solid var(--border); padding:10px 0 8px; }
  .section:last-child { border-bottom:1px solid var(--border); }
  .section .section-head { display:flex; align-items:center; gap:9px; width:100%; margin:0; background:none; border:0; padding:0; color:inherit; font:inherit; text-align:left; cursor:default; }
  .section .section-head[data-toggle] { cursor:pointer; }
  .section-title { font-weight:650; font-size:12.5px; flex:1; line-height:1.35; }
  .section-chevron { display:flex; color:var(--muted); transition:transform .12s ease; }
  .section[data-open="true"] .section-chevron { transform:rotate(90deg); }
  .section-summary { color:var(--muted); line-height:1.45; margin:5px 0 0 28px; font-size:11.5px; }
  .section-children { margin:8px 0 0 9px; padding-left:15px; border-left:1px solid var(--border); display:none; }
  .section[data-open="true"] .section-children { display:block; }
  /* Nested execution flow tree */
  .flow-node { position:relative; padding-left:16px; }
  .flow-node::before { content:""; position:absolute; left:0; top:0; bottom:0; width:1px; background:var(--border); }
  .flow-node:last-child::before { bottom:auto; height:13px; }
  .flow-node::after { content:""; position:absolute; left:0; top:12px; width:11px; height:1px; background:var(--border); }
  .flow-branch { margin-top:2px; }
  .flow-step { padding-top:5px; padding-bottom:5px; }
  .flow-step[data-file] { cursor:pointer; }
  .step-card { border-radius:5px; padding:2px 4px; transition:background .1s ease; }
  .flow-step[data-file] > .step-card:hover { background:var(--vscode-list-hoverBackground); }
  .step-head { display:flex; align-items:center; gap:8px; }
  .sub-num { display:flex; align-items:center; justify-content:center; min-width:20px; height:17px; padding:0 5px; border-radius:9px; font-size:9.5px; font-weight:700; color:var(--vscode-badge-foreground); background:var(--vscode-badge-background); border:1px solid var(--border); font-family:var(--vscode-editor-font-family, monospace); }
  .sub-title { font-weight:550; font-size:11.5px; flex:1; line-height:1.35; }
  .sub-summary { color:var(--muted); line-height:1.45; margin:3px 0 0 28px; font-size:11px; }
  .flow-label { padding-top:6px; padding-bottom:2px; }
  .flow-label-text { color:var(--muted); font-size:11px; font-family:var(--vscode-editor-font-family, monospace); }
  .source-line { margin:5px 0 0 28px; padding:6px 8px; overflow-x:auto; color:var(--vscode-editor-foreground); background:var(--vscode-textCodeBlock-background); border:1px solid var(--border); border-radius:4px; font:10.5px/1.5 var(--vscode-editor-font-family, monospace); white-space:pre; tab-size:2; }
  .source-line code { display:block; }
  .expandable.collapsed { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; }
  .see-more { margin:3px 0 0 28px; padding:0; border:0; color:var(--vscode-textLink-foreground); background:transparent; font-size:10.5px; cursor:pointer; }
  .see-more:hover { text-decoration:underline; }
  .guide { display:none; margin:8px 0 2px 28px; padding:8px 10px; border-left:2px solid var(--accent); background:var(--vscode-textBlockQuote-background, transparent); font-size:11px; line-height:1.5; }
  .guide[data-open="true"] { display:block; }
  .guide strong { display:block; margin:0 0 2px; color:var(--vscode-foreground); font-size:10.5px; text-transform:uppercase; }
  .guide-toggle { margin:5px 0 0 28px; padding:0; border:0; color:var(--vscode-textLink-foreground); background:transparent; font-size:10.5px; cursor:pointer; }
  .guide-toggle:hover { text-decoration:underline; }
</style></head><body>
  ${this.detail ? this.detailBody(this.detail) : this.listBody({ cards, suggestions, backend, kind, model, progress, favoriteCount })}
<script type="module" nonce="${nonce}">
  ${this.detail ? 'import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs";' : ""}
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
    favoriteCount: number;
  }): string {
    const { cards, suggestions, backend, kind, model, progress, favoriteCount } = ctx;
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
  <div class="intensity" role="group" aria-label="Suggestion difficulty" title="Filter suggestion difficulty">
    ${INTENSITY_LEVELS.map(
      (level) =>
        `<button class="intensity-opt" data-intensity="${level.id}" aria-pressed="${
          this.suggestionIntensity === level.id ? "true" : "false"
        }" title="${level.hint}"${this.suggestionsLoading ? " disabled" : ""}>${level.label}</button>`,
    ).join("")}
  </div>
  <section class="suggestions">
    ${this.suggestionsLoading ? `<div class="suggestion-state"><span class="mini-spinner"></span>Asking the model...</div>` : suggestions}
    ${!this.suggestionsLoading && this.suggestionsError ? `<div class="suggestion-state">${escapeHtml(this.suggestionsError)}</div>` : ""}
    ${!this.suggestionsLoading && !this.suggestionsError && !suggestions ? `<div class="suggestion-state">Generate ideas based on this repository.</div>` : ""}
  </section>
  <div class="section-head library-head">
    <h3>Your Codemaps <span class="count">${this.codemaps.length}</span></h3>
    <div class="library-filter" role="group" aria-label="Filter codemaps">
      <button class="filter-opt" data-filter="all" aria-pressed="true">All</button>
      <button class="filter-opt" data-filter="favorites" aria-pressed="false" ${favoriteCount ? "" : "disabled"}>${ICON.starFilled}<span>Favorites</span>${favoriteCount ? `<span class="filter-count">${favoriteCount}</span>` : ""}</button>
    </div>
  </div>
  <div class="library-search">
    <span class="library-search-icon">${ICON.search}</span>
    <input id="library-search" type="text" placeholder="Search codemaps" autocomplete="off" spellcheck="false" ${this.codemaps.length ? "" : "disabled"} />
  </div>
  <main id="library">${cards || `<div class="empty">No codemaps found for this repository.</div>`}</main>
  <div class="library-empty" id="library-empty" hidden>No codemaps match your search.</div>`;
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
    const graph = buildGraphModel(codemap);
    const hasDiagram = Boolean(codemap.diagram?.content);
    // The raw artifact surfaced by the JSON view: graph + trace steps + evidence.
    const artifact = {
      id: codemap.id,
      query: codemap.query,
      version: codemap.version,
      overview: codemap.overview ?? "",
      graph,
      traces: codemap.traces,
      diagram: codemap.diagram ?? null,
    };
    return `
  <div class="detail-head">
    <button class="back" id="back">${ICON.back}<span>Codemaps</span></button>
    <div class="detail-actions">
      <button class="icon-btn" id="detail-chat" title="Ask a question" aria-label="Ask a question" aria-expanded="false">${ICON.chat}</button>
      <button class="icon-btn" id="open-editor" title="Open full map in editor">${ICON.expand}</button>
      <button class="icon-btn" id="detail-quiz" title="Quiz me">${ICON.quiz}</button>
    </div>
  </div>
  <h2 class="detail-title">${escapeHtml(codemap.query)}</h2>
  <div class="detail-meta">${escapeHtml(codemap.model.backend)} · ${escapeHtml(codemap.model.model_name)} · ${escapeHtml(codemap.model.mode)} · ${date}</div>
  <div class="view-tabs" role="tablist" aria-label="Codemap view">
    ${VIEW_MODES.map(
      (mode) =>
        `<button class="view-tab" role="tab" data-view="${mode.id}" aria-selected="${
          mode.id === "overview" ? "true" : "false"
        }" title="${mode.hint}">${VIEW_MODE_ICONS[mode.id]}<span>${mode.label}</span></button>`,
    ).join("")}
  </div>
  <div class="view-panel" id="view-overview" data-view="overview">
    ${overview}
    <main>${rows || `<div class="empty">This codemap has no traces.</div>`}</main>
  </div>
  <div class="view-panel" id="view-diagram" data-view="diagram" hidden>
    ${
      hasDiagram
        ? `<div class="mermaid-toolbar">
      <span class="graph-count">Click a node to open its code</span>
      <div class="mermaid-controls">
        <button class="icon-btn" id="mermaid-zoom-in" title="Zoom in">${ICON.zoomIn}</button>
        <button class="icon-btn" id="mermaid-zoom-out" title="Zoom out">${ICON.zoomOut}</button>
        <button class="icon-btn" id="mermaid-reset" title="Reset view">${ICON.home}</button>
        <button class="icon-btn" id="mermaid-expand" title="Fullscreen" aria-pressed="false">${ICON.maximize}</button>
      </div>
    </div>
    <div class="mermaid-view" id="mermaid-view">
      <div class="diagram-stage" id="mermaid-stage"><div class="diagram-loading">Rendering diagram...</div></div>
    </div>`
        : `<div class="diagram-error">This codemap does not include a diagram.</div>`
    }
  </div>
  <div class="view-panel" id="view-json" data-view="json" hidden>
    <div class="json-toolbar">
      <span class="graph-count">Raw codemap data</span>
      <button class="icon-btn" id="json-copy" title="Copy JSON">${ICON.copy}</button>
    </div>
    <pre class="json-view" id="json-view"><code>${escapeHtml(JSON.stringify(artifact, null, 2))}</code></pre>
  </div>
  <div class="chat-popover" id="chat" role="dialog" aria-label="Ask a question about this codemap" hidden>
    <div class="chat-popover-head">
      <span class="chat-popover-title">Ask a question</span>
      <button class="icon-btn" id="chat-close" title="Close" aria-label="Close">${ICON.close}</button>
    </div>
    <div class="chat-thread" id="chat-thread"><div class="chat-empty" id="chat-empty">Ask anything about this codemap. Answers cite real files.</div></div>
    <form class="chat-form" id="chat-form">
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="Ask a question"></textarea>
      <div class="chat-form-actions">
        <button class="chat-context" id="chat-context" type="button" title="Attach codemap context" aria-pressed="true">@ ${escapeHtml(shortTitle(codemap.query))}</button>
        <button class="chat-send" id="chat-send" type="submit" title="Send" aria-label="Send">${ICON.send}</button>
      </div>
    </form>
  </div>`;
  }

  private listScript(): string {
    return `
  const query = document.getElementById('query');
  const previous = vscode.getState();
  if (previous?.query) query.value = previous.query;
  query.addEventListener('input', () => vscode.setState({ query: query.value }));
  document.getElementById('generate').addEventListener('click', () => vscode.postMessage({ type:'generate', query:query.value }));
  document.getElementById('model').addEventListener('click', () => vscode.postMessage({ type:'selectModel' }));
  let selectedIntensity = document.querySelector('.intensity-opt[aria-pressed="true"]')?.dataset.intensity || 'intermediate';
  document.getElementById('suggest').addEventListener('click', () => vscode.postMessage({ type:'suggest', intensity:selectedIntensity }));
  for (const opt of document.querySelectorAll('.intensity-opt')) opt.addEventListener('click', () => {
    selectedIntensity = opt.dataset.intensity;
    for (const other of document.querySelectorAll('.intensity-opt')) other.setAttribute('aria-pressed', other === opt ? 'true' : 'false');
    vscode.postMessage({ type:'suggest', intensity:selectedIntensity });
  });
  query.addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') vscode.postMessage({ type:'generate', query:query.value }); });

  const cards = Array.from(document.querySelectorAll('.map-card'));
  for (const card of cards) {
    card.addEventListener('click', (event) => {
      if (event.target.closest('.map-act')) return;
      vscode.postMessage({ type:'open', id:card.dataset.id });
    });
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); vscode.postMessage({ type:'open', id:card.dataset.id }); } });
  }
  for (const button of document.querySelectorAll('.map-act')) button.addEventListener('click', (event) => {
    event.stopPropagation();
    const act = button.dataset.act;
    if (act === 'delete') vscode.postMessage({ type:'delete', id:button.dataset.id });
    else if (act === 'favorite') vscode.postMessage({ type:'favorite', id:button.dataset.id });
    else if (act === 'quiz') vscode.postMessage({ type:'quiz', id:button.dataset.id });
  });

  // Client-side library filtering: search text + All/Favorites toggle.
  const search = document.getElementById('library-search');
  const emptyState = document.getElementById('library-empty');
  const filterOpts = Array.from(document.querySelectorAll('.filter-opt'));
  let activeFilter = 'all';
  function applyLibraryFilter() {
    const term = (search?.value || '').trim().toLowerCase();
    let visible = 0;
    for (const card of cards) {
      const matchText = !term || (card.dataset.title || '').includes(term);
      const matchFav = activeFilter !== 'favorites' || card.dataset.favorite === 'true';
      const show = matchText && matchFav;
      card.hidden = !show;
      if (show) visible++;
    }
    if (emptyState) emptyState.hidden = visible !== 0 || cards.length === 0;
  }
  search?.addEventListener('input', applyLibraryFilter);
  for (const opt of filterOpts) opt.addEventListener('click', () => {
    if (opt.disabled) return;
    activeFilter = opt.dataset.filter;
    for (const other of filterOpts) other.setAttribute('aria-pressed', other === opt ? 'true' : 'false');
    applyLibraryFilter();
  });

  for (const suggestion of document.querySelectorAll('.suggestion')) suggestion.addEventListener('click', () => {
    query.value = suggestion.dataset.query;
    vscode.setState({ query: query.value });
    query.focus();
  });`;
  }

  private detailScript(): string {
    const id = this.detail ? escapeHtml(this.detail.id) : "";
    const diagramSource = JSON.stringify(this.detail?.diagram?.content ?? "");
    const diagramLocations = JSON.stringify(traceLocationMap(this.detail?.traces ?? []));
    return `
  document.getElementById('back').addEventListener('click', () => vscode.postMessage({ type:'back' }));
  document.getElementById('open-editor').addEventListener('click', () => vscode.postMessage({ type:'openEditor', id:'${id}' }));
  document.getElementById('detail-quiz').addEventListener('click', () => vscode.postMessage({ type:'quiz', id:'${id}' }));
  // Accordion: open one section at a time; open the first section by default.
  const sections = Array.from(document.querySelectorAll('.section'));
  let expandedSectionId = null;
  function setExpandedSection(id) {
    expandedSectionId = expandedSectionId === id ? null : id;
    for (const section of sections) {
      section.dataset.open = section.dataset.section === expandedSectionId ? 'true' : 'false';
    }
  }
  const firstToggle = document.querySelector('.section-head[data-toggle]');
  if (firstToggle) setExpandedSection(firstToggle.closest('.section').dataset.section);
  for (const head of document.querySelectorAll('.section-head[data-toggle]')) head.addEventListener('click', (event) => {
    if (event.target.closest('.trace-loc')) return;
    setExpandedSection(head.closest('.section').dataset.section);
  });
  for (const loc of document.querySelectorAll('.trace-loc')) loc.addEventListener('click', (event) => {
    event.stopPropagation();
    vscode.postMessage({
      type:'reveal',
      location:{ file: loc.dataset.file, start_line: Number(loc.dataset.start), end_line: Number(loc.dataset.end) }
    });
  });
  // Clicking anywhere on a step card jumps to its file:line in the editor.
  for (const step of document.querySelectorAll('.flow-step[data-file]')) step.addEventListener('click', (event) => {
    if (event.target.closest('.trace-loc') || event.target.closest('.see-more')) return;
    vscode.postMessage({
      type:'reveal',
      location:{ file: step.dataset.file, start_line: Number(step.dataset.start), end_line: Number(step.dataset.end) }
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

  // --- View modes: overview / graph / mermaid / json ---
  const diagramSource = ${diagramSource};
  const diagramLocations = ${diagramLocations};
  const viewTabs = Array.from(document.querySelectorAll('.view-tab'));
  const viewPanels = Array.from(document.querySelectorAll('.view-panel'));
  let viewMode = 'overview';
  let mermaidRendered = false;

  const revealNode = (el) => {
    if (!el?.dataset?.file) return;
    vscode.postMessage({ type:'reveal', location:{ file: el.dataset.file, start_line: Number(el.dataset.start), end_line: Number(el.dataset.end) } });
  };

  // Reusable pan/zoom controller for a scrollable stage inside a viewport.
  function makePanZoom(viewId, stageId) {
    const view = document.getElementById(viewId);
    const stage = document.getElementById(stageId);
    if (!view || !stage) return { reset(){}, zoom(){} };
    let scale = 1, x = 0, y = 0, drag = null;
    const apply = () => { stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')'; };
    const reset = () => { scale = 1; x = 0; y = 0; apply(); };
    const zoom = (next) => { scale = Math.min(2.5, Math.max(.35, next)); apply(); };
    view.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button, .node, .graph-node')) return;
      drag = { x:event.clientX, y:event.clientY, startX:x, startY:y };
      view.dataset.dragging = 'true';
      view.setPointerCapture(event.pointerId);
    });
    view.addEventListener('pointermove', (event) => {
      if (!drag) return;
      x = drag.startX + event.clientX - drag.x;
      y = drag.startY + event.clientY - drag.y;
      apply();
    });
    view.addEventListener('pointerup', (event) => { drag = null; view.dataset.dragging = 'false'; view.releasePointerCapture(event.pointerId); });
    view.addEventListener('wheel', (event) => { event.preventDefault(); zoom(scale + (event.deltaY < 0 ? .1 : -.1)); }, { passive:false });
    return { reset, zoom, get scale(){ return scale; } };
  }

  // Diagram view: rendered, interactive mermaid diagram.
  const mermaidStage = document.getElementById('mermaid-stage');
  const mermaidPan = makePanZoom('mermaid-view', 'mermaid-stage');
  function mermaidTraceId(node) {
    const raw = String(node?.id || '').replace(/^flowchart-/, '').replace(/-\\d+$/, '');
    const label = (node?.textContent || '').trim().match(/^(?:t)?(\\d+[a-z]?)/i)?.[1] || '';
    return [raw, raw.replace(/^t/, ''), label, label ? 't' + label : ''].find((key) => diagramLocations[key]);
  }
  function wireMermaidNodes() {
    if (!mermaidStage) return;
    for (const node of mermaidStage.querySelectorAll('.node')) {
      const key = mermaidTraceId(node);
      if (!key) continue;
      node.setAttribute('tabindex', '0');
      node.setAttribute('role', 'button');
      const open = () => vscode.postMessage({ type:'reveal', location:diagramLocations[key] });
      node.addEventListener('click', (event) => { event.stopPropagation(); open(); });
      node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
    }
  }
  async function renderMermaid() {
    if (mermaidRendered || !mermaidStage || !diagramSource) return;
    mermaidRendered = true;
    try {
      const dark = document.body.classList.contains('vscode-dark') || matchMedia('(prefers-color-scheme: dark)').matches;
      mermaid.initialize({ startOnLoad:false, theme:dark ? 'dark' : 'default', securityLevel:'strict', flowchart:{ useMaxWidth:false, htmlLabels:false } });
      const result = await mermaid.render('roots-sidebar-graph', diagramSource);
      mermaidStage.innerHTML = result.svg;
      wireMermaidNodes();
      mermaidPan.reset();
    } catch (error) {
      mermaidStage.innerHTML = '<div class="diagram-error">Diagram could not be rendered: ' + escapeText(error?.message || error) + '</div>';
    }
  }
  document.getElementById('mermaid-zoom-in')?.addEventListener('click', () => mermaidPan.zoom(mermaidPan.scale + .15));
  document.getElementById('mermaid-zoom-out')?.addEventListener('click', () => mermaidPan.zoom(mermaidPan.scale - .15));
  document.getElementById('mermaid-reset')?.addEventListener('click', () => mermaidPan.reset());
  const mermaidExpand = document.getElementById('mermaid-expand');
  mermaidExpand?.addEventListener('click', () => {
    const panel = document.getElementById('view-diagram');
    const full = panel.classList.toggle('fullscreen');
    mermaidExpand.classList.toggle('is-active', full);
    mermaidExpand.setAttribute('aria-pressed', String(full));
  });

  // Copy helpers (mermaid source + json artifact).
  function flashCopied(button) {
    const original = button.innerHTML;
    button.innerHTML = ${JSON.stringify(ICON.check)};
    button.classList.add('is-active');
    setTimeout(() => { button.innerHTML = original; button.classList.remove('is-active'); }, 1200);
  }
  function copyText(text, button) {
    const done = () => flashCopied(button);
    if (navigator.clipboard?.writeText) { navigator.clipboard.writeText(text).then(done).catch(done); return; }
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta); done();
  }
  const jsonView = document.getElementById('json-view');
  document.getElementById('json-copy')?.addEventListener('click', (event) => copyText(jsonView?.textContent || '', event.currentTarget));

  function setViewMode(next) {
    viewMode = next;
    for (const tab of viewTabs) tab.setAttribute('aria-selected', String(tab.dataset.view === next));
    for (const panel of viewPanels) panel.hidden = panel.dataset.view !== next;
    if (next !== 'diagram') document.getElementById('view-diagram')?.classList.remove('fullscreen');
    if (next === 'diagram') void renderMermaid();
  }
  for (const tab of viewTabs) tab.addEventListener('click', () => setViewMode(tab.dataset.view));

  // --- Chat / Ask a question ---
  const chatThread = document.getElementById('chat-thread');
  const chatEmpty = document.getElementById('chat-empty');
  const chatForm = document.getElementById('chat-form');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');
  const chatSection = document.getElementById('chat');
  const chatButton = document.getElementById('detail-chat');
  const chatClose = document.getElementById('chat-close');
  const chatContext = document.getElementById('chat-context');
  let isChatOpen = false;
  let attachContext = true;
  let requestSeq = 0;
  const pending = new Map();
  const baseNameOf = (p) => (p || '').split(/[\\\\/]/).pop() || p;
  const escapeText = (s) => { const d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };
  function renderMarkdown(value) {
    const blocks = [];
    let text = String(value == null ? '' : value).replace(/\\r\\n?/g, '\\n');
    text = text.replace(/\`\`\`(?:[^\\n]*)\\n([\\s\\S]*?)\`\`\`/g, (_match, code) => {
      const token = '@@ROOTS_BLOCK_' + blocks.length + '@@';
      blocks.push('<pre><code>' + escapeText(code.replace(/\\n$/, '')) + '</code></pre>');
      return token;
    });
    text = escapeText(text)
      .replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>')
      .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
      .replace(/__([^_\\n]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>')
      .replace(/\\[([^\\]\\n]+)\\]\\((https?:\\/\\/[A-Za-z0-9._~:/?#@!$%*+,;=-]+)\\)/g, '<a href="$2">$1</a>');
    const lines = text.split('\\n');
    let html = '';
    let list = '';
    const closeList = () => { if (list) { html += '</' + list + '>'; list = ''; } };
    for (const line of lines) {
      const unordered = line.match(/^\\s*[-*+]\\s+(.+)$/);
      const ordered = line.match(/^\\s*\\d+[.)]\\s+(.+)$/);
      if (unordered || ordered) {
        const next = unordered ? 'ul' : 'ol';
        if (list !== next) { closeList(); list = next; html += '<' + list + '>'; }
        html += '<li>' + (unordered || ordered)[1] + '</li>';
      } else {
        closeList();
        if (/^@@ROOTS_BLOCK_\\d+@@$/.test(line)) html += line;
        else if (line.trim()) html += '<p>' + line + '</p>';
      }
    }
    closeList();
    return blocks.reduce((result, block, index) => result.replace('@@ROOTS_BLOCK_' + index + '@@', block), html);
  }

  function setChatOpen(next) {
    isChatOpen = next;
    chatSection.hidden = !next;
    if (chatButton) chatButton.setAttribute('aria-expanded', String(next));
    if (next) requestAnimationFrame(() => chatInput.focus());
  }
  if (chatButton) chatButton.addEventListener('click', () => setChatOpen(!isChatOpen));
  if (chatClose) chatClose.addEventListener('click', () => setChatOpen(false));
  if (chatContext) chatContext.addEventListener('click', () => {
    attachContext = !attachContext;
    chatContext.setAttribute('aria-pressed', String(attachContext));
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && isChatOpen) setChatOpen(false); });

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
    vscode.postMessage({ type:'ask', requestId, question, attachContext });
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
    let html = '<div class="markdown">' + renderMarkdown(msg.answer) + '</div>';
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

/**
 * A top-level section (numbered 1, 2, 3…) rendered as an accordion item.
 * Sections start collapsed; the client opens one at a time (see detailScript).
 */
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
    .map((child, i) => flowNode(child, `${num}${String.fromCharCode(97 + i)}`, byId, snippets))
    .join("");
  const collapsible = subs ? `<div class="section-children flow-tree">${subs}</div>` : "";
  return `<section class="section" data-open="false" data-section="${num}">
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

/**
 * One node in the nested execution flow tree. Recurses through `children` so
 * lifecycle hooks (e.g. onData → handleMessage) render as connected tree
 * labels beneath concrete step cards. A node is a "step" when it resolves to a
 * real location/snippet, otherwise it is a muted lifecycle label.
 */
function flowNode(
  trace: Trace,
  label: string,
  byId: Map<string, Trace>,
  snippets: Map<string, string>
): string {
  const children = (trace.children ?? [])
    .map((id) => byId.get(id))
    .filter((c): c is Trace => Boolean(c));
  const nested = children
    .map((child, i) => flowNode(child, `${label}${String.fromCharCode(97 + i)}`, byId, snippets))
    .join("");
  const snippet = snippets.get(trace.id);
  const loc = trace.locations?.[0];
  const isStep = Boolean(loc || snippet);
  const nestedHtml = nested ? `<div class="flow-branch">${nested}</div>` : "";

  if (isStep) {
    return `<div class="flow-node flow-step" data-step="1"${
      loc
        ? ` data-file="${escapeHtml(loc.file)}" data-start="${loc.start_line}" data-end="${loc.end_line}"`
        : ""
    }>
      <div class="step-card">
        <div class="step-head">
          <span class="sub-num">${escapeHtml(label)}</span>
          <span class="sub-title">${escapeHtml(trace.title)}</span>
          ${locTagHtml(loc)}
        </div>
        ${summaryHtml(trace.summary, "sub-summary")}
        ${snippet ? `<pre class="source-line"><code>${escapeHtml(snippet)}</code></pre>` : ""}
      </div>
      ${nestedHtml}
    </div>`;
  }

  // Lifecycle label: a muted, connected tree node with no code card.
  return `<div class="flow-node flow-label">
    <span class="flow-label-text">${escapeHtml(trace.title)}</span>
    ${nestedHtml}
  </div>`;
}

function summaryHtml(summary: string, className: string): string {
  if (!summary) return "";
  const long = summary.length > 180;
  return `<div class="markdown ${className}${long ? " expandable collapsed" : ""}">${renderMarkdown(summary)}</div>${
    long ? '<button class="see-more">See more</button>' : ""
  }`;
}

function guideHtml(trace: Trace): string {
  const motivation = trace.motivation
    ? `<strong>Motivation</strong><div class="markdown">${renderMarkdown(trace.motivation)}</div>`
    : "";
  const details = trace.details
    ? `<strong>Details</strong><div class="markdown">${renderMarkdown(trace.details)}</div>`
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
  return `<div class="markdown">${renderMarkdown(text).replace(/\[([^\]]+)\]/g, (_m, id: string) => {
    const loc = byId.get(id)?.locations?.[0];
    if (!loc) return `<span class="ref">${escapeHtml(id)}</span>`;
    return `<span class="ref ref-link" data-file="${escapeHtml(loc.file)}" data-start="${loc.start_line}" data-end="${loc.end_line}" title="Open ${escapeHtml(baseName(loc.file))}:${loc.start_line}">${escapeHtml(id)}</span>`;
  })}</div>`;
}

function renderMarkdown(value: string): string {
  const blocks: string[] = [];
  let text = value.replace(/\r\n?/g, "\n");
  text = text.replace(/```(?:[^\n]*)\n([\s\S]*?)```/g, (_match, code: string) => {
    const token = `@@ROOTS_BLOCK_${blocks.length}@@`;
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return token;
  });
  text = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[A-Za-z0-9._~:/?#@!$%*+,;=-]+)\)/g, '<a href="$2">$1</a>');

  const lines = text.split("\n");
  let html = "";
  let list: "ul" | "ol" | "" = "";
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = "";
  };
  for (const line of lines) {
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const next = unordered ? "ul" : "ol";
      if (list !== next) {
        closeList();
        list = next;
        html += `<${list}>`;
      }
      html += `<li>${(unordered ?? ordered)?.[1] ?? ""}</li>`;
    } else {
      closeList();
      if (/^@@ROOTS_BLOCK_\d+@@$/.test(line)) html += line;
      else if (line.trim()) html += `<p>${line}</p>`;
    }
  }
  closeList();
  return blocks.reduce((result, block, index) => result.replace(`@@ROOTS_BLOCK_${index}@@`, block), html);
}

function codemapCard(codemap: Codemap, favorite: boolean): string {
  const date = new Date(codemap.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const id = escapeHtml(codemap.id);
  const title = escapeHtml(codemap.query);
  return `<article class="map-card${favorite ? " is-favorite" : ""}" data-id="${id}" data-title="${title.toLowerCase()}" data-favorite="${favorite}" role="button" tabindex="0">
    <div class="map-main">
      <span class="map-title">${title}</span>
      <span class="map-meta">${date} · ${codemap.traces.length} steps · <span class="map-model">${escapeHtml(codemap.model.model_name)}</span></span>
    </div>
    <div class="map-actions">
      <button class="map-act star${favorite ? " is-active" : ""}" data-id="${id}" data-act="favorite" title="${favorite ? "Remove favorite" : "Add to favorites"}" aria-pressed="${favorite}">${favorite ? ICON.starFilled : ICON.star}</button>
      <button class="map-act" data-id="${id}" data-act="quiz" title="Quiz me">${ICON.quiz}</button>
      <button class="map-act danger" data-id="${id}" data-act="delete" title="Delete codemap">${ICON.trash}</button>
    </div>
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

/** The detail-view representations, in tab order. */
const VIEW_MODES: ReadonlyArray<{ id: CodemapViewMode; label: string; hint: string }> = [
  { id: "overview", label: "Overview", hint: "Human-readable summary, architecture, and trace guide" },
  { id: "diagram", label: "Diagram", hint: "Interactive diagram — click a node to jump to its code" },
  { id: "json", label: "JSON", hint: "Raw codemap data" },
];

/** Difficulty tiers for repository suggestions. */
const INTENSITY_LEVELS: ReadonlyArray<{ id: SuggestionIntensity; label: string; hint: string }> = [
  { id: "foundational", label: "Basic", hint: "Entry points and newcomer-friendly flows" },
  { id: "intermediate", label: "Intermediate", hint: "End-to-end paths across a few modules" },
  { id: "advanced", label: "Advanced", hint: "Concurrency, streaming, IPC/RPC, state machines" },
];

/** Lucide-style inline icons (stroke follows currentColor). */
const ICON = {
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M8 16H3v5"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  quiz: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`,
  diagram: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 7v4M5 17v-2h14v2M7 19h10"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  zoomIn: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M11 8v6M8 11h6"/></svg>`,
  zoomOut: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3M8 11h6"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></svg>`,
  send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  code: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></svg>`,
  braces: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>`,
  maximize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
  star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3.6a.6.6 0 0 1 1 0l2.3 4.7 5.2.8a.6.6 0 0 1 .3 1L16.9 14l.9 5.2a.6.6 0 0 1-.9.6L12 17.3l-4.6 2.5a.6.6 0 0 1-.9-.6l.9-5.2-3.8-3.7a.6.6 0 0 1 .3-1l5.2-.8Z"/></svg>`,
  starFilled: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 3.6a.6.6 0 0 1 1 0l2.3 4.7 5.2.8a.6.6 0 0 1 .3 1L16.9 14l.9 5.2a.6.6 0 0 1-.9.6L12 17.3l-4.6 2.5a.6.6 0 0 1-.9-.6l.9-5.2-3.8-3.7a.6.6 0 0 1 .3-1l5.2-.8Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>`,
} as const;

/** Icon per view-mode tab (kept beside ICON so it can reference it). */
const VIEW_MODE_ICONS: Record<CodemapViewMode, string> = {
  overview: ICON.list,
  diagram: ICON.diagram,
  json: ICON.braces,
};

/**
 * Derive a node/edge graph artifact from the codemap's trace tree. Each trace
 * becomes a node carrying its metadata (file, line range, role, confidence);
 * parent→child links become typed `flow` edges; top-level traces define
 * collapsible subgraphs. This is the model rendered by the graph and JSON views.
 */
function buildGraphModel(codemap: Codemap): CodemapGraph {
  const traces = codemap.traces ?? [];
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const childIds = new Set(traces.flatMap((trace) => trace.children ?? []));
  const roots = traces.filter((trace) => !childIds.has(trace.id));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const subgraphs: GraphSubgraph[] = [];
  const seen = new Set<string>();

  const kindFor = (trace: Trace): string => {
    const loc = trace.locations?.[0];
    if (!loc) return "concept";
    if (trace.confidence?.location_evidence === "symbol") return "symbol";
    return "location";
  };
  const roleFor = (trace: Trace, depth: number): string => {
    if (depth === 0) return "section";
    return trace.locations?.[0] ? "step" : "lifecycle";
  };
  const confidenceFor = (trace: Trace): number => {
    if (typeof trace.confidence?.summary_grounded === "number") return trace.confidence.summary_grounded;
    if (trace.confidence?.location_verified) return 1;
    if (trace.locations?.[0]) return 0.6;
    return 0.3;
  };

  const walk = (trace: Trace, label: string, depth: number, subgraphId: string): void => {
    if (seen.has(trace.id)) return;
    seen.add(trace.id);
    const loc = trace.locations?.[0];
    nodes.push({
      id: trace.id,
      label: trace.title,
      kind: kindFor(trace),
      file: loc?.file,
      range: loc ? { start: loc.start_line, end: loc.end_line } : undefined,
      role: roleFor(trace, depth),
      confidence: confidenceFor(trace),
      subgraph: subgraphId,
    });
    (trace.children ?? []).forEach((childId, index) => {
      const child = byId.get(childId);
      if (!child) return;
      edges.push({ from: trace.id, to: child.id, type: "flow" });
      walk(child, `${label}${String.fromCharCode(97 + index)}`, depth + 1, subgraphId);
    });
  };

  roots.forEach((trace, index) => {
    const subgraphId = `sg_${trace.id}`;
    subgraphs.push({ id: subgraphId, label: trace.title });
    walk(trace, String(index + 1), 0, subgraphId);
  });

  return { nodes, edges, subgraphs };
}

function traceLocationMap(traces: Trace[]): Record<string, Trace["locations"][number]> {
  const result: Record<string, Trace["locations"][number]> = {};
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const childIds = new Set(traces.flatMap((trace) => trace.children ?? []));
  const roots = traces.filter((trace) => !childIds.has(trace.id));
  const add = (trace: Trace, label: string) => {
    const location = trace.locations?.[0];
    if (location) {
      result[trace.id] = location;
      result[trace.id.replace(/^t/, "")] = location;
      result[label] = location;
      result[`t${label}`] = location;
    }
    (trace.children ?? []).forEach((id, index) => {
      const child = byId.get(id);
      if (child) add(child, `${label}${String.fromCharCode(97 + index)}`);
    });
  };
  roots.forEach((trace, index) => add(trace, String(index + 1)));
  return result;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/** Compact a codemap query into a short context-chip label. */
function shortTitle(query: string): string {
  const trimmed = query.trim();
  return trimmed.length > 32 ? `${trimmed.slice(0, 31)}…` : trimmed;
}