/**
 * Step-parser registry (U12, KTD-12).
 *
 * Step parsing becomes a graph-native node (`parse-steps`): a registry resolves
 * a parser id to an implementation that reads an artifact's content and yields a
 * canonical step list. Built-ins:
 *   - `step-headings` — the extracted `parseStepsFromPrompt` logic (the
 *     `### Step N:` regex + `(depends: …)` annotation from U1), plus a bounded
 *     fallback for plain `### Heading` entries inside `## Steps`; legacy callers
 *     in `store.ts` delegate to this exact function.
 *   - `json-steps` — a structured `[{ name, depends? }]` JSON document for
 *     workflows that plan in JSON.
 *
 * The registry mirrors the trait-registry posture: built-ins are protected from
 * override, and plugins register under namespaced ids
 * (`plugin:<pluginId>:<parserId>`). This module is engine-free and must NOT
 * import `store.ts` (store imports the extracted parser from here).
 *
 * Parsers may throw on malformed input; callers (the engine's parse-steps
 * handler) map a throw to a routable `outcome:parse-error`.
 */

import type { TaskStep } from "../types.js";

// ── Parser contract ──────────────────────────────────────────────────────────

/**
 * A parsed step as produced by a parser. `dependsOn` is 0-indexed (same
 * convention as the headings `(depends: …)` annotation).
 *
 * FNXC:WorkflowSteps 2026-06-29-17:55:
 * Parser output must preserve array presence: omitted `dependsOn` means legacy previous-step fallback, while explicit `dependsOn: []` means an independent parallel root.
 */
export interface ParsedStep {
  name: string;
  dependsOn?: number[];
}

/** The result of running a step parser over an artifact's content. */
export interface StepParseResult {
  steps: ParsedStep[];
}

/** A step parser. `parse` may throw on malformed input; the caller maps a throw
 *  to a routable parse-error outcome. */
export interface StepParser {
  id: string;
  parse(content: string): StepParseResult;
}

// ── Registration error ──────────────────────────────────────────────────────

/** Named reason codes for a rejected step-parser registration. */
export type StepParserRegistrationReason =
  | "duplicate-id"
  | "builtin-namespace-protected"
  | "invalid-id"
  | "invalid-definition";

export class StepParserRegistrationError extends Error {
  readonly reason: StepParserRegistrationReason;
  readonly parserId: string;
  constructor(reason: StepParserRegistrationReason, parserId: string, message: string) {
    super(message);
    this.name = "StepParserRegistrationError";
    this.reason = reason;
    this.parserId = parserId;
  }
}

// ── The registry ────────────────────────────────────────────────────────────

interface RegisteredParser {
  parser: StepParser;
  builtin: boolean;
}

/** Validate a plugin-namespaced parser id: `plugin:<pluginId>:<parserId>` with
 *  each segment a non-empty `[a-z0-9-]+` token. */
function isValidPluginParserId(id: string): boolean {
  const parts = id.split(":");
  if (parts.length !== 3) return false;
  if (parts[0] !== "plugin") return false;
  const seg = /^[a-z0-9-]+$/;
  return seg.test(parts[1]) && seg.test(parts[2]);
}

export class StepParserRegistry {
  private readonly parsers = new Map<string, RegisteredParser>();

  /** Register a parser. Built-in ids cannot be overridden by non-builtins; a
   *  non-builtin must use a `plugin:<pluginId>:<parserId>` id. */
  register(parser: StepParser, opts?: { builtin?: boolean }): void {
    const builtin = opts?.builtin ?? false;
    if (!parser || typeof parser.id !== "string" || parser.id === "") {
      throw new StepParserRegistrationError(
        "invalid-definition",
        String(parser?.id),
        "Step parser must have a non-empty string id",
      );
    }
    if (typeof parser.parse !== "function") {
      throw new StepParserRegistrationError(
        "invalid-definition",
        parser.id,
        `Step parser '${parser.id}' must have a parse() function`,
      );
    }

    // Existing-id checks first (built-in protection, then duplicate) so a
    // non-builtin trying to overwrite a built-in surfaces the protection reason
    // rather than the id-shape reason.
    const existing = this.parsers.get(parser.id);
    if (existing) {
      if (!builtin && existing.builtin) {
        throw new StepParserRegistrationError(
          "builtin-namespace-protected",
          parser.id,
          `Step parser id '${parser.id}' is a built-in parser and cannot be overridden by a non-builtin registration`,
        );
      }
      throw new StepParserRegistrationError(
        "duplicate-id",
        parser.id,
        `Step parser id '${parser.id}' is already registered`,
      );
    }

    if (!builtin && !isValidPluginParserId(parser.id)) {
      throw new StepParserRegistrationError(
        "invalid-id",
        parser.id,
        `Non-builtin step parser '${parser.id}' must use a namespaced id of the form 'plugin:<pluginId>:<parserId>'`,
      );
    }

    this.parsers.set(parser.id, { parser, builtin });
  }

