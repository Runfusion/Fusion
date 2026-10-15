#!/usr/bin/env node
/*
FNXC:PromptByteStability 2026-09-24-02:10 (RUFU-267):
A serialized system prompt only earns provider prefix caching when two consecutive same-role requests
are BYTE-IDENTICAL. Before RUFU-267 every lane interleaved runtime-mutable state (retrieved memory
bodies, live goal rows, rating summaries, per-card identity/policy blocks) into the system prompt, so
the shared prefix ended right after the role head — roughly 1.6k–2.8k bytes of a 2.8k–8k prompt — and
every volatile byte after it was re-billed per request.

The structural fix was to remove those fields from `PromptLayerInput` and move runtime state to the
end of the request (`buildRequestVolatileContext` / `appendRequestVolatileContext`). A type removal is
not a durable guard: a later author can re-add a field, pass a forced object past the type, or simply
concatenate the volatile block onto `systemPrompt` and reintroduce the exact defect with green tests.

This check is the ratchet. It refuses, in production sources:
  1. a volatile field name inside a system-prompt composition call;
  2. volatile content concatenated or interpolated into a `systemPrompt` / collapsed-layers value;
  3. a lane that composes prompt layers without also producing a request-tail block, i.e. volatile
     state that silently stopped being delivered instead of moving to the tail;
  4. a COLLAPSED instruction producer (`resolveAgentInstructions`, `resolveAgentInstructionsWithRatings`,
     `buildAgentChatPrompt`) whose result reaches a prompt-head composition slot, directly or through its
     one named binding — those helpers return config-time and runtime-mutable state as one string, so only
     the `*Parts` forms may feed a serialized system prompt.

Tests are exempt: the byte-stability suite must construct volatile states to prove head identity, and
stale-composition regressions are pinned by name in `prompt-layers.test.ts`.
*/
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCAN_ROOTS = ["packages/engine/src", "packages/dashboard/src", "packages/core/src"];
const SOURCE_PATTERN = /\.(?:ts|tsx|mts|cts)$/;
const TEST_PATH_PATTERN = /(^|\/)(__tests__|tests)\/|\.(?:test|spec)\./;

/** Builders whose output is (or feeds) the serialized system prompt. */
const COMPOSITION_BUILDERS = [
  "buildPromptLayers",
  "buildSystemPromptWithInstructions",
  "collapsePromptLayers",
];

/**
 * Field/content names that were removed from the composition API because their value changes between
 * two same-role requests. `identitySection`/`policySections`/`recallSection` are tail-only names: if
 * one appears inside a composition call the author is routing a tail block back into the head.
 */
const VOLATILE_COMPOSITION_FIELDS = [
  "memorySection",
  "goalContext",
  "performanceFeedback",
  "identitySection",
  "policySections",
  "recallSection",
  "ratingsSection",
  "steeringSection",
];

/** Value expressions that name runtime-mutable content; never legal inside a system-prompt value. */
const VOLATILE_VALUE_PATTERN = new RegExp(
  `\\b(?:${VOLATILE_COMPOSITION_FIELDS.join("|")})\\b`,
);

