/**
 * Core data model for roots. Mirrors schema/codemap.schema.json.
 * The `.codemap` artifact is the contract every other layer depends on.
 */

export type InferenceMode = "cloud" | "local";

export interface ModelMeta {
  backend: string;
  model_name: string;
  mode: InferenceMode;
}

export interface RepoMeta {
  root: string;
  commit?: string;
}

export interface Location {
  /** Repo-relative path. */
  file: string;
  /** 1-based inclusive. */
  start_line: number;
  /** 1-based inclusive. */
  end_line: number;
}

/**
 * Per-trace honesty signal. Two independent dimensions so we never conflate
 * "the code is really here" with "the explanation is actually supported".
 */
export interface Confidence {
  /**
   * Deterministic: do this trace's locations actually resolve in the repo?
   * Computed with no model call (file exists + line range valid, symbol match
   * when available). A trace with zero surviving locations is NOT verified.
   */
  location_verified: boolean;

  /**
   * How the location was confirmed, for surfacing an honest badge in the UI.
   * - "symbol": a named symbol was matched at the cited line (strongest).
   * - "file_line": file + line range exist but no symbol was checked.
   * - "none": nothing resolved.
   */
  location_evidence: "symbol" | "file_line" | "none";

  /**
   * Probabilistic: does a second-pass read of the resolved code still support
   * the claim in `summary`? 0..1 from a dedicated grounding call, separate from
   * the synthesis pass that wrote the summary. Optional so `location_verified`
   * can ship alone and grounding scores be backfilled without a schema break.
   */
  summary_grounded?: number;
}

export interface Trace {
  id: string;
  title: string;
  summary: string;
  motivation?: string;
  details?: string;
  locations: Location[];
  children?: string[];
  /** Optional: absent on legacy codemaps produced before the verification pass. */
  confidence?: Confidence;
}

export interface Diagram {
  format: "mermaid";
  content: string;
}

export interface LogEntry {
  tool: string;
  input: unknown;
  output?: unknown;
  error?: string;
  ts?: string;
}

export interface Codemap {
  version: string;
  id: string;
  query: string;
  /** Narrative summary of the whole flow, referencing traces by id like [1a]. */
  overview?: string;
  created_at: string;
  model: ModelMeta;
  repo: RepoMeta;
  traces: Trace[];
  diagram?: Diagram;
  log?: LogEntry[];
}

export const CODEMAP_VERSION = "1.0";
