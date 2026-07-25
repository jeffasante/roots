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
  private static extensionUri: vscode.Uri | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  /** Called once on activation so the panel can set its editor-tab icon. */
  static configure(extensionUri: vscode.Uri): void {
    QuizPanel.extensionUri = extensionUri;
  }

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
    if (QuizPanel.extensionUri) {
      const icon = vscode.Uri.joinPath(QuizPanel.extensionUri, "media", "roots-icon.png");
      panel.iconPath = { light: icon, dark: icon };
    }
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
  .title-row { display: flex; align-items: center; gap: 9px; }
  .brand-icon { display: inline-flex; color: var(--accent); }
  .brand-icon svg { width: 18px; height: 18px; display: block; }
  h1 { font-size: 0.98rem; font-weight: 600; margin: 0; }
  .meta {
    color: var(--muted); font-size: 0.78rem; margin-top: 4px;
    max-width: 60ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .header-right { display: flex; align-items: center; gap: 14px; }
  .progress {
    color: var(--muted); font-size: 0.78rem; font-variant-numeric: tabular-nums;
    padding: 2px 9px; border: 1px solid var(--border); border-radius: 999px;
  }
  .link-btn {
    display: inline-flex; align-items: center; gap: 5px;
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent); font-size: 0.8rem; font-family: inherit;
  }
  .link-btn:hover { text-decoration: underline; }
  .link-icon { width: 13px; height: 13px; }
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

  .attempt { margin-top: 16px; }
  .attempt[hidden] { display: none; }
  .attempt-label {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 8px;
  }
  .attempt textarea {
    width: 100%; min-height: 88px; resize: vertical;
    font-family: inherit; font-size: 0.9rem; line-height: 1.5;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--border));
    border-radius: 8px; padding: 10px 12px;
  }
  .attempt textarea:focus {
    outline: none; border-color: var(--accent);
  }
  .attempt textarea:disabled { opacity: 0.7; cursor: default; }

  /* Self-rating shown after reveal so the user grades their recall. */
  .rating { margin-top: 16px; }
  .rating[hidden] { display: none; }
  .rating-label {
    font-size: 0.72rem; font-weight: 600; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--muted); margin-bottom: 8px;
  }
  .rating-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .rate {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.82rem; padding: 6px 12px;
    border: 1px solid var(--border); border-radius: 999px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer;
  }
  .rate:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
  .rate .dot { width: 8px; height: 8px; border-radius: 50%; }
  .rate[data-score="missed"] .dot { background: var(--vscode-charts-red, #f85149); }
  .rate[data-score="partial"] .dot { background: var(--vscode-charts-yellow, #d29922); }
  .rate[data-score="recalled"] .dot { background: var(--vscode-charts-green, #3fb950); }
  .rate.selected { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }

  .overlap-hint {
    margin-top: 10px; font-size: 0.8rem; color: var(--muted);
  }
  .overlap-hint[hidden] { display: none; }
  .overlap-hint b { color: var(--vscode-foreground); font-weight: 600; }

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
    display: flex; flex-direction: column; align-items: center; gap: 16px;
  }
  .done[hidden] { display: none; }
  .score-headline { color: var(--vscode-foreground); font-size: 1.05rem; font-weight: 600; }
  .score-tally { display: flex; gap: 18px; }
  .tally-item { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .tally-num { font-size: 1.4rem; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--vscode-foreground); }
  .tally-label {
    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted);
    display: inline-flex; align-items: center; gap: 5px;
  }
  .tally-label .dot { width: 7px; height: 7px; border-radius: 50%; }
  .tally-item.missed .dot { background: var(--vscode-charts-red, #f85149); }
  .tally-item.partial .dot { background: var(--vscode-charts-yellow, #d29922); }
  .tally-item.recalled .dot { background: var(--vscode-charts-green, #3fb950); }
  .restart {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.82rem; padding: 6px 14px;
    border: 1px solid var(--accent); border-radius: 7px;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    color: var(--accent); cursor: pointer;
  }
  .katex { font-size: 1em; }
</style>
</head>
<body>
  <div class="header">
    <div class="title">
      <div class="title-row">
        <span class="brand-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/>
            <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>
            <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/>
            <path d="M12 18v-6"/>
          </svg>
        </span>
        <h1>Active recall</h1>
      </div>
      <div class="meta">${escapeHtml(codemap.query)}</div>
    </div>
    <div class="header-right">
      <button class="link-btn" id="show-models" title="View available models">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="link-icon"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
        Models
      </button>
      <div class="progress" id="progress"></div>
    </div>
  </div>

  <div class="content">
    <div class="card" id="card">
      <div class="kicker" id="kicker">Question</div>
      <div class="prompt" id="prompt"></div>
      <div class="recall-hint">Try to reconstruct the answer from memory, write it down, then reveal to compare.</div>

      <div class="attempt" id="attempt">
        <div class="attempt-label">Your answer</div>
        <textarea id="attempt-input" placeholder="Recall where this happens and why, then reveal to check yourself…" spellcheck="false"></textarea>
      </div>

      <div class="answer" id="answer" hidden>
        <div class="answer-label">roots' verified trace</div>
        <div class="answer-body" id="answer-body"></div>
        <div class="locs" id="locs"></div>
        <div class="overlap-hint" id="overlap-hint" hidden></div>
      </div>

      <div class="rating" id="rating" hidden>
        <div class="rating-label">How well did you recall it?</div>
        <div class="rating-row">
          <button class="rate" data-score="missed"><span class="dot"></span>Missed</button>
          <button class="rate" data-score="partial"><span class="dot"></span>Partial</button>
          <button class="rate" data-score="recalled"><span class="dot"></span>Recalled</button>
        </div>
      </div>

      <div class="controls">
        <button class="btn primary" id="reveal">Reveal answer</button>
        <button class="btn" id="next" hidden>Next question →</button>
      </div>
    </div>
    <div class="done" id="done" hidden>
      <div class="score-headline" id="score-headline">You've reviewed every verified trace.</div>
      <div class="score-tally" id="score-tally"></div>
      <button class="restart" id="restart">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" class="link-icon"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        Review again
      </button>
    </div>
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
      attempt: document.getElementById("attempt"),
      attemptInput: document.getElementById("attempt-input"),
      answer: document.getElementById("answer"),
      answerBody: document.getElementById("answer-body"),
      locs: document.getElementById("locs"),
      overlapHint: document.getElementById("overlap-hint"),
      rating: document.getElementById("rating"),
      reveal: document.getElementById("reveal"),
      next: document.getElementById("next"),
      progress: document.getElementById("progress"),
      done: document.getElementById("done"),
      scoreHeadline: document.getElementById("score-headline"),
      scoreTally: document.getElementById("score-tally"),
      restart: document.getElementById("restart"),
    };

    let index = 0;
    // Per-question state: what the user typed and how they rated their recall.
    const attempts = questions.map(() => ({ text: "", score: null }));

    // Rough keyword overlap between the user's answer and the verified trace,
    // used only as a nudge — the user makes the final call via the rating row.
    const STOP = new Set(["the","a","an","and","or","of","to","in","is","are","it","this","that","for","on","with","as","at","by","be","from","into","its","where","when","how","does","do"]);
    function keywords(text) {
      return new Set(
        String(text || "")
          .toLowerCase()
          .replace(/[^a-z0-9_\\s]/g, " ")
          .split(/\\s+/)
          .filter((w) => w.length > 2 && !STOP.has(w))
      );
    }
    function overlapRatio(userText, answerText) {
      const user = keywords(userText);
      const target = keywords(answerText);
      if (target.size === 0 || user.size === 0) return 0;
      let hit = 0;
      for (const w of target) if (user.has(w)) hit += 1;
      return hit / target.size;
    }

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

      // Restore any prior attempt for this question.
      els.attemptInput.value = attempts[index].text;
      els.attemptInput.disabled = false;
      els.attempt.hidden = false;
      els.answer.hidden = true;
      els.overlapHint.hidden = true;
      els.rating.hidden = true;
      for (const r of els.rating.querySelectorAll(".rate")) r.classList.remove("selected");
      els.reveal.hidden = false;
      els.next.hidden = true;
      els.progress.textContent = (index + 1) + " / " + questions.length;
      renderMath();
    }

    function reveal() {
      attempts[index].text = els.attemptInput.value;
      els.attemptInput.disabled = true;

      els.answer.hidden = false;
      els.rating.hidden = false;
      els.reveal.hidden = true;
      els.next.hidden = false;

      // Show an overlap nudge and pre-suggest a rating the user can override.
      const ratio = overlapRatio(attempts[index].text, questions[index].answer);
      if (attempts[index].text.trim().length > 0) {
        const pct = Math.round(ratio * 100);
        els.overlapHint.innerHTML =
          "Your answer shares <b>" + pct + "%</b> of the trace's key terms.";
        els.overlapHint.hidden = false;
        const suggested = ratio >= 0.6 ? "recalled" : ratio >= 0.25 ? "partial" : "missed";
        setRating(suggested, false);
      } else {
        els.overlapHint.hidden = true;
      }
      renderMath();
    }

    function setRating(score, fromClick) {
      attempts[index].score = score;
      for (const r of els.rating.querySelectorAll(".rate")) {
        r.classList.toggle("selected", r.dataset.score === score);
      }
      if (fromClick) els.next.focus();
    }

    function next() {
      // Default an un-rated question to "missed" so the tally stays honest.
      if (attempts[index].score === null) attempts[index].score = "missed";
      index += 1;
      if (index >= questions.length) {
        renderDone();
        return;
      }
      loadQuestion();
    }

    function renderDone() {
      els.card.hidden = true;
      els.done.hidden = false;
      els.progress.textContent = questions.length + " / " + questions.length;

      const counts = { recalled: 0, partial: 0, missed: 0 };
      for (const a of attempts) counts[a.score || "missed"] += 1;
      const total = questions.length;
      const scored = counts.recalled + counts.partial * 0.5;
      const pct = total ? Math.round((scored / total) * 100) : 0;
      els.scoreHeadline.textContent = "Recall score: " + pct + "%";

      const items = [
        { key: "recalled", label: "Recalled" },
        { key: "partial", label: "Partial" },
        { key: "missed", label: "Missed" },
      ];
      els.scoreTally.innerHTML = "";
      for (const it of items) {
        const wrap = document.createElement("div");
        wrap.className = "tally-item " + it.key;
        wrap.innerHTML =
          '<span class="tally-num">' + counts[it.key] + "</span>" +
          '<span class="tally-label"><span class="dot"></span>' + it.label + "</span>";
        els.scoreTally.appendChild(wrap);
      }
    }

    function restart() {
      index = 0;
      for (const a of attempts) { a.text = ""; a.score = null; }
      els.done.hidden = true;
      els.card.hidden = false;
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
    els.restart.addEventListener("click", restart);
    for (const r of els.rating.querySelectorAll(".rate")) {
      r.addEventListener("click", () => setRating(r.dataset.score, true));
    }
    // Ctrl/Cmd+Enter reveals from the textarea for a keyboard-driven flow.
    els.attemptInput.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !els.reveal.hidden) {
        e.preventDefault();
        reveal();
      }
    });
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
