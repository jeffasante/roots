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
import type { ModelChoice, CurrentSelection } from "./webview/modelPickerPanel.js";
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
    cancelGenerate: () => engine?.cancelActiveWork(),
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
    vscode.commands.registerCommand("roots.useBackend", (option: BackendOption) => useBackend(context, option)),
    vscode.commands.registerCommand("roots.setApiKey", () => setApiKey(context)),
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
    { location: vscode.ProgressLocation.Notification, title: "roots: generating codemap", cancellable: true },
    async (progress, token) => {
      let cancelled = false;
      token.onCancellationRequested(() => {
        cancelled = true;
        engine!.cancelActiveWork();
      });
      engine!.onProgress((e) => {
        progress.report({ message: e.message });
        codemapsView?.setProgress(e);
      });
      try {
        const { codemap } = await engine!.generateCodemap({ query, repoRoot: root, backend });
        await refreshCodemaps();
        // Auto-open the fresh codemap inline so the user lands on it immediately
        // instead of having to find it in the library.
        codemapsView?.openDetail(codemap.id);
        void vscode.window.showInformationMessage(
          `roots: codemap "${codemap.id}" created with ${codemap.traces.length} trace(s).`
        );
      } catch (err) {
        if (cancelled) {
          void vscode.window.showInformationMessage("roots: codemap generation cancelled.");
        } else {
          void vscode.window.showErrorMessage(`roots: ${err instanceof Error ? err.message : String(err)}`);
        }
      } finally {
        codemapsView?.clearProgress();
      }
    }
  );
}

/**
 * Active-model picker for the Codemaps toolbar (image-2 style). Opens a single
 * searchable modal listing every provider's models together; picking a row
 * resolves the backend + model in one action, persisted to `roots.backend.*`
 * so it becomes the default for the next Generate.
 */
async function selectModel(context: vscode.ExtensionContext): Promise<void> {
  if (!engine) return;
  const options = await engine.listBackends();
  const cfg = vscode.workspace.getConfiguration("roots");
  const currentKind = cfg.get<string>("backend.kind", "");
  const currentModel = cfg.get<string>("backend.model", "");
  const currentBaseUrl = cfg.get<string>("backend.baseUrl", "");

  const choice = await pickModelQuick(options, {
    kind: currentKind,
    model: currentModel,
    baseUrl: currentBaseUrl,
  });
  if (!choice) return;

  // Resolve the full backend option so we can label messages and reuse presets.
  let option =
    options.find((o) => o.kind === choice.kind && (o.baseUrl ?? "") === (choice.baseUrl ?? "")) ??
    options.find((o) => o.kind === choice.kind);
  if (!option) return;

  let baseUrl = choice.baseUrl ?? option.baseUrl;
  let model = choice.model;

  // Custom OpenAI-compatible endpoint: ask for the base URL + model id, since
  // there's no preset to fall back on.
  if (choice.customEndpoint) {
    const enteredUrl = await promptForBaseUrl(currentBaseUrl);
    if (!enteredUrl) return;
    baseUrl = enteredUrl;
    // Only prefill the model if the current selection was already this custom
    // endpoint; otherwise a stale preset model id (e.g. "deepseek-chat") would
    // be suggested for an unrelated provider.
    const modelPrefill = currentKind === option.kind && currentBaseUrl === baseUrl ? currentModel : "";
    const enteredModel = await vscode.window.showInputBox({
      prompt: "Model id for the custom endpoint (e.g. gpt-4o-mini)",
      placeHolder: "gpt-4o-mini",
      value: modelPrefill,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() === "" ? "A model id is required" : undefined),
    });
    if (!enteredModel || enteredModel.trim() === "") {
      void vscode.window.showWarningMessage("roots: a model id is required for a custom endpoint.");
      return;
    }
    model = enteredModel.trim();
    // Mark this as a custom endpoint so the key is stored/looked up by URL and
    // the label reflects the real endpoint rather than the generic preset.
    option = { ...option, baseUrl, customEndpoint: true, label: baseUrl, defaultModel: model };
  }

  if (choice.requiresApiKey) {
    const key = await resolveApiKey(context, { ...option, baseUrl }, { allowReplace: true });
    if (!key) {
      void vscode.window.showWarningMessage(`roots: ${option.label} needs an API key to be used.`);
      return;
    }
  }

  await cfg.update("backend.kind", option.kind, vscode.ConfigurationTarget.Workspace);
  await cfg.update("backend.model", model, vscode.ConfigurationTarget.Workspace);
  await cfg.update("backend.baseUrl", baseUrl ?? "", vscode.ConfigurationTarget.Workspace);
  await refreshCodemaps();
  void vscode.window.showInformationMessage(`roots: using ${option.label} · ${model}`);
}

