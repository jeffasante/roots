import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Codemap } from "./types.js";

let cached: ValidateFunction | null = null;

function loadValidator(): ValidateFunction {
  if (cached) return cached;
  const schemaPath = resolveSchemaPath();
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  cached = ajv.compile(schema);
  return cached;
}

/** Locate schema/codemap.schema.json whether running from src or dist. */
function resolveSchemaPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../..", "schema/codemap.schema.json"),
    path.resolve(__dirname, "../..", "schema/codemap.schema.json"),
    path.resolve(process.cwd(), "schema/codemap.schema.json"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Could not locate codemap.schema.json");
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateCodemap(data: unknown): ValidationResult {
  const validate = loadValidator();
  const valid = validate(data) as boolean;
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`);
  return { valid, errors };
}

export function assertCodemap(data: unknown): asserts data is Codemap {
  const { valid, errors } = validateCodemap(data);
  if (!valid) {
    throw new Error(`Invalid codemap:\n${errors.join("\n")}`);
  }
}
