import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Codemap } from "./types.js";
import { assertCodemap } from "./validate.js";

const CODEMAP_DIR = path.join(".roots", "codemaps");

/**
 * Git-trackable codemap store: `.roots/codemaps/<id>.json` inside the repo.
 * Keeping artifacts in-repo gives shareable, diffable codemaps for free.
 */
export class CodemapStore {
  private readonly dir: string;

  constructor(private readonly repoRoot: string) {
    this.dir = path.join(path.resolve(repoRoot), CODEMAP_DIR);
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(id: string): string {
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
    return path.join(this.dir, `${safe}.json`);
  }

  save(codemap: Codemap): string {
    assertCodemap(codemap);
    this.ensureDir();
    const file = this.fileFor(codemap.id);
    fs.writeFileSync(file, JSON.stringify(codemap, null, 2) + "\n", "utf8");
    return file;
  }

  load(id: string): Codemap {
    const raw = JSON.parse(fs.readFileSync(this.fileFor(id), "utf8"));
    assertCodemap(raw);
    return raw;
  }

  list(): Codemap[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: Codemap[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8"));
        assertCodemap(raw);
        out.push(raw);
      } catch {
        // skip malformed files rather than failing the whole listing
      }
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  delete(id: string): void {
    const file = this.fileFor(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /** Best-effort current commit for repo metadata. */
  currentCommit(): string | undefined {
    const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: this.repoRoot,
      encoding: "utf8",
    });
    if (res.status === 0) return res.stdout.trim();
    return undefined;
  }
}