  getParser(id: string): StepParser | undefined {
    return this.parsers.get(id)?.parser;
  }

  has(id: string): boolean {
    return this.parsers.has(id);
  }

  listParsers(): StepParser[] {
    return [...this.parsers.values()].map((r) => r.parser);
  }

  /** Remove a parser. Built-ins are never removed (callers should only pass
   *  plugin-namespaced ids — e.g. for plugin teardown). Returns true if a
   *  non-builtin parser was present and removed. */
  unregister(id: string): boolean {
    const existing = this.parsers.get(id);
    if (!existing || existing.builtin) return false;
    return this.parsers.delete(id);
  }
}

// ── Built-in: step-headings ───────────────────────────────────────────────────

/**
 * Parse `### Step N:` headings into the task step list (step-inversion U1).
 *
 * Backward compatibility is exact: an UNannotated heading parses byte-identically
 * to the legacy regex `^###\s+Step\s+\d+[^:]*:\s*(.+)$` (name = text after the
 * first colon, trimmed).
 *
 * The annotation `### Step N (depends: 1,2): Title` is parsed explicitly (the
 * legacy regex breaks on the colon inside `depends:`): depends values are
 * 1-indexed step numbers in the document and are stored as 0-indexed indices on
 * `dependsOn` (deduped, sorted, dropping values <= 0). An empty `(depends:)`
 * annotation is preserved as `dependsOn: []` so planners can explicitly mark a
 * non-first step as independent; an absent annotation remains implicit previous-step
 * dependency.
 *
 * Malformed `(depends: …)` annotations fall back deterministically: the heading
 * is treated as `### Step N:` with the name starting after the FIRST colon
 * following the closing paren (if present), else after the first colon — and no
 * `dependsOn` is recorded.
 */
export function parseStepHeadings(content: string): TaskStep[] {
  const steps: TaskStep[] = [];
  // Legacy matcher — UNCHANGED from the original implementation, so unannotated
  // headings (and every legacy edge case, including `[^:]*` spanning newlines)
  // parse byte-identically. The full match (`m[0]`) is re-inspected only to layer
  // the `(depends: …)` annotation on top.
  const stepRegex = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
  // Well-formed annotation form: `### Step N (depends: …): name`.
  const annotatedRegex = /^###\s+Step\s+\d+\s*\(depends:\s*([^)]*)\)\s*:\s*([^\n]+)$/;

  let match: RegExpExecArray | null;
  while ((match = stepRegex.exec(content)) !== null) {
    const full = match[0];

    // No annotation present → byte-identical legacy behavior.
    if (!full.includes("(depends:")) {
      steps.push({ name: match[1].trim(), status: "pending" });
      continue;
    }

    // 1) Well-formed depends annotation.
    const annotated = annotatedRegex.exec(full);
    if (annotated) {
      const parsed = parseDependsList(annotated[1]);
      const name = annotated[2].trim();
      if (parsed !== null) {
        /*
        FNXC:WorkflowSteps 2026-06-29-22:49:
        Empty depends annotations are explicit planner intent, not missing metadata. Preserve `dependsOn: []` so parallel foreach scheduling treats this step as an independent root while unannotated headings still fall back to previous-step ordering.
        */
        steps.push({ name, status: "pending", dependsOn: parsed });
        continue;
      }
    }

    // 2) Annotation present but unparseable (bad values or no closing paren):
    //    deterministic fallback — name starts after the FIRST colon following the
    //    closing paren if present, else after the first colon. Operate on the
    //    first line of the match only (the heading line itself).
    const line = full.split("\n")[0];
    const parenIdx = line.indexOf(")");
    const colonAfterParen = parenIdx >= 0 ? line.indexOf(":", parenIdx) : -1;
    const colonIdx = colonAfterParen >= 0 ? colonAfterParen : line.indexOf(":");
    if (colonIdx >= 0) {
      const fallbackName = line.slice(colonIdx + 1).trim();
      if (fallbackName) steps.push({ name: fallbackName, status: "pending" });
    }
  }
  if (steps.length > 0) return steps;

  const stepsSection = extractStepsSection(content);
  if (!stepsSection) return steps;
  const plainHeadingRegex = /^###\s+(?!Step\s+\d+\b)(.+?)\s*$/gm;
  while ((match = plainHeadingRegex.exec(stepsSection)) !== null) {
    const name = match[1].trim();
    if (name) steps.push({ name, status: "pending" });
  }
  return steps;
}