/**
 * Select a backend directly from the Models panel ("Use this backend"). Uses
 * the backend's default model. For custom endpoints, defers to the full
 * selectModel flow (which prompts for URL + model id). Prompts for an API key
 * only when required.
 */
async function useBackend(context: vscode.ExtensionContext, option: BackendOption): Promise<void> {
  if (option.customEndpoint) {
    await selectModel(context);
    return;
  }

  const baseUrl = option.baseUrl;
  const model = option.defaultModel;

  if (option.requiresApiKey) {
    const key = await resolveApiKey(context, { ...option, baseUrl }, { allowReplace: true });
    if (!key) {
      void vscode.window.showWarningMessage(`roots: ${option.label} needs an API key to be used.`);
      return;
    }
  }

  const cfg = vscode.workspace.getConfiguration("roots");
  await cfg.update("backend.kind", option.kind, vscode.ConfigurationTarget.Workspace);
  await cfg.update("backend.model", model, vscode.ConfigurationTarget.Workspace);
  await cfg.update("backend.baseUrl", baseUrl ?? "", vscode.ConfigurationTarget.Workspace);
  await refreshCodemaps();
  void vscode.window.showInformationMessage(`roots: using ${option.label} · ${model}`);
}

/**
 * A searchable modal (native QuickPick) for choosing an inference model:
 * every provider's models are grouped under a separator and listed together,
 * so picking a row resolves the backend + model in one action. Runs as an
 * overlay rather than an editor tab.
 */
