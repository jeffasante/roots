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

/** A request to grade a user's recall attempt against the verified trace. */
export interface GradeRequest {
  codemap: Codemap;
  prompt: string;
  verifiedAnswer: string;
  userAnswer: string;
}

/** The model's verdict on a recall attempt. */
export interface GradeResult {
  score: "missed" | "partial" | "recalled";
  feedback: string;
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
  /** Grades a free-text attempt against the verified trace via the model. */
  private static grader: ((args: GradeRequest) => Promise<GradeResult>) | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private codemap: Codemap | undefined;

  /** Called once on activation so the panel can set its editor-tab icon. */
  static configure(extensionUri: vscode.Uri): void {
    QuizPanel.extensionUri = extensionUri;
  }

  /** Register the grading round-trip (model compares attempt vs. trace). */
  static configureGrader(grader: (args: GradeRequest) => Promise<GradeResult>): void {
    QuizPanel.grader = grader;
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
      (msg: {
        type?: string;
        repoRoot?: string;
        location?: Location;
        requestId?: number;
        prompt?: string;
        verifiedAnswer?: string;
        userAnswer?: string;
      }) => {
        if (msg?.type === "openLocation" && msg.repoRoot && msg.location) {
          void vscode.commands.executeCommand("roots.openLocation", msg.repoRoot, msg.location);
        } else if (msg?.type === "showBackends") {
          void vscode.commands.executeCommand("roots.showBackends");
        } else if (msg?.type === "gradeAnswer" && typeof msg.requestId === "number") {
          void this.grade(msg.requestId, msg.prompt ?? "", msg.verifiedAnswer ?? "", msg.userAnswer ?? "");
        }
      },
      null,
      this.disposables
    );
  }

  /** Run the model grader and post the verdict back to the webview. */
  private async grade(requestId: number, prompt: string, verifiedAnswer: string, userAnswer: string): Promise<void> {
    if (!QuizPanel.grader || !this.codemap) {
      void this.panel.webview.postMessage({
        type: "gradeResult",
        requestId,
        error: "Grading is unavailable.",
      });
      return;
    }
    try {
      const result = await QuizPanel.grader({
        codemap: this.codemap,
        prompt,
        verifiedAnswer,
        userAnswer,
      });
      void this.panel.webview.postMessage({ type: "gradeResult", requestId, result });
    } catch (err) {
      void this.panel.webview.postMessage({
        type: "gradeResult",
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private render(codemap: Codemap, questions: Question[]): void {
    this.codemap = codemap;
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
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--muted); font-size: 0.8rem; font-family: inherit;
  }
  .link-btn:hover { color: var(--vscode-foreground); text-decoration: underline; }
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
    outline: none; border-color: var(--vscode-focusBorder, var(--muted));
  }
  .attempt textarea:disabled { opacity: 0.7; cursor: default; }

  /* The model's verdict on the submitted attempt. */
  .verdict { margin-top: 16px; }
  .verdict[hidden] { display: none; }
  .verdict-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .verdict-badge {
    font-size: 0.68rem; font-weight: 600; letter-spacing: 0.03em;
    text-transform: uppercase; padding: 2px 9px;
    border-radius: 999px; border: 1px solid transparent;
  }
  .verdict-badge.missed {
    color: var(--vscode-charts-red, #f85149);
    border-color: color-mix(in srgb, var(--vscode-charts-red, #f85149) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-charts-red, #f85149) 10%, transparent);
  }
  .verdict-badge.partial {
    color: var(--vscode-charts-yellow, #d29922);
    border-color: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d29922) 10%, transparent);
  }
  .verdict-badge.recalled {
    color: var(--vscode-charts-green, #3fb950);
    border-color: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 40%, transparent);
    background: color-mix(in srgb, var(--vscode-charts-green, #3fb950) 10%, transparent);
  }
  .verdict-badge.grading { color: var(--muted); border-color: var(--border); }
  .verdict-badge.error { color: var(--vscode-charts-red, #f85149); border-color: var(--border); }
  .verdict-feedback { font-size: 0.9rem; color: var(--vscode-foreground); }

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
  .loc:hover { color: var(--vscode-foreground); border-color: var(--muted); }

  .controls { display: flex; gap: 8px; margin-top: 18px; flex-wrap: wrap; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 0.82rem; padding: 6px 14px;
    border: 1px solid var(--border); border-radius: 7px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer;
  }
  .btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12)); }
  .btn.primary {
    border-color: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  .btn.primary:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }
  .btn.primary:disabled { opacity: 0.6; cursor: default; }
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
    border: 1px solid var(--vscode-button-background); border-radius: 7px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground); cursor: pointer;
  }
  .restart:hover { background: var(--vscode-button-hoverBackground, var(--vscode-button-background)); }
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
      <div class="recall-hint">Reconstruct the answer from memory, then submit — roots grades it against the verified trace.</div>

      <div class="attempt" id="attempt">
        <div class="attempt-label">Your answer</div>
        <textarea id="attempt-input" placeholder="Recall where this happens and why, then submit to be graded…" spellcheck="false"></textarea>
      </div>

      <div class="verdict" id="verdict" hidden>
        <div class="verdict-head">
          <span class="verdict-badge" id="verdict-badge"></span>
          <span class="verdict-feedback" id="verdict-feedback"></span>
        </div>
      </div>

      <div class="answer" id="answer" hidden>
        <div class="answer-label">roots' verified trace</div>
        <div class="answer-body" id="answer-body"></div>
        <div class="locs" id="locs"></div>
      </div>

      <div class="controls">
        <button class="btn primary" id="submit">Submit answer</button>
        <button class="btn" id="reveal" hidden>Reveal trace</button>
        <button class="btn" id="next" hidden>Next question →</button>
      </div>
    </div>
    <div class="done" id="done" hidden>
      <div class="score-headline" id="score-headline">You've reviewed every verified trace.</div>
      <div class="score-tally" id="score-tally"></div>
      <button class="restart" id="restart">Review again</button>
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
      verdict: document.getElementById("verdict"),
      verdictBadge: document.getElementById("verdict-badge"),
      verdictFeedback: document.getElementById("verdict-feedback"),
      answer: document.getElementById("answer"),
      answerBody: document.getElementById("answer-body"),
      locs: document.getElementById("locs"),
      submit: document.getElementById("submit"),
      reveal: document.getElementById("reveal"),
      next: document.getElementById("next"),
      progress: document.getElementById("progress"),
      done: document.getElementById("done"),
      scoreHeadline: document.getElementById("score-headline"),
      scoreTally: document.getElementById("score-tally"),
      restart: document.getElementById("restart"),
    };

    let index = 0;
    let requestSeq = 0;
    let pendingRequest = null;
    // Per-question state: the attempt text and the model's verdict.
    const attempts = questions.map(() => ({ text: "", score: null, feedback: "" }));

    const SCORE_LABEL = { missed: "Missed", partial: "Partial", recalled: "Recalled" };

    function confBadge(c) {
      if (!c) return "";
      const text = c.location_evidence === "symbol" ? "verified" : "located";
      const cls = c.location_evidence === "symbol" ? "conf conf-verified" : "conf conf-located";
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

      const prior = attempts[index];
      els.attemptInput.value = prior.text;
      els.attemptInput.disabled = prior.score !== null;
      els.attempt.hidden = false;

      if (prior.score !== null) {
        // Returning to an already-graded question: restore its verdict.
        showVerdict(prior.score, prior.feedback);
        els.answer.hidden = false;
        els.submit.hidden = true;
        els.reveal.hidden = true;
        els.next.hidden = false;
      } else {
        els.verdict.hidden = true;
        els.answer.hidden = true;
        els.submit.hidden = false;
        els.submit.disabled = false;
        els.submit.textContent = "Submit answer";
        els.reveal.hidden = false;
        els.next.hidden = true;
      }

      els.progress.textContent = (index + 1) + " / " + questions.length;
      renderMath();
    }

    function showVerdict(score, feedback) {
      els.verdictBadge.className = "verdict-badge " + score;
      els.verdictBadge.textContent = SCORE_LABEL[score] || score;
      els.verdictFeedback.textContent = feedback || "";
      els.verdict.hidden = false;
    }

    function submit() {
      const text = els.attemptInput.value;
      attempts[index].text = text;
      els.attemptInput.disabled = true;
      els.submit.disabled = true;
      els.submit.textContent = "Grading…";
      els.verdictBadge.className = "verdict-badge grading";
      els.verdictBadge.textContent = "Grading";
      els.verdictFeedback.textContent = "roots is comparing your answer to the verified trace…";
      els.verdict.hidden = false;

      requestSeq += 1;
      pendingRequest = requestSeq;
      vscodeApi.postMessage({
        type: "gradeAnswer",
        requestId: requestSeq,
        prompt: questions[index].prompt,
        verifiedAnswer: questions[index].answer,
        userAnswer: text,
      });
    }

    function onGradeResult(msg) {
      // Ignore stale replies (user moved on before grading returned).
      if (msg.requestId !== pendingRequest) return;
      pendingRequest = null;

      if (msg.error) {
        els.verdictBadge.className = "verdict-badge error";
        els.verdictBadge.textContent = "Error";
        els.verdictFeedback.textContent = msg.error;
        els.submit.disabled = false;
        els.submit.textContent = "Retry";
        els.attemptInput.disabled = false;
        return;
      }

      const score = msg.result.score;
      const feedback = msg.result.feedback;
      attempts[index].score = score;
      attempts[index].feedback = feedback;
      showVerdict(score, feedback);

      // Grading is authoritative — reveal the trace and move on.
      els.answer.hidden = false;
      els.submit.hidden = true;
      els.reveal.hidden = true;
      els.next.hidden = false;
      els.next.focus();
      renderMath();
    }

    function reveal() {
      attempts[index].text = els.attemptInput.value;
      els.answer.hidden = false;
      els.reveal.hidden = true;
      renderMath();
    }

    function next() {
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
      let graded = 0;
      for (const a of attempts) {
        if (a.score === null) continue;
        counts[a.score] += 1;
        graded += 1;
      }
      const scored = counts.recalled + counts.partial * 0.5;
      const pct = graded ? Math.round((scored / graded) * 100) : 0;
      els.scoreHeadline.textContent = graded
        ? "Recall score: " + pct + "%"
        : "You've reviewed every verified trace.";

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
      pendingRequest = null;
      for (const a of attempts) { a.text = ""; a.score = null; a.feedback = ""; }
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

    els.submit.addEventListener("click", submit);
    els.reveal.addEventListener("click", reveal);
    els.next.addEventListener("click", next);
    els.restart.addEventListener("click", restart);

    // Ctrl/Cmd+Enter submits from the textarea for a keyboard-driven flow.
    els.attemptInput.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !els.submit.hidden && !els.submit.disabled) {
        e.preventDefault();
        submit();
      }
    });

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg && msg.type === "gradeResult") onGradeResult(msg);
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