/*
FNXC:WorkflowSteps 2026-06-30-00:54:
Default Coding parses PROMPT.md before step execution. FN-7260/FN-7271 specs used plain `### Preflight`/`### Implementation` headings under `## Steps`; the previous parser returned zero steps, so fast-mode tasks reached merge with no implementation session. Accept plain third-level headings only inside the Steps section, and only when no legacy `### Step N:` headings were found, so unrelated spec sections do not become executable work.
*/
function extractStepsSection(content: string): string | undefined {
  const sectionMatch = /^##\s+Steps\s*$/gim.exec(content);
  if (!sectionMatch) return undefined;
  const start = sectionMatch.index + sectionMatch[0].length;
  const rest = content.slice(start);
  const nextSection = /^##\s+(?!#)/gm.exec(rest);
  return nextSection ? rest.slice(0, nextSection.index) : rest;
}

/** Parse a `depends:` value list (1-indexed step numbers) into 0-indexed,
 *  deduped, sorted indices. Returns null if any token is not a positive integer. */
function parseDependsList(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const tokens = trimmed.split(",").map((t) => t.trim());
  const out = new Set<number>();
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return null;
    const n = Number(token);
    if (!Number.isInteger(n) || n < 1) return null;
    out.add(n - 1);
  }
  return [...out].sort((a, b) => a - b);
}

// ── Built-in: json-steps ──────────────────────────────────────────────────────

/**
 * Parse a JSON document: an array of `{ name: string, depends?: number[] }`.
 * `depends` values are 1-indexed step numbers in the document (same convention
 * as the headings annotation), converted to 0-indexed `dependsOn` (deduped,
 * sorted). Omitted `depends` means implicit previous-step dependency; explicit
 * `depends: []` is preserved as no dependencies. Throws a descriptive error on
 * any malformed input (not JSON, not an array, missing/blank name, bad depends).
 */
export function parseJsonSteps(content: string): StepParseResult {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `json-steps: content is not valid JSON: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(doc)) {
    throw new Error("json-steps: document must be a JSON array of step objects");
  }

  const steps: ParsedStep[] = [];
  doc.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`json-steps: step at index ${i} must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const name = obj.name;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(
        `json-steps: step at index ${i} must have a non-empty string 'name'`,
      );
    }

    const step: ParsedStep = { name: name.trim() };

    if (obj.depends !== undefined) {
      if (!Array.isArray(obj.depends)) {
        throw new Error(
          `json-steps: step at index ${i} 'depends' must be an array of positive integers`,
        );
      }
      const out = new Set<number>();
      for (const raw of obj.depends) {
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
          throw new Error(
            `json-steps: step at index ${i} 'depends' must contain only positive integers (1-indexed step numbers); got ${JSON.stringify(raw)}`,
          );
        }
        out.add(raw - 1);
      }
      const dependsOn = [...out].sort((a, b) => a - b);
      step.dependsOn = dependsOn;
    }

    steps.push(step);
  });

  return { steps };
}

// ── Built-in parser definitions ───────────────────────────────────────────────

const BUILTIN_STEP_PARSERS: StepParser[] = [
  {
    id: "step-headings",
    parse(content: string): StepParseResult {
      // The headings parser yields TaskStep[]; map to the parser contract
      // (dropping the `status` field, which the caller re-applies).
      const steps = parseStepHeadings(content).map((s) => {
        const out: ParsedStep = { name: s.name };
        if (Array.isArray(s.dependsOn)) out.dependsOn = s.dependsOn;
        return out;
      });
      return { steps };
    },
  },
  {
    id: "json-steps",
    parse: parseJsonSteps,
  },
];

/** Register the built-in step parsers into the given registry (defaults to the
 *  shared registry). Idempotent via `has`. */
export function registerBuiltinStepParsers(
  registry: StepParserRegistry = getStepParserRegistry(),
): void {
  for (const parser of BUILTIN_STEP_PARSERS) {
    if (registry.has(parser.id)) continue;
    registry.register(parser, { builtin: true });
  }
}

// ── Module-level default registry ───────────────────────────────────────────

let defaultRegistry: StepParserRegistry | undefined;

export function getStepParserRegistry(): StepParserRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new StepParserRegistry();
    registerBuiltinStepParsers(defaultRegistry);
  }
  return defaultRegistry;
}

/** Test-only: reset the shared registry (so built-in registration can be
 *  re-exercised in isolation). */
export function __resetStepParserRegistryForTests(): void {
  defaultRegistry = undefined;
}

// ── Convenience pass-throughs to the default registry ────────────────────────

export function registerStepParser(parser: StepParser, opts?: { builtin?: boolean }): void {
  getStepParserRegistry().register(parser, opts);
}

export function getStepParser(id: string): StepParser | undefined {
  return getStepParserRegistry().getParser(id);
}

export function listStepParsers(): StepParser[] {
  return getStepParserRegistry().listParsers();
}

export function unregisterStepParser(id: string): boolean {
  return getStepParserRegistry().unregister(id);
}

// Register built-ins into the shared registry on import (idempotent via `has`).
registerBuiltinStepParsers();