async function pickModelQuick(
  options: BackendOption[],
  current: CurrentSelection
): Promise<ModelChoice | undefined> {
  type Row = vscode.QuickPickItem & { choice?: ModelChoice };
  const items: Row[] = [];

  for (const option of options) {
    if (option.customEndpoint) continue;
    items.push({ label: option.label, kind: vscode.QuickPickItemKind.Separator });
    const models = option.models?.length ? option.models : [{ id: option.defaultModel, label: option.defaultModel }];
    for (const m of models) {
      const isCurrent =
        option.kind === current.kind &&
        (option.baseUrl ?? "") === (current.baseUrl ?? "") &&
        m.id === current.model;
      items.push({
        label: `${isCurrent ? "$(check) " : ""}${m.label}`,
        description: option.requiresApiKey ? "API key" : option.mode === "local" ? "local" : "cloud",
        detail: m.note ? `${m.id} · ${m.note}` : m.id,
        choice: {
          kind: option.kind,
          baseUrl: option.baseUrl,
          model: m.id,
          requiresApiKey: option.requiresApiKey,
        },
      });
    }
  }

  // Custom OpenAI-compatible endpoint entry (prompts for URL + model id later).
  const custom = options.find((o) => o.customEndpoint);
  if (custom) {
    items.push({ label: "Other", kind: vscode.QuickPickItemKind.Separator });
    items.push({
      label: "$(add) Custom OpenAI-compatible endpoint…",
      detail: "Bring your own base URL and model id",
      choice: {
        kind: custom.kind,
        baseUrl: custom.baseUrl,
        model: custom.defaultModel,
        requiresApiKey: custom.requiresApiKey,
        customEndpoint: true,
      },
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: "roots — Choose a model",
    placeHolder: "Search models or providers…",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  return picked?.choice;
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
  // providers keep working without re-prompting. Preserve customEndpoint so the
  // API key is stored/looked up by URL, and carry the saved model as default.
  if (!option && savedKind && savedBaseUrl) {
    const custom = options.find((o) => o.customEndpoint);
    option = {
      ...(custom ?? {
        kind: savedKind as BackendOption["kind"],
        description: "Custom · OpenAI-compatible",
        mode: "cloud",
        requiresApiKey: true,
      }),
      label: savedBaseUrl,
      baseUrl: savedBaseUrl,
      defaultModel: savedModel,
      customEndpoint: true,
      requiresApiKey: true,
    };
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

/** SecretStorage key for a backend's API key (scoped by provider + base URL). */
function secretKeyFor(option: Pick<BackendOption, "kind" | "baseUrl">): string {
  return `roots.apiKey.${option.kind}.${option.baseUrl ?? "default"}`;
}

/**
 * Retrieve a stored key from SecretStorage, prompting when absent.
 *
 * When `allowReplace` is set and a key already exists, the user is offered the
 * chance to keep or replace it — otherwise a saved (possibly wrong) key would
 * be impossible to change from the normal model-selection flow.
 */
async function resolveApiKey(
  context: vscode.ExtensionContext,
  option: BackendOption,
  opts: { allowReplace?: boolean } = {}
): Promise<string | undefined> {
  const secretKey = secretKeyFor(option);
  const existing = await context.secrets.get(secretKey);

  if (existing && !opts.allowReplace) return existing;

  if (existing && opts.allowReplace) {
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(check) Keep current key", value: "keep" },
        { label: "$(key) Replace key", value: "replace" },
        { label: "$(trash) Remove key", value: "remove" },
      ],
      { placeHolder: `API key for ${option.label} — a key is already stored` }
    );
    if (!action) return existing; // cancelled → keep working with the current key
    if (action.value === "keep") return existing;
    if (action.value === "remove") {
      await context.secrets.delete(secretKey);
      void vscode.window.showInformationMessage(`roots: removed API key for ${option.label}.`);
      return undefined;
    }
    // fall through to prompt for a replacement
  }

  const entered = await vscode.window.showInputBox({
    prompt: `Enter API key for ${option.label} (stored securely)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (entered) await context.secrets.store(secretKey, entered);
  return entered ?? undefined;
}

/**
 * Explicit "set / update API key" command. Lets the user pick a provider and
 * store, replace, or remove its key at any time — independent of model choice.
 */
async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  if (!engine) return;
  const all = await engine.listBackends();
  const presets = all.filter((o) => o.requiresApiKey && !o.customEndpoint);
  const cfg = vscode.workspace.getConfiguration("roots");
  const savedKind = cfg.get<string>("backend.kind", "");
  const savedBaseUrl = cfg.get<string>("backend.baseUrl", "");

  type Row = vscode.QuickPickItem & { option: BackendOption };
  const items: Row[] = presets.map((o) => ({ label: o.label, description: o.description, option: o }));

  // If a custom endpoint is currently configured, offer it here too so its
  // (possibly wrong) BYOK key can be replaced or removed.
  const isCustomConfigured = savedBaseUrl && !presets.some((o) => (o.baseUrl ?? "") === savedBaseUrl);
  if (isCustomConfigured) {
    const custom = all.find((o) => o.customEndpoint);
    items.unshift({
      label: `$(globe) Custom endpoint`,
      description: savedBaseUrl,
      option: {
        ...(custom ?? { kind: savedKind as BackendOption["kind"], description: "Custom · OpenAI-compatible", mode: "cloud" }),
        label: savedBaseUrl,
        baseUrl: savedBaseUrl,
        defaultModel: cfg.get<string>("backend.model", ""),
        requiresApiKey: true,
        customEndpoint: true,
      },
    });
  }

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Set API key for which provider?",
  });
  if (!picked) return;

  const option = picked.option;
  const baseUrl = option.baseUrl ?? savedBaseUrl;
  const key = await resolveApiKey(context, { ...option, baseUrl }, { allowReplace: true });
  if (key) void vscode.window.showInformationMessage(`roots: API key saved for ${option.label}.`);
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