/*
A template interpolation (`${…}`) or a `+ identifier` join inside a prompt-composition value puts a
runtime value into the serialized head. `+ "literal"` joins are excluded: wrapping a long constant
across lines keeps the bytes identical.
*/
/*
FNXC:PromptByteStability 2026-09-24-06:40 (RUFU-267 code-review remediation):
Collapsed instruction producers return config-time and runtime-mutable prompt state as ONE string, so
their result is never a legal prompt-head input — only the `*Parts` forms keep `configTime` separable from
the memory and rating halves. `buildAgentChatPrompt` is the collapsed chat form: it joins the stable head
and the volatile `requestContext`.

The sinks are the seam builders plus any role wrapper whose callee ends in `PromptLayers` or `SystemPrompt`
(`buildTriagePromptLayers`, `buildReviewSystemPrompt`, …): a wrapper forwards its arguments straight into a
composition seam, so a collapsed producer reaching one is the same leak one call earlier. That is exactly
how the triage lane kept its planner head volatile after RUFU-267 shipped — the collapsed call sat ~190
lines before `buildTriagePromptLayers({ plannerInstructions: … })`, outside every composition call region,
so rule 1 could not see it and rule 3's file-level tail heuristic excused the whole file.
*/
const COLLAPSED_INSTRUCTION_PRODUCERS = [
  "resolveAgentInstructions",
  "resolveAgentInstructionsWithRatings",
  "buildAgentChatPrompt",
];
/*
FNXC:PromptByteStability 2026-09-24-06:25 (RUFU-267 code-review remediation, review finding P0-evidence):
A head sink is any callee that turns instructions into serialized system-prompt bytes. The RUFU-267 triage
defect reached the head through a lane-local wrapper that neither `buildPromptLayers` nor a `*SystemPrompt`
naming showed, so the pattern also accepts `*PromptLayers`, `*SystemPrompt`, and `*PromptContext` seams —
the latter is the head+tail composition seam a lane exposes for its prompt, whose `plannerInstructions`-
style argument still lands in the stable head. Renaming a real head sink out of these shapes is what this
rule cannot see, so the accompanying test drives the production seam instead of relying on the name.
*/
const HEAD_COMPOSITION_CALLEE = /\b(buildPromptLayers|buildSystemPromptWithInstructions|collapsePromptLayers|[A-Za-z_$][\w$]*PromptLayers|[A-Za-z_$][\w$]*SystemPrompt|[A-Za-z_$][\w$]*PromptContext)\s*\(/g;
/* Matches the binding a call result is assigned to: `x = await producer(` / `const x = producer(`. */
const ASSIGNMENT_TARGET_BEFORE_CALL = /\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s*)?$/;

const DYNAMIC_CONCAT_PATTERN = /\$\{|\+\s*(?!\d)[A-Za-z_$][\w$.]*\s*(?:\)|,|;|\n|$)/;

/** Request-tail producers that show a lane still delivers the state it removed from the head. */
const REQUEST_TAIL_PRODUCERS = [
  "buildRequestVolatileContext",
  "appendRequestVolatileContext",
  "withRequestVolatileContext",
];

function listTrackedSourceFiles() {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...SCAN_ROOTS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "git ls-files failed");
  return result.stdout
    .split("\0")
    .map((line) => line.trim())
    .filter((filePath) => filePath && SOURCE_PATTERN.test(filePath) && !TEST_PATH_PATTERN.test(filePath));
}

/**
 * Return [start, endExclusive) index pairs for each call to one of `COMPOSITION_BUILDERS`, matching
 * parentheses so nested calls and object literals stay inside the region.
 */
function findCallRegions(source, builder) {
  const regions = [];
  const needle = `${builder}(`;
  let from = 0;
  for (;;) {
    const open = source.indexOf(needle, from);
    if (open === -1) return regions;
    // Skip the occurrence when it is a declaration (`export function buildPromptLayers(`) or a member
    // access on an unrelated object (`pi.buildPromptLayers(` is not a lane composition call).
    const before = source.slice(Math.max(0, open - 40), open);
    const isDeclaration = /\b(?:export\s+)?(?:async\s+)?function\s+$/.test(before);
    let depth = 0;
    let close = -1;
    for (let i = open + needle.length - 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i + 1;
          break;
        }
      }
    }
    if (close !== -1 && !isDeclaration) regions.push([open, close]);
    from = (close === -1 ? open + needle.length : close) + 1;
  }
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

function offendingLine(source, index) {
  const line = source.split("\n")[lineOf(source, index) - 1] ?? "";
  return line.trim().slice(0, 160);
}

