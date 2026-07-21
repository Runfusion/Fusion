import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/*
FNXC:WorkflowCutover 2026-07-19-03:40:
U10 (R9) TOMBSTONES — "the old world is gone and provably stays gone".

The IR-driven lifecycle cutover deleted the machinery that existed only for the period when the
workflow graph was NOT yet the sole authority over task lifecycle. Deleting it once is not enough:
each of these symbols was load-bearing for years, so a well-meaning re-introduction reads as a fix
rather than a regression. This test is the ratchet.

Two assertion shapes, deliberately cheap (grep-level, no engine boot — FN-5048: do not add slow
tests):
  1. FILES that must not come back.
  2. SYMBOLS that must not appear in EXECUTABLE source. Comments are stripped first: every deletion
     above left an explanatory FNXC tombstone naming the thing it removed, and those notes are the
     point — they must survive while the code must not.

Scope is production source only (`packages/<pkg>/src`, excluding `__tests__`). Test files may still
name a deleted symbol while asserting its absence, and docs/plans record the history.
*/

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

/** Production source roots scanned for tombstoned symbols. */
const SOURCE_ROOTS = ["packages/core/src", "packages/engine/src", "packages/dashboard/src", "packages/cli/src"];

/** Files whose deletion is itself the contract. */
const DELETED_FILES = [
  "packages/core/src/workflow-cutover.ts",
  "packages/engine/src/workflow-authoritative-driver.ts",
  "packages/engine/src/workflow-parity-observer.ts",
];

/**
 * Symbols that must not appear in executable source, with the reason each one is gone. The reason
 * is asserted-on text: a failure message that only says "symbol found" invites re-deletion without
 * understanding, which is how the machinery came back the first time.
 */
const DELETED_SYMBOLS: Array<{ symbol: string; why: string }> = [
  // Pre-graph cutover-readiness gating (workflow-cutover.ts).
  { symbol: "WORKFLOW_INTERPRETER_AUTHORITATIVE_FLAG", why: "the cutover it gated has happened; the graph is unconditionally authoritative" },
  { symbol: "evaluateInterpreterCutoverReadiness", why: "readiness evaluator for a completed cutover" },
  // Second in-process execution path (workflow-authoritative-driver.ts).
  { symbol: "WorkflowAuthoritativeDriver", why: "a second claimant for a task is no longer a fallback, it is a race" },
  { symbol: "workflowAuthoritativeDispatch", why: "the executor option that routed into that second path" },
  // Dual-observe parity chain (workflow-parity-observer.ts).
  { symbol: "maybeObserveWorkflowParity", why: "there is no second run to compare the graph against" },
  { symbol: "buildShadowObservation", why: "shadow-walk evidence for a parity comparison that no longer exists" },
  { symbol: "inferLegacyColumnSequence", why: "reconstructed the legacy column trail for parity evidence" },
  // Graph re-entry signalling (U5d).
  { symbol: "graphCompletionInterceptors", why: "shared per-task mutable state replaced by an explicit graphCompletion callback" },
  // Out-of-graph Plan Review gate (R4) — the graph owns Plan Review exclusively.
  { symbol: "runPlanReviewBeforeExecution", why: "triage and the graph raced on Plan Review; the graph owns it" },
  // In-session step reviewer (U10 pt2) — a second review authority inside the implementation session.
  { symbol: "createReviewStepTool", why: "review gates are graph nodes; an in-session reviewer duplicated Plan Review" },
  { symbol: "fn_review_step", why: "the deleted in-session review tool's name must not be re-injected" },
  { symbol: "reviewStepParams", why: "parameter schema for the deleted review tool" },
  { symbol: "throwDeferredReviewerFatal", why: "deferred provider-error channel that only existed because a tool handler cannot throw" },
  { symbol: "MAX_CODE_REVIEW_UNAVAILABLE_RETRIES", why: "UNAVAILABLE budget for the deleted in-session code review" },
  /*
  FNXC:WorkflowCutover 2026-07-19-18:10 (U10b / R9):
  The legacy EXECUTE fallback. `maybeExecuteWorkflowGraph` returned a boolean meaning "did the
  graph claim this task", and `false` handed the run to a legacy implementation path — an
  executor with no graph, no gates, and no owner for its completion. Deleting it is what lets
  `graphCompletion` be a required parameter instead of an optional one. These three names are the
  fallback's fingerprints: if any reappears, a second executor has come back with it.
  */
  { symbol: "maybeExecuteWorkflowGraph", why: "renamed executeWorkflowGraph and returns void — the graph cannot decline a task, so there is no 'maybe'" },
  { symbol: "transferPreHeldToLegacy", why: "re-registered the pre-held global concurrency slot for a legacy execute path that no longer exists" },
  { symbol: "workflow-selection-api-unavailable: store lacks a workflow-selection reader so the workflow graph cannot run ", why: "the OLD fail-closed reason, emitted only when the task had enabled steps; failing closed is now unconditional and carries a different reason" },
];

/** Strip block and line comments so an explanatory tombstone note is not read as a live reference. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

function collectSourceFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
}

describe("U10 (R9) legacy tombstones — deleted cutover machinery stays deleted", () => {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) collectSourceFiles(join(REPO_ROOT, root), files);

  it("scans a non-trivial production source set (guards against a silently empty sweep)", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it.each(DELETED_FILES)("file stays deleted: %s", (relativePath) => {
    expect(existsSync(join(REPO_ROOT, relativePath))).toBe(false);
  });

  it("no deleted symbol appears in executable production source", () => {
    const stripped = files.map((file) => ({ file, code: stripComments(readFileSync(file, "utf8")) }));
    const violations: string[] = [];
    for (const { symbol, why } of DELETED_SYMBOLS) {
      for (const { file, code } of stripped) {
        if (code.includes(symbol)) {
          violations.push(`${symbol} re-introduced in ${file.slice(REPO_ROOT.length + 1)} — deleted because ${why}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
