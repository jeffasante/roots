import * as vscode from "vscode";
import type { CodemapNode } from "./codemapTreeProvider.js";
import {
  EngineClient,
  resolveEnginePath,
  type AskResult,
  type BackendConfig,
  type BackendOption,
  type Codemap,
  type Location,
  type SuggestionIntensity,
} from "./engineClient.js";
import { BackendsPanel } from "./webview/backendsPanel.js";
import { CodemapsViewProvider } from "./webview/codemapsView.js";
import { CodemapPanel } from "./webview/panel.js";
import { QuizPanel, type GradeRequest, type GradeResult } from "./webview/quizPanel.js";

let engine: EngineClient | undefined;
let codemapsView: CodemapsViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const enginePath = resolveEnginePath(
    vscode.workspace.getConfiguration("roots").get<string>("enginePath", ""),
    context.extensionPath
  );
  engine = new EngineClient(enginePath);
  CodemapPanel.configure((codemap, question) => askCodemap(context, codemap, question));
  QuizPanel.configure(context.extensionUri);
  QuizPanel.configureGrader((args) => gradeQuizAnswer(context, args));
  const FAVORITES_KEY = "roots.favorites";
  const readFavorites = () => context.globalState.get<string[]>(FAVORITES_KEY, []);
  codemapsView = new CodemapsViewProvider({
    generate: (query) => generateCodemap(context, query),
    open: (codemap) => CodemapPanel.show(codemap),
    quiz: (codemap) => QuizPanel.show(codemap),
    delete: (codemap) => deleteCodemap({ kind: "codemap", codemap }),
    selectModel: () => selectModel(context),
    refresh: () => refreshCodemaps(),
    suggest: (intensity) => refreshSuggestions(context, intensity),
    reveal: (repoRoot, loc) => openLocation(repoRoot, loc),
    ask: (codemap, question) => askCodemap(context, codemap, question),
    favorites: () => readFavorites(),
    toggleFavorite: async (id) => {
      const current = new Set(readFavorites());
      if (current.has(id)) current.delete(id);
      else current.add(id);
      await context.globalState.update(FAVORITES_KEY, [...current]);
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CodemapsViewProvider.viewType, codemapsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("roots.generateCodemap", () => generateCodemap(context)),
    vscode.commands.registerCommand("roots.refreshCodemaps", () => refreshCodemaps()),
    vscode.commands.registerCommand("roots.openCodemap", (node: CodemapNode) => openCodemap(node)),
    vscode.commands.registerCommand("roots.startQuiz", (node?: CodemapNode) => startQuiz(node)),
    vscode.commands.registerCommand("roots.showBackends", () => showBackends()),
    vscode.commands.registerCommand("roots.selectModel", () => selectModel(context)),
    vscode.commands.registerCommand("roots.deleteCodemap", (node: CodemapNode) => deleteCodemap(node)),
    vscode.commands.registerCommand("roots.openLocation", (repoRoot: string, loc: Location) =>
      openLocation(repoRoot, loc)
    ),
    { dispose: () => engine?.dispose() }
  );

  void refreshCodemaps();
}

export function deactivate(): void {
  engine?.dispose();
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function refreshCodemaps(): Promise<void> {
  const root = workspaceRoot();
  if (!root || !engine || !codemapsView) return;
  try {
    const [codemaps, backends] = await Promise.all([engine.listCodemaps(root), engine.listBackends()]);
    codemapsView.setData(codemaps, backends);
  } catch (err) {
    console.error("[roots] refresh failed", err);
  }
}

async function refreshSuggestions(
  context: vscode.ExtensionContext,
  intensity: SuggestionIntensity = "intermediate",
): Promise<void> {
  const root = workspaceRoot();
  if (!root || !engine || !codemapsView) return;
  codemapsView.setSuggestionsLoading();
  try {
    const backend = await pickBackend(context);
    if (!backend) {
      codemapsView.setSuggestionsError("Select a configured model to generate suggestions.");
      return;
    }
    const suggestions = await engine.suggestCodemaps({ repoRoot: root, backend, intensity });
    codemapsView.setSuggestions(suggestions);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    codemapsView.setSuggestionsError(message);
    void vscode.window.showErrorMessage(`roots: could not generate suggestions: ${message}`);
  }
}

async function generateCodemap(context: vscode.ExtensionContext, requestedQuery?: string): Promise<void> {
  const root = workspaceRoot();
  if (!root || !engine) {
    void vscode.window.showErrorMessage("roots: open a folder first.");
    return;
  }

  const query = requestedQuery ?? await vscode.window.showInputBox({
      prompt: "What flow should roots trace?",
      placeHolder: "e.g. trace the login and session refresh flow",
      ignoreFocusOut: true,
    });
  if (!query) return;

  const backend = await pickBackend(context);
  if (!backend) return;
  codemapsView?.setGenerating(query);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "roots: generating codemap", cancellable: false },
    async (progress) => {
      engine!.onProgress((e) => {
        progress.report({ message: e.message });
        codemapsView?.setProgress(e);
      });
      try {
        const { codemap } = await engine!.generateCodemap({ query, repoRoot: root, backend });
        await refreshCodemaps();
        void vscode.window.showInformationMessage(
          `roots: codemap "${codemap.id}" created with ${codemap.traces.length} trace(s).`
        );
      } catch (err) {
        void vscode.window.showErrorMessage(`roots: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        codemapsView?.clearProgress();
      }
    }
  );
}

/**
 * Active-model picker for the Codemaps toolbar (image-2 style). Two quick
 * steps — backend, then model — persisted to `roots.backend.*` so it becomes
 * the default for the next Generate. Reads back the current selection so the
 * dropdown reflects what's active.
 */
async function selectModel(context: vscode.ExtensionContext): Promise<void> {
  if (!engine) return;
  const options = await engine.listBackends();
  const cfg = vscode.workspace.getConfiguration("roots");
  const currentKind = cfg.get<string>("backend.kind", "");
  const currentModel = cfg.get<string>("backend.model", "");
  const currentBaseUrl = cfg.get<string>("backend.baseUrl", "");

  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.kind === currentKind && (o.baseUrl ?? "") === currentBaseUrl ? `$(check) ${o.label}` : o.label,
      description: o.mode === "local" ? "local" : "cloud",
      detail: `default model: ${o.defaultModel}${o.requiresApiKey ? " · API key required" : ""}`,
      option: o,
    })),
    { placeHolder: "Select the backend roots should use" }
  );
  if (!picked) return;
  let option: BackendOption = picked.option;

  // Custom OpenAI-compatible endpoint: ask for the base URL, then treat it like
  // any other preset from here on (key + model resolution keyed by this URL).
  if (option.customEndpoint) {
    const baseUrl = await promptForBaseUrl(currentBaseUrl);
    if (!baseUrl) return;
    option = { ...option, baseUrl };
  }

  const model = await chooseModel(option, {
    currentKind,
    currentModel,
    currentBaseUrl,
  });
  if (model === undefined || model.trim() === "") {
    if (option.customEndpoint) {
      void vscode.window.showWarningMessage("roots: a model id is required for a custom endpoint.");
    }
    return;
  }

  if (option.requiresApiKey) {
    const key = await resolveApiKey(context, option);
    if (!key) {
      void vscode.window.showWarningMessage(`roots: ${option.label} needs an API key to be used.`);
      return;
    }
  }

  await cfg.update("backend.kind", option.kind, vscode.ConfigurationTarget.Workspace);
  await cfg.update("backend.model", model, vscode.ConfigurationTarget.Workspace);
  await cfg.update("backend.baseUrl", option.baseUrl ?? "", vscode.ConfigurationTarget.Workspace);
  await refreshCodemaps();
  void vscode.window.showInformationMessage(`roots: using ${option.label} · ${model}`);
}

/**
 * Ask for an OpenAI-compatible base URL (e.g. a self-hosted gateway or a
 * provider we don't ship a preset for). Validates it's an http(s) URL and
 * normalizes a trailing slash. Returns undefined if cancelled.
 */
async function promptForBaseUrl(prefill: string): Promise<string | undefined> {
  const entered = await vscode.window.showInputBox({
    prompt: "OpenAI-compatible base URL (e.g. https://api.example.com/v1)",
    placeHolder: "https://api.example.com/v1",
    value: prefill || "https://",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!/^https?:\/\/.+/i.test(t)) return "Enter a full http(s) URL, e.g. https://api.example.com/v1";
      return undefined;
    },
  });
  return entered?.trim().replace(/\/+$/, "") || undefined;
}

/**
 * Resolve which model to use for a backend. If the backend ships a curated
 * `models` list (e.g. NVIDIA NIM), show a quick-pick of those plus a "Custom…"
 * escape hatch; otherwise fall back to a free-text input box.
 * Returns undefined if the user cancels.
 */
async function chooseModel(
  option: BackendOption,
  current: { currentKind: string; currentModel: string; currentBaseUrl: string }
): Promise<string | undefined> {
  const isCurrentBackend =
    option.kind === current.currentKind && (option.baseUrl ?? "") === current.currentBaseUrl;
  const prefill = (isCurrentBackend && current.currentModel) || option.defaultModel;

  if (option.models?.length) {
    const CUSTOM = "$(edit) Custom model…";
    const items: vscode.QuickPickItem[] = option.models.map((m) => ({
      label: m.id === prefill ? `$(check) ${m.label}` : m.label,
      description: m.id,
      detail: m.note,
    }));
    items.push({ label: CUSTOM, description: "Enter any model id" });

    const chosen = await vscode.window.showQuickPick(items, {
      placeHolder: `Select a model for ${option.label}`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!chosen) return undefined;
    if (chosen.label !== CUSTOM) {
      // description holds the raw model id
      return chosen.description ?? prefill;
    }
    // fall through to custom input
  }

  return vscode.window.showInputBox({
    prompt: `Model for ${option.label}`,
    value: prefill,
    ignoreFocusOut: true,
  });
}

/** Backend picker: lists engine options, resolves model + API key (via SecretStorage). */
async function pickBackend(context: vscode.ExtensionContext): Promise<BackendConfig | undefined> {
  if (!engine) return undefined;
  const options = await engine.listBackends();
  const cfg = vscode.workspace.getConfiguration("roots");

  // Prefer the model chosen from the toolbar picker; only prompt if none set.
  const savedKind = cfg.get<string>("backend.kind", "");
  const savedModel = cfg.get<string>("backend.model", "");
  const savedBaseUrl = cfg.get<string>("backend.baseUrl", "");
  let option = options.find((o) => o.kind === savedKind && (o.baseUrl ?? "") === savedBaseUrl);

  // A saved custom endpoint won't match any preset (presets have no baseUrl or a
  // different one). Reconstruct it from config so previously-chosen custom
  // providers keep working without re-prompting.
  if (!option && savedKind && savedBaseUrl) {
    const custom = options.find((o) => o.customEndpoint);
    option = { ...(custom ?? { kind: savedKind as BackendOption["kind"], label: savedBaseUrl, description: "Custom · OpenAI-compatible", mode: "cloud", requiresApiKey: true, defaultModel: savedModel }), baseUrl: savedBaseUrl };
  }

  if (!option) {
    const picked = await vscode.window.showQuickPick(
      options
        // The bare custom option is only useful via selectModel (it needs a URL
        // prompt); hide it from this fallback picker to avoid a URL-less choice.
        .filter((o) => !o.customEndpoint)
        .map((o) => ({
          label: o.label,
          description: o.description,
          detail: `default model: ${o.defaultModel}`,
          option: o,
        })),
      { placeHolder: "Choose an inference backend" }
    );
    if (!picked) return undefined;
    option = picked.option;
  }

  const model = savedModel || option.defaultModel;

  let apiKey: string | undefined;
  if (option.requiresApiKey) {
    apiKey = await resolveApiKey(context, option);
    if (!apiKey) {
      void vscode.window.showWarningMessage(`roots: ${option.label} needs an API key.`);
      return undefined;
    }
  }

  const baseUrl = savedBaseUrl || option.baseUrl;

  return { kind: option.kind, model, apiKey, baseUrl };
}

/** Retrieve a stored key from SecretStorage, prompting once if absent. */
async function resolveApiKey(context: vscode.ExtensionContext, option: BackendOption): Promise<string | undefined> {
  const secretKey = `roots.apiKey.${option.kind}.${option.baseUrl ?? "default"}`;
  const existing = await context.secrets.get(secretKey);
  if (existing) return existing;

  const entered = await vscode.window.showInputBox({
    prompt: `Enter API key for ${option.label} (stored securely)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (entered) await context.secrets.store(secretKey, entered);
  return entered ?? undefined;
}

/** Show the catalog of inference backends roots can use ("click to view"). */
async function showBackends(): Promise<void> {
  if (!engine) return;
  try {
    const backends = await engine.listBackends();
    BackendsPanel.show(backends);
  } catch (err) {
    void vscode.window.showErrorMessage(`roots: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Open the panel for a codemap selected in the sidebar tree. */
function openCodemap(node: CodemapNode): void {
  if (node?.kind !== "codemap") return;
  CodemapPanel.show(node.codemap);
}

/**
 * Start an active-recall quiz. Invoked from a codemap's context menu (node
 * given) or the command palette (prompt a pick). Only verified traces become
 * questions — the eligibility gate lives in QuizPanel.
 */
async function startQuiz(node?: CodemapNode): Promise<void> {
  let codemap = node?.kind === "codemap" ? node.codemap : undefined;

  if (!codemap) {
    const root = workspaceRoot();
    if (!root || !engine) {
      void vscode.window.showErrorMessage("roots: open a folder first.");
      return;
    }
    const codemaps = await engine.listCodemaps(root);
    if (codemaps.length === 0) {
      void vscode.window.showInformationMessage("roots: generate a codemap first, then quiz yourself on it.");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      codemaps.map((c) => ({
        label: c.query,
        description: `${c.model.backend} · ${c.model.model_name}`,
        detail: `${c.traces.length} trace(s) · ${c.created_at}`,
        codemap: c,
      })),
      { placeHolder: "Quiz yourself on which codemap?" }
    );
    if (!picked) return;
    codemap = picked.codemap;
  }

  QuizPanel.show(codemap);
}

async function deleteCodemap(node: CodemapNode): Promise<void> {
  const root = workspaceRoot();
  if (!root || !engine || node?.kind !== "codemap") return;
  const confirm = await vscode.window.showWarningMessage(
    `Delete codemap "${node.codemap.id}"?`,
    { modal: true },
    "Delete"
  );
  if (confirm !== "Delete") return;
  await engine.deleteCodemap(root, node.codemap.id);
  await refreshCodemaps();
}

/** Answer a follow-up question about a codemap, grounded in its real files. */
async function askCodemap(
  context: vscode.ExtensionContext,
  codemap: Codemap,
  question: string
): Promise<AskResult> {
  if (!engine) throw new Error("Engine not ready.");
  const backend = await pickBackend(context);
  if (!backend) throw new Error("No inference backend configured.");
  return engine.askCodemap({ codemap, question, backend });
}

/**
 * Grade a recall attempt: ask the configured model to compare the user's answer
 * to roots' verified trace and return one of missed/partial/recalled plus a
 * short piece of feedback. Runs through the same askCodemap round-trip.
 */
async function gradeQuizAnswer(
  context: vscode.ExtensionContext,
  args: GradeRequest
): Promise<GradeResult> {
  if (!engine) throw new Error("Engine not ready.");
  const backend = await pickBackend(context);
  if (!backend) throw new Error("No inference backend configured.");

  const question =
    "You are grading a developer's active-recall attempt against a verified trace from this codebase.\n\n" +
    `Question: ${args.prompt}\n\n` +
    `Verified answer (ground truth):\n${args.verifiedAnswer}\n\n` +
    `The developer's answer:\n${args.userAnswer || "(left blank)"}\n\n` +
    "Compare the developer's answer to the verified answer. Judge only whether they recalled the " +
    "right place and mechanism — ignore wording and formatting. Reply with a single line of JSON and " +
    'nothing else, in exactly this shape: {"score":"missed|partial|recalled","feedback":"one concise sentence"}. ' +
    'Use "recalled" if they got the location and mechanism right, "partial" if they got some of it, ' +
    '"missed" if it is blank or wrong.';

  const { answer } = await engine.askCodemap({ codemap: args.codemap, question, backend });
  return parseGrade(answer);
}

/** Tolerantly extract the grade verdict from the model's reply. */
function parseGrade(raw: string): GradeResult {
  const text = raw.trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { score?: string; feedback?: string };
      const score = normalizeScore(parsed.score);
      if (score) return { score, feedback: (parsed.feedback ?? "").trim() || defaultFeedback(score) };
    } catch {
      // fall through to keyword scan
    }
  }
  const score = normalizeScore(text) ?? "partial";
  return { score, feedback: text.slice(0, 240) || defaultFeedback(score) };
}

function normalizeScore(value: string | undefined): GradeResult["score"] | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v.includes("recall")) return "recalled";
  if (v.includes("miss")) return "missed";
  if (v.includes("partial")) return "partial";
  return undefined;
}

function defaultFeedback(score: GradeResult["score"]): string {
  if (score === "recalled") return "You recalled the right place and mechanism.";
  if (score === "partial") return "You got part of it — revisit the trace to fill the gaps.";
  return "Not quite — study the verified trace and try again.";
}

async function openLocation(repoRoot: string, loc: Location): Promise<void> {
  const target = vscode.Uri.file(require("node:path").resolve(repoRoot, loc.file));
  const doc = await vscode.workspace.openTextDocument(target);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  const start = new vscode.Position(Math.max(0, loc.start_line - 1), 0);
  const end = new vscode.Position(Math.max(0, loc.end_line - 1), 0);
  const range = new vscode.Range(start, end);
  editor.selection = new vscode.Selection(start, start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

// Referenced to keep the import used for typing across files.
export type { Codemap };