/** Call regions for every callee matching HEAD_COMPOSITION_CALLEE (seam builders and role wrappers). */
function findHeadCompositionRegions(source) {
  // Collect distinct callee names first: findCallRegions scans a name globally, so calling it per match
  // would re-report every later call site of the same wrapper once per occurrence.
  const callees = new Set();
  HEAD_COMPOSITION_CALLEE.lastIndex = 0;
  for (let match = HEAD_COMPOSITION_CALLEE.exec(source); match; match = HEAD_COMPOSITION_CALLEE.exec(source)) {
    callees.add(match[1]);
  }
  const regions = [];
  for (const callee of callees) regions.push(...findCallRegions(source, callee));
  return regions;
}

/**
 * Rule 4: a collapsed instruction producer's result must never reach a prompt-head composition slot.
 * Tracked forms: the call nested inside a head-composition region, or its result held by a named binding
 * that appears inside such a region. Tests are exempt (the byte-stability suite must construct both forms).
 */
export function scanCollapsedProducerIntoHead(filePath, source) {
  const headRegions = findHeadCompositionRegions(source);
  const violations = [];
  const assigned = new Map();

  for (const producer of COLLAPSED_INSTRUCTION_PRODUCERS) {
    for (const [start] of findCallRegions(source, producer)) {
      if (headRegions.some(([headStart, headEnd]) => start >= headStart && start < headEnd)) {
        violations.push({
          filePath,
          lineNumber: lineOf(source, start),
          rule: `${producer}() returns config-time and runtime-mutable state as one string; only the *Parts form may feed a serialized system prompt`,
          line: offendingLine(source, start),
        });
        continue;
      }
      const target = ASSIGNMENT_TARGET_BEFORE_CALL.exec(source.slice(Math.max(0, start - 120), start).trimEnd());
      if (target) assigned.set(target[1], { producer, index: start });
    }
  }

  for (const [name, { producer, index }] of assigned) {
    const identifier = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
    const reachedHead = headRegions.some(([headStart, headEnd]) => identifier.test(source.slice(headStart, headEnd)));
    if (reachedHead) {
      violations.push({
        filePath,
        lineNumber: lineOf(source, index),
        rule: `${producer}()'s collapsed result is held by \`${name}\`, which reaches a prompt-head composition slot — resolve the parts form and route the volatile halves to the request tail`,
        line: offendingLine(source, index),
      });
    }
  }
  return violations;
}

/** Rule 1 + 2: volatile names must not appear inside a composition call region. */
export function scanCompositionCalls(filePath, source) {
  const violations = [];
  for (const builder of COMPOSITION_BUILDERS) {
    for (const [start, end] of findCallRegions(source, builder)) {
      const region = source.slice(start, end);
      // A property named for a volatile block being passed INTO the composition seam is the regression.
      const fieldPattern = new RegExp(`(?:^|[,{(\\s])(?:${VOLATILE_COMPOSITION_FIELDS.join("|")})\\s*:`, "m");
      const match = fieldPattern.exec(region);
      if (match) {
        violations.push({
          filePath,
          lineNumber: lineOf(source, start + match.index),
          rule: `volatile field "${match[1] ?? match[0].trim()}" passed to ${builder}()`,
          line: offendingLine(source, start + match.index),
        });
      }
      // Rule 2: interpolating or concatenating a runtime VALUE into a composition call means state is
      // being glued onto the serialized prompt instead of moved to the request tail. Joining two string
      // LITERALS across lines is a formatting choice with stable bytes, so DYNAMIC_CONCAT_PATTERN excludes it.
      const concat = DYNAMIC_CONCAT_PATTERN.exec(region);
      if (concat) {
        violations.push({
          filePath,
          lineNumber: lineOf(source, start + concat.index),
          rule: `${builder}() argument interpolates/concatenates a value instead of composing config-time blocks`,
          line: offendingLine(source, start + concat.index),
        });
      }
    }
  }
  return violations;
}

