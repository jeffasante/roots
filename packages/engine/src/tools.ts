/**
 * Read-only analysis tools used by the agent's research phase.
 *
 * Everything here is confined to `repoRoot`. Paths are resolved and then
 * checked to still live under the root — this is the single trust boundary
 * for "read your code" access, so it is enforced in one place.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

/**
 * Directory names to skip during scans, kept language-agnostic on purpose so a
 * Rust `target/`, a Go `vendor/`, or a Python `.venv/` are all pruned the same
 * way a JS `node_modules/` is. Without this, build output (e.g. hundreds of
 * generated `.rs` files under `target/debug/deps`) floods the file inventory
 * and buries the real source the model should read.
 */
const DEFAULT_IGNORES = new Set([
  ".git",
  // JS / TS
  "node_modules",
  "dist",
  "out",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  // Python
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".tox",
  ".ipynb_checkpoints",
  "site-packages",
  // Rust
  "target",
  // Go
  "vendor",
  // Java / Kotlin / Gradle
  ".gradle",
  // General
  ".idea",
  ".roots",
]);

/** Directory-name suffixes to skip (glob-style names can't live in a Set). */
const IGNORE_SUFFIXES = [".egg-info"];

/** True when a directory entry should be pruned from scans. */
function isIgnoredDir(name: string): boolean {
  if (DEFAULT_IGNORES.has(name)) return true;
  return IGNORE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip files larger than 2MB during scans
const MAX_GREP_RESULTS = 200;
const MAX_FIND_RESULTS = 10_000;

export class Tools {
  constructor(private readonly repoRoot: string) {
    this.repoRoot = path.resolve(repoRoot);
  }

  /** Resolve a repo-relative (or absolute) path and confirm it stays inside the root. */
  private resolveInsideRoot(p: string): string {
    const abs = path.resolve(this.repoRoot, p);
    const rel = path.relative(this.repoRoot, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path escapes repository root: ${p}`);
    }
    return abs;
  }

  private toRepoRelative(abs: string): string {
    return path.relative(this.repoRoot, abs) || ".";
  }

  /** grep_tool — ripgrep-backed when available, otherwise a JS fallback. */
  grep(pattern: string, subPath?: string): GrepMatch[] {
    const searchRoot = subPath ? this.resolveInsideRoot(subPath) : this.repoRoot;
    const rg = this.grepWithRipgrep(pattern, searchRoot);
    if (rg !== null) return rg;
    return this.grepFallback(pattern, searchRoot);
  }

  private grepWithRipgrep(pattern: string, searchRoot: string): GrepMatch[] | null {
    const res = spawnSync(
      "rg",
      ["--line-number", "--no-heading", "--color=never", "--max-count", "50", pattern, "."],
      { cwd: searchRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
    );
    if (res.error) return null; // rg not installed
    if (res.status !== 0 && res.status !== 1) return null; // 1 = no matches, still valid
    const matches: GrepMatch[] = [];
    for (const raw of (res.stdout ?? "").split("\n")) {
      if (!raw) continue;
      const m = raw.match(/^(.+?):(\d+):(.*)$/);
      if (!m) continue;
      matches.push({
        file: this.toRepoRelative(path.resolve(searchRoot, m[1])),
        line: Number(m[2]),
        text: m[3].slice(0, 400),
      });
      if (matches.length >= MAX_GREP_RESULTS) break;
    }
    return matches;
  }

  private grepFallback(pattern: string, searchRoot: string): GrepMatch[] {
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
    const matches: GrepMatch[] = [];
    for (const file of this.walk(searchRoot)) {
      let content: string;
      try {
        if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
        content = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push({
            file: this.toRepoRelative(file),
            line: i + 1,
            text: lines[i].slice(0, 400),
          });
          if (matches.length >= MAX_GREP_RESULTS) return matches;
        }
      }
    }
    return matches;
  }

  /** find_by_name_tool — glob-ish match on file names/paths. */
  findByName(glob: string): string[] {
    const re = globToRegExp(glob);
    const results: string[] = [];
    for (const file of this.walk(this.repoRoot)) {
      const rel = this.toRepoRelative(file);
      if (re.test(rel) || re.test(path.basename(rel))) {
        results.push(rel);
        if (results.length >= MAX_FIND_RESULTS) break;
      }
    }
    return results;
  }

  /** list_dir_tool — one level of directory listing. */
  listDir(subPath?: string): { name: string; type: "file" | "dir" }[] {
    const dir = subPath ? this.resolveInsideRoot(subPath) : this.repoRoot;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => !isIgnoredDir(e.name))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? ("dir" as const) : ("file" as const) }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  }

  /** read_file_tool — optional 1-based inclusive line window. */
  readFile(subPath: string, start?: number, end?: number): { file: string; content: string; start_line: number; end_line: number } {
    const abs = this.resolveInsideRoot(subPath);
    const raw = fs.readFileSync(abs, "utf8");
    const lines = raw.split("\n");
    const s = Math.max(1, start ?? 1);
    const e = Math.min(lines.length, end ?? lines.length);
    const slice = lines.slice(s - 1, e);
    return {
      file: this.toRepoRelative(abs),
      content: slice.map((l, i) => `${s + i}\t${l}`).join("\n"),
      start_line: s,
      end_line: e,
    };
  }

  /** Verify a claimed location actually exists — used for groundedness checks. */
  locationExists(file: string, startLine: number, endLine: number): boolean {
    try {
      const abs = this.resolveInsideRoot(file);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      const total = fs.readFileSync(abs, "utf8").split("\n").length;
      return startLine >= 1 && endLine >= startLine && startLine <= total;
    } catch {
      return false;
    }
  }

  /** Depth-first file walk that skips ignored directories. */
  private *walk(dir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isIgnoredDir(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* this.walk(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + "$", "i");
}
