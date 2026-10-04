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
 * A parsed step as produced by a parser. `dependsOn` is always a 0-indexed
 * persisted document index. Prefix Markdown `(depends:)` tokens use 1-based
 * positions. Legacy title-suffix annotations use contiguous authored heading labels.
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
 * Prefix annotations `### Step N (depends: 1,2): Title` use 1-based document positions.
 * Legacy suffix annotations `### Step N: Title (depends: 0)` use authored labels,
 * but only when the complete heading sequence is contiguous and starts at 0 or 1.
 * Both forms preserve an empty annotation as an explicit independent root and
 * validate every dependency before returning steps. Ambiguous or malformed input fails closed.
 */
export interface StepHeadingMatch {
  headingNumber: number;
  index: number;
  headingLineEnd: number;
  match: string;
}

/*
FNXC:WorkflowSteps 2026-09-05-22:06:
Every consumer deciding whether text is a step heading must use this matcher. A private stricter
matcher hid documented `(depends: …)` headings, causing false contiguity failures and empty step bodies.
*/
export function matchStepHeadings(content: string): StepHeadingMatch[] {
  const stepRegex = /^###\s+Step\s+\d+[^:]*:\s*(.+)$/gm;
  const matches: StepHeadingMatch[] = [];
  let match: RegExpExecArray | null;
  while ((match = stepRegex.exec(content)) !== null) {
    const heading = /^###\s+Step\s+(\d+)/.exec(match[0]);
    if (!heading) continue;
    const index = match.index;
    const newline = content.indexOf("\n", index);
    matches.push({
      headingNumber: Number(heading[1]),
      index,
      headingLineEnd: newline === -1 ? content.length : newline,
      match: match[0],
    });
  }
  return matches;
}

export type StepDependencyCoordinate = "markdown-position" | "storage-index";
export type StepDependencyValidationReason = "malformed" | "zero" | "negative" | "duplicate" | "out-of-range" | "self-or-forward" | "cycle";

/** A stable, task-visible dependency refusal with the original bad token. */
export class StepDependencyValidationError extends Error {
  readonly coordinate: StepDependencyCoordinate;
  readonly dependentPosition: number;
  readonly token: string | number;
  readonly reason: StepDependencyValidationReason;
  readonly stepCount: number;

  constructor(params: { coordinate: StepDependencyCoordinate; dependentPosition: number; token: string | number; reason: StepDependencyValidationReason; stepCount: number }) {
    const { coordinate, dependentPosition, token, reason, stepCount } = params;
    const displayed = coordinate === "markdown-position" ? token : Number(token) + 1;
    const prefix = `step ${dependentPosition} depends on`;
    const message = reason === "out-of-range"
      ? `${prefix} out-of-range step ${displayed} (valid positions: 1-${stepCount})`
      : `${prefix} invalid step ${displayed} (${reason})`;
    super(message);
    this.name = "StepDependencyValidationError";
    this.coordinate = coordinate;
    this.dependentPosition = dependentPosition;
    this.token = token;
    this.reason = reason;
    this.stepCount = stepCount;
  }
}

/** Validate persisted 0-based dependency edges without changing their coordinate system. */
export function validateStepDependencies(steps: readonly Pick<ParsedStep, "dependsOn">[]): void {
  const visit = (index: number, visiting: Set<number>, visited: Set<number>): void => {
    if (visiting.has(index)) {
      throw new StepDependencyValidationError({ coordinate: "storage-index", dependentPosition: index + 1, token: index, reason: "cycle", stepCount: steps.length });
    }
    if (visited.has(index)) return;
    visiting.add(index);
    const deps = steps[index]?.dependsOn;
    if (Array.isArray(deps)) {
      const seen = new Set<number>();
      for (const dependency of deps) {
        const base = { coordinate: "storage-index" as const, dependentPosition: index + 1, token: dependency, stepCount: steps.length };
        if (!Number.isInteger(dependency)) throw new StepDependencyValidationError({ ...base, reason: "malformed" });
        if (dependency < 0) throw new StepDependencyValidationError({ ...base, reason: "negative" });
        if (dependency >= steps.length) throw new StepDependencyValidationError({ ...base, reason: "out-of-range" });
        if (seen.has(dependency)) throw new StepDependencyValidationError({ ...base, reason: "duplicate" });
        /*
        FNXC:StepDependencyValidation 2026-10-01-02:31:
        Persisted and plugin parser edges use 0-based storage indexes, but each prerequisite must
        precede its dependent. Reject a future or self edge before DFS so foreach never schedules
        a step before an invalid prerequisite, even when the graph is not cyclic.
        */
        if (dependency >= index) throw new StepDependencyValidationError({ ...base, reason: "self-or-forward" });
        seen.add(dependency);
        if (visiting.has(dependency)) throw new StepDependencyValidationError({ ...base, reason: "cycle" });
        visit(dependency, visiting, visited);
      }
    }
    visiting.delete(index);
    visited.add(index);
  };
  const visited = new Set<number>();
  for (let index = 0; index < steps.length; index++) visit(index, new Set(), visited);
}