/** Rule 2b: a `systemPrompt:` property value must be a config-time expression, never a concatenation. */
export function scanSystemPromptProperties(filePath, source) {
  const violations = [];
  const pattern = /\bsystemPrompt\s*:\s*/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const valueStart = match.index + match[0].length;
    const tail = source.slice(valueStart, valueStart + 400);
    // Read until the property's closing comma at depth 0 so nested calls stay in the value.
    let depth = 0;
    let value = "";
    for (let i = 0; i < tail.length; i += 1) {
      const ch = tail[i];
      if ("([{".includes(ch)) depth += 1;
      else if (")]}".includes(ch)) depth -= 1;
      if (ch === "," && depth === 0) break;
      value += ch;
    }
    const joined = value.trim();
    const concatenates = DYNAMIC_CONCAT_PATTERN.test(joined) || /\bconcat\(/.test(joined);
    const namesVolatile = VOLATILE_VALUE_PATTERN.test(joined);
    if (concatenates || namesVolatile) {
      violations.push({
        filePath,
        lineNumber: lineOf(source, valueStart),
        rule: namesVolatile
          ? "systemPrompt value names runtime-mutable content"
          : "systemPrompt value concatenates/interpolates instead of using collapsePromptLayers()",
        line: offendingLine(source, match.index),
      });
    }
  }
  return violations;
}

/**
 * Rule 3: a lane that composes layers *and* resolves runtime-mutable state must deliver that state on
 * the request tail. Composing layers from config-time input alone is legal (nothing was moved), so the
 * rule only fires where a volatile producer is also present.
 */
const VOLATILE_PRODUCER_PATTERN = /\b(?:resolveAgentInstructionPartsWithRatings|resolveAgentInstructionParts|resolveAgentInstructions|buildAgentChatPromptParts|buildAgentChatPrompt|retrieveMemory|recallMemory|resolveGoalContext|getRatingSummary|collectPerformanceFeedback)\b/;

export function scanMissingRequestTail(filePath, source) {
  const composes = COMPOSITION_BUILDERS.some((builder) => source.includes(`${builder}(`));
  if (!composes) return [];
  if (!VOLATILE_PRODUCER_PATTERN.test(source)) return [];
  if (REQUEST_TAIL_PRODUCERS.some((producer) => source.includes(`${producer}(`))) return [];
  const index = source.indexOf("buildPromptLayers(") !== -1
    ? source.indexOf("buildPromptLayers(")
    : source.indexOf("collapsePromptLayers(");
  return [{
    filePath,
    lineNumber: lineOf(source, index),
    rule: "composes prompt layers but never builds a request-tail block — runtime-mutable state was dropped, not relocated",
    line: offendingLine(source, index),
  }];
}

export function scanTrackedFiles(files = listTrackedSourceFiles()) {
  const violations = [];
  for (const filePath of files) {
    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    violations.push(...scanCompositionCalls(filePath, source));
    violations.push(...scanSystemPromptProperties(filePath, source));
    violations.push(...scanCollapsedProducerIntoHead(filePath, source));
    violations.push(...scanMissingRequestTail(filePath, source));
  }
  return violations.sort((a, b) => `${a.filePath}:${a.lineNumber}`.localeCompare(`${b.filePath}:${b.lineNumber}`));
}

export function formatFailureMessage(violations) {
  return [
    "[check-prompt-volatility] the serialized system prompt must be byte-identical across same-role requests.",
    "Runtime-mutable content (retrieved memory, goal rows, ratings, per-card identity/policy) does not belong in the system prompt:",
    "it ends the provider's shared prefix at the first volatile byte and re-bills everything after it on every request (measured pre-RUFU-267: 797–2807 bytes of a 2.8k–8k prompt).",
    "Keep the volatile block's wording and move its bytes to the end of the request that needs it via buildRequestVolatileContext()/appendRequestVolatileContext().",
    ...violations.map(({ filePath, lineNumber, rule, line }) => `${filePath}:${lineNumber}: ${rule}\n    ${line}`),
  ].join("\n");
}

export function main() {
  const violations = scanTrackedFiles();
  if (violations.length === 0) return 0;
  console.error(formatFailureMessage(violations));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}
