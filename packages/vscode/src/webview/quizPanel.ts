import * as vscode from "vscode";
import type { Codemap, Confidence, Location, Trace } from "../engineClient.js";

/**
 * A single active-recall prompt derived from one verified trace.
 * Mirror of the engine's `Question` (kept local — the quiz is deterministic and
 * model-free, so the adapter reshapes trace data directly rather than paying for
 * a subprocess round-trip).
 */
export interface Question {
  trace_id: string;
  prompt: string;
  answer: string;
  locations: Location[];
  confidence: Confidence;
}

export interface QuizOptions {
  groundingThreshold?: number;
  limit?: number;
  requireSymbolEvidence?: boolean;
}

const DEFAULT_GROUNDING_THRESHOLD = 0.6;

/**
 * The integrity gate — a question is NEVER drawn from a node the tool isn't sure
 * about. Kept identical to the engine's `isQuizEligible` so the in-editor quiz
 * makes the same honesty promise the engine does.
 */
export function isQuizEligible(trace: Trace, opts: QuizOptions = {}): boolean {
  const c = trace.confidence;
  if (!c || !c.location_verified) return false;
  if (opts.requireSymbolEvidence && c.location_evidence !== "symbol") return false;
  if (typeof c.summary_grounded === "number") {
    const threshold = opts.groundingThreshold ?? DEFAULT_GROUNDING_THRESHOLD;
    if (c.summary_grounded < threshold) return false;
  }
  return trace.title.trim().length > 0 && trace.locations.length > 0;
}

/** Reshape a verified codemap into active-recall questions. Deterministic. */
export function generateQuiz(codemap: Codemap, opts: QuizOptions = {}): Question[] {
  const eligible = codemap.traces.filter((t) => isQuizEligible(t, opts));
  const questions = eligible.map((t) => questionFromTrace(t));
  return typeof opts.limit === "number" ? questions.slice(0, Math.max(0, opts.limit)) : questions;
}

function questionFromTrace(trace: Trace): Question {
  const where = trace.locations.map((l) => `${l.file}:${l.start_line}-${l.end_line}`).join(", ");
  const answer = trace.summary.trim()
    ? `${trace.summary.trim()}\n\nLocation: ${where}`
    : `Location: ${where}`;
  return {
    trace_id: trace.id,
    prompt: `Where in the codebase does this happen: "${trace.title.trim()}"?`,
    answer,
    locations: trace.locations,
    confidence: trace.confidence!,
  };
}

/**
 * Active-recall quiz panel. The developer reads a prompt, tries to reconstruct
 * the answer from memory, then reveals roots' verified trace (with clickable
 * receipts) to check themselves. This is the differentiator: roots tests recall
 * rather than re-presenting an explanation.
 */
export class QuizPanel {
  private static current: QuizPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(codemap: Codemap): void {
    const questions = generateQuiz(codemap);
    if (questions.length === 0) {
      void vscode.window.showInformationMessage(
        "roots: no verified traces to quiz on yet. Generate a codemap whose locations verify first."
      );
      return;
    }

    if (QuizPanel.current) {
      QuizPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      QuizPanel.current.render(codemap, questions);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "roots.quiz",
      "roots — Recall",
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    QuizPanel.current = new QuizPanel(panel);
    QuizPanel.current.render(codemap, questions);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; repoRoot?: string; location?: Location }) => {
        if (msg?.type === "openLocation" && msg.repoRoot && msg.location) {
          void vscode.commands.executeCommand("roots.openLocation", msg.repoRoot, msg.location);
        } else if (msg?.type === "showBackends") {
          void vscode.commands.executeCommand("roots.showBackends");
        }
      },
      null,
      this.disposables
    );
  }

  private render(codemap: Codemap, questions: Question[]): void {
    this.panel.title = `roots — Recall: ${codemap.query.slice(0, 32)}`;
    this.panel.webview.html = this.html(codemap, questions);
  }

  private html(codemap: Codemap, questions: Question[]): string {
    const nonce = String(Math.random()).slice(2);

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
    margin: 0; padding: 0; line-height: 1.5;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; padding: 14px 18px;
    border-bottom: 1px solid var(--border);
    background: var(--vscode-editor-background);
  }
  h1 { font-size: 0.98rem; font-weight: 600; margin: 0; }
  .meta { color: var(--muted); font-size: 0.78rem; margin-top: 3px; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .progress { color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
  .link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent); font-size: 0.8rem; font-family: inherit;
  }
  .link-btn:hover { text-decoration: underline; }
  .content {
    max-width: 720px; margin: 0 auto;
    padding: 28px 18px 48px;
    display: flex; flex-direction: column; gap: 20px;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 20px;
    background: var(--vscode-editor-background);
  }
  .kicker {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 8px;
  }
  .prompt { font-size: 1.05rem; font-weight: 600; }
  .recall-hint { color: var(--muted); font-size: 0.85rem; margin-top: 10px; }

  .answer { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); }
  .answer[hidden] { display: none; }
  .answer-label {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 8px;
  }
  .answer-body { font-size: 0.92rem; white-space: pre-wrap; }

  .conf {
    display: inline-flex; align-items: center; margin-left: 8px;
    font-size: 0.66rem; font-weight: 600; letter-spacing: 0.02em;
    text-transform: uppercase; padding: 1px 7px;
    border-radius: 999px; border: 1px solid transparent; vertical-align: middle;
  }
  .conf-verified {
    color: var(--vscode-charts-green, #3fb950);
    border-color: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 10%, transparent);
  }
  .conf-located { color: var(--muted); border-color: var(--border); background: transparent; }
  .conf-grounded { margin-left: 6px; font-size: 0.68rem; color: var(--muted); }

  .locs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
  .loc {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.74rem; color: var(--muted);
    padding: 2px 7px; border: 1px solid var(--border);
    border-radius: 5px; cursor: pointer; background: transparent;
  }
  .loc:hover { color: var(--accent); border-color: var(--accent); }

  .controls { display: flex; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.82rem; padding: 6px 14px;
    border: 1px solid var(--border); border-radius: 7px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer;
  }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
  .btn.primary {
    border-color: var(--accent); color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .btn[hidden] { display: none; }
  .done {
    text-align: center; color: var(--muted); font-size: 0.9rem; padding: 24px 0;
  }
  .katex { font-size: 1em; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">
      <h1>Active recall</h1>
      <div class="meta">${escapeHtml(codemap.query)}</div>
    </div>
    <div class="header-right">
      <button class="link-btn" id="show-models" title="View available models">Models</button>
      <div class="progress" id="progress"></div>
    </div>
  </div>

  <div class="content">
    <div class="card" id="card">
      <div class="kicker" id="kicker">Question</div>
      <div class="prompt" id="prompt"></div>
      <div class="recall-hint">Try to reconstruct the answer from memory before revealing it.</div>

      <div class="answer" id="answer" hidden>
        <div class="answer-label">roots' verified trace</div>
        <div class="answer-body" id="answer-body"></div>
        <div class="locs" id="locs"></div>
      </div>

      <div class="controls">
        <button class="btn primary" id="reveal">Reveal answer</button>
        <button class="btn" id="next" hidden>Next question →</button>
      </div>
    </div>
    <div class="done" id="done" hidden>You've reviewed every verified trace in this codemap.</div>
  </div>

  <script type="module" nonce="${nonce}">
    import renderMathInElement from "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.mjs";

    const vscodeApi = acquireVsCodeApi();
    const questions = ${JSON.stringify(questions)};
    const repoRoot = ${JSON.stringify(codemap.repo.root)};

    const els = {
      card: document.getElementById("card"),
      kicker: document.getElementById("kicker"),
      prompt: document.getElementById("prompt"),
      answer: document.getElementById("answer"),
      answerBody: document.getElementById("answer-body"),
      locs: document.getElementById("locs"),
      reveal: document.getElementById("reveal"),
      next: document.getElementById("next"),
      progress: document.getElementById("progress"),
      done: document.getElementById("done"),
    };

    let index = 0;

    function confBadge(c) {
      if (!c) return "";
      let cls, text;
      if (c.location_evidence === "symbol") { cls = "conf conf-verified"; text = "verified"; }
      else { cls = "conf conf-located"; text = "located"; }
      let grounded = "";
      if (typeof c.summary_grounded === "number") {
        grounded = ' <span class="conf-grounded">' + Math.round(c.summary_grounded * 100) + '% grounded</span>';
      }
      return ' <span class="' + cls + '">' + text + '</span>' + grounded;
    }

    function loadQuestion() {
      const q = questions[index];
      els.kicker.innerHTML = "Question " + (index + 1) + confBadge(q.confidence);
      els.prompt.textContent = q.prompt;
      els.answerBody.textContent = q.answer;

      els.locs.innerHTML = "";
      for (const loc of q.locations) {
        const b = document.createElement("button");
        b.className = "loc";
        b.textContent = loc.file + ":" + loc.start_line + "-" + loc.end_line;
        b.addEventListener("click", () => {
          vscodeApi.postMessage({ type: "openLocation", repoRoot, location: loc });
        });
        els.locs.appendChild(b);
      }

      els.answer.hidden = true;
      els.reveal.hidden = false;
      els.next.hidden = true;
      els.progress.textContent = (index + 1) + " / " + questions.length;
      renderMath();
    }

    function reveal() {
      els.answer.hidden = false;
      els.reveal.hidden = true;
      els.next.hidden = false;
      renderMath();
    }

    function next() {
      index += 1;
      if (index >= questions.length) {
        els.card.hidden = true;
        els.done.hidden = false;
        els.progress.textContent = questions.length + " / " + questions.length;
        return;
      }
      loadQuestion();
    }

    function renderMath() {
      renderMathInElement(els.card, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
      });
    }

    els.reveal.addEventListener("click", reveal);
    els.next.addEventListener("click", next);
    document.getElementById("show-models").addEventListener("click", () => {
      vscodeApi.postMessage({ type: "showBackends" });
    });
    loadQuestion();
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    QuizPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