export function parseStepHeadings(content: string): TaskStep[] {
  const annotatedRegex = /^###\s+Step\s+\d+\s*\(depends:\s*([^)]*)\)\s*:\s*([^\n]+)$/;
  const suffixRegex = /^###\s+Step\s+\d+\s*:\s*(.+?)\s+\(depends:\s*([^)]*)\)\s*$/;
  const matches = matchStepHeadings(content);
  const legacyOffset = matches[0]?.headingNumber;
  const unambiguousLegacyLabels = (legacyOffset === 0 || legacyOffset === 1)
    && matches.every((entry, index) => entry.headingNumber === index + legacyOffset);
  const steps: TaskStep[] = [];
  const pendingDependencies: Array<{ position: number; raw: string; offset: number } | undefined> = [];

  for (const entry of matches) {
    const annotated = annotatedRegex.exec(entry.match);
    const suffix = suffixRegex.exec(entry.match);
    const annotations = entry.match.split("(depends:").length - 1;
    if (annotations > 1 || (annotations > 0 && !annotated && !suffix)
      || (suffix && !unambiguousLegacyLabels)) {
      throw new StepDependencyValidationError({ coordinate: "markdown-position", dependentPosition: steps.length + 1, token: entry.match, reason: "malformed", stepCount: matches.length });
    }
    const name = annotated?.[2] ?? suffix?.[1] ?? /^###\s+Step\s+\d+[^:]*:\s*(.+)$/m.exec(entry.match)?.[1] ?? "";
    steps.push({ name: name.trim(), status: "pending" });
    pendingDependencies.push(annotated
      ? { position: steps.length, raw: annotated[1], offset: 1 }
      : suffix ? { position: steps.length, raw: suffix[2], offset: legacyOffset! } : undefined);
  }
  if (steps.length > 0) {
    for (const pending of pendingDependencies) {
      if (!pending) continue;
      const raw = pending.raw.trim();
      if (raw === "") { steps[pending.position - 1]!.dependsOn = []; continue; }
      const seen = new Set<number>();
      const dependencies: number[] = [];
      for (const token of raw.split(",").map((value) => value.trim())) {
        const base = { coordinate: "markdown-position" as const, dependentPosition: pending.position, token, stepCount: steps.length };
        if (!/^-?\d+$/.test(token)) throw new StepDependencyValidationError({ ...base, reason: "malformed" });
        const value = Number(token);
        if (value === 0 && pending.offset === 1) throw new StepDependencyValidationError({ ...base, reason: "zero" });
        if (value < 0) throw new StepDependencyValidationError({ ...base, reason: "negative" });
        const dependency = value - pending.offset;
        if (dependency >= steps.length) throw new StepDependencyValidationError({ ...base, reason: "out-of-range" });
        if (seen.has(value)) throw new StepDependencyValidationError({ ...base, reason: "duplicate" });
        if (dependency >= pending.position - 1) throw new StepDependencyValidationError({ ...base, reason: "self-or-forward" });
        seen.add(value);
        dependencies.push(dependency);
      }
      steps[pending.position - 1]!.dependsOn = dependencies;
    }
    validateStepDependencies(steps);
    return steps;
  }

  const stepsSection = extractStepsSection(content);
  if (!stepsSection) return steps;
  const plainHeadingRegex = /^###\s+(?!Step\s+\d+\b)(.+?)\s*$/gm;
  let match: RegExpExecArray | null;
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

/*
FNXC:WorkflowStepControl 2026-09-04-01:38:
PROMPT.md is model-authored, but its heading numbers are execution indices. A fully 1-based run
previously produced a phantom step at steps.length, so only that unambiguous legacy sequence rebases.

FNXC:WorkflowSteps 2026-09-04-02:57:
Headings, file scopes, and dependency annotations must share one authored-heading offset rule so
canonical 0-based plans and preserved fully-1-based legacy plans cannot drift between packages.
*/
export function resolveAuthoredStepHeadingOffset(headingNumbers: readonly number[]): 0 | 1 {
  const sorted = [...headingNumbers].sort((a, b) => a - b);
  return sorted.length > 0 && sorted.every((heading, index) => heading === index + 1) ? 1 : 0;
}

// ── Built-in: json-steps ──────────────────────────────────────────────────────

/**
 * Parse a JSON document: an array of `{ name: string, depends?: number[] }`.
 * `depends` values are 0-indexed document indices (deduped, sorted). Omitted
 * `depends` means implicit previous-step dependency; explicit
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
          `json-steps: step at index ${i} 'depends' must be an array of 0-based document indices`,
        );
      }
      for (const raw of obj.depends) {
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
          throw new Error(
            `json-steps: step at index ${i} 'depends' must contain only 0-based document indices; got ${JSON.stringify(raw)}`,
          );
        }
      }
      step.dependsOn = [...obj.depends] as number[];
    }

    steps.push(step);
  });

  validateStepDependencies(steps);
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
