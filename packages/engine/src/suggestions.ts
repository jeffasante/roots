import type { InferenceBackend } from "./backends/types.js";
import { Tools } from "./tools.js";

export interface CodemapSuggestion {
  title: string;
  description: string;
  query: string;
}

export async function suggestCodemaps(
  backend: InferenceBackend,
  repoRoot: string
): Promise<CodemapSuggestion[]> {
  const tools = new Tools(repoRoot);
  const rootEntries = tools.listDir().slice(0, 40);
  const directories = rootEntries.filter((entry) => entry.type === "dir").slice(0, 8);
  const snapshot: Record<string, unknown> = { root: rootEntries };

  for (const directory of directories) {
    try {
      snapshot[directory.name] = tools.listDir(directory.name).slice(0, 24);
    } catch {
      // A directory may disappear while the snapshot is being collected.
    }
  }

  const response = await backend.chat({
    jsonMode: true,
    temperature: 0.35,
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content: `You suggest useful code flows for a developer to explore as codemaps.
Return JSON only in this exact shape:
{"suggestions":[{"title":"short title","description":"one concrete sentence","query":"detailed codemap generation prompt"}]}
Rules:
- Return exactly 3 suggestions.
- Base them only on the repository snapshot provided. Do not invent frameworks or features.
- Prefer end-to-end flows, subsystem boundaries, lifecycle logic, authentication, routing, persistence, or background processing.
- Titles must be under 55 characters; descriptions under 120 characters.
- Queries should name likely files/directories from the snapshot and ask roots to trace how the flow works.`,
      },
      { role: "user", content: `Repository snapshot:\n${JSON.stringify(snapshot)}` },
    ],
  });

  const suggestions = parseSuggestions(response.content);
  return suggestions.length > 0 ? suggestions : fallbackSuggestions(rootEntries, directories);
}

export function parseSuggestions(content: string): CodemapSuggestion[] {
  const cleaned = extractJson(content);
  try {
    const parsed = JSON.parse(cleaned) as { suggestions?: unknown[] } | unknown[];
    const items = Array.isArray(parsed) ? parsed : parsed.suggestions;
    if (!Array.isArray(items)) return [];
    return items
      .filter(isSuggestion)
      .slice(0, 3)
      .map((item) => ({
        title: item.title.trim().slice(0, 55),
        description: item.description.trim().slice(0, 120),
        query: item.query.trim().slice(0, 600),
      }));
  } catch {
    return [];
  }
}

function extractJson(content: string): string {
  const withoutFences = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const objectStart = withoutFences.indexOf("{");
  const arrayStart = withoutFences.indexOf("[");
  const start = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return withoutFences;

  const opener = withoutFences[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < withoutFences.length; index++) {
    const character = withoutFences[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opener) depth++;
    else if (character === closer && --depth === 0) return withoutFences.slice(start, index + 1);
  }
  return withoutFences.slice(start);
}

function fallbackSuggestions(
  rootEntries: { name: string; type: string }[],
  directories: { name: string; type: string }[]
): CodemapSuggestion[] {
  const directoryNames = directories.map((entry) => entry.name);
  const rootFiles = rootEntries.filter((entry) => entry.type === "file").map((entry) => entry.name).slice(0, 4);
  const primary = directoryNames[0] ?? ".";
  const secondary = directoryNames[1];
  const boundary = secondary ? `${primary} and ${secondary}` : `${primary} and the repository root`;
  const entrypoints = rootFiles.length > 0 ? rootFiles.join(", ") : "root configuration files";

  return [
    {
      title: `Trace ${primary} initialization`.slice(0, 55),
      description: `Follow startup from ${entrypoints} into ${primary}.`.slice(0, 120),
      query: `Trace how ${primary} is initialized from ${entrypoints}, including its entry points, configuration, and calls into other repository modules.`,
    },
    {
      title: "Map package boundaries",
      description: `Explain the runtime and dependency boundary between ${boundary}.`.slice(0, 120),
      query: `Map how ${boundary} interact. Identify public entry points, shared types, configuration, and the concrete call flow across the boundary.`,
    },
    {
      title: "Trace configuration flow",
      description: `Follow configuration from ${entrypoints} into runtime code.`.slice(0, 120),
      query: `Trace how configuration from ${entrypoints} is loaded, validated, and consumed by ${primary} and related modules.`,
    },
  ];
}

function isSuggestion(value: unknown): value is CodemapSuggestion {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CodemapSuggestion>;
  return Boolean(item.title?.trim() && item.description?.trim() && item.query?.trim());
}