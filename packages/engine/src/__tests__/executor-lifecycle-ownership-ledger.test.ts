/*
FNXC:WorkflowExecutionOwnership 2026-07-27-16:10 (U8 / R4, R12 — workflow-owned lifecycle):

U8's goal has one measurable form: **the executor stops deciding what happens next.**
"executor.ts got smaller" does not measure it (a 3,000-line method can shrink while every
lifecycle decision stays exactly where it was), and "the suite is green" measures it least of
all — every disposition counted below already has passing tests, because each one was correct
behavior when it was written. What is wrong is the OWNER, not the behavior.

So this is a LEDGER, not an assertion about correctness. It counts, inside the two junction-box
methods, the call sites where the executor performs a lifecycle disposition ITSELF, against the
sites where it hands the decision back to the graph. Every number here is measured from source,
not estimated.

  runImplementation   — the implementation phase (the agent session and every way out of it)
  handleGraphFailure  — the sink every non-success graph run drains into

WHY THE COUNTS ARE THE POINT. The execute seam collapses that entire implementation phase to one
boolean (`result.taskDone` -> "implemented" | "implementation-incomplete"). The graph therefore
has no vocabulary for "the agent stopped because a review is pending" or "paused after
completing" — so the executor transitions the card itself and the graph finds out afterwards.
`handleGraphFailure`'s `alreadyFinalizedToReview` / `completionFinalized` classifiers exist for
exactly that reason: they are compensation for a transition performed behind the graph's back.
Widening the seam's outcome vocabulary is what lets those counts fall; deleting the compensation
is what proves they fell.

DIRECTION OF TRAVEL. The executor-owned numbers may only go DOWN, and a decrement must land with
the disposition visible as a graph outcome — not merely deleted. An increment is a new
out-of-graph lifecycle decision and needs an explicit justification in its PR, not a quiet edit
to the constant below.

RELATION TO U12. The plan's `no-out-of-graph-lifecycle-writes.test.ts` ratchet is the endpoint of
this ledger: once the counts reach their floor, the assertion becomes "zero, outside the
allowlist" and this file is where that allowlist grows up. Seeded here because a ratchet written
after the migration cannot prove the migration happened.

SELF-CHECK DISCIPLINE. A source-scanning guard that silently matches nothing passes forever. The
extraction is therefore range-checked (`it("extracts …")`) so a brace-matching or
comment-stripping failure fails loudly instead of reporting a comfortable zero.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "executor.ts");

/** Strip block and line comments so FNXC prose is never counted as a call site. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/**
 * Extract a class method body by brace matching from its declaration.
 * Returns the body text, or throws — a silent miss would make every count zero.
 */
function extractMethodBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start === -1) throw new Error(`method declaration not found: ${declaration}`);
  const open = source.indexOf("{", start);
  if (open === -1) throw new Error(`no method body found for: ${declaration}`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting: ${declaration}`);
}

function count(body: string, needle: string): number {
  return body.split(needle).length - 1;
}

const SOURCE = stripComments(readFileSync(EXECUTOR_PATH, "utf8"));
const RUN_IMPLEMENTATION = extractMethodBody(SOURCE, "private async runImplementation(");
const HANDLE_GRAPH_FAILURE = extractMethodBody(SOURCE, "private async handleGraphFailure(");

/**
 * The three ways the executor performs a lifecycle disposition itself. `moveTask` already
 * resolves its target through `resolveReboundColumnFor` (U5b), so this counts WHO DECIDES the
 * transition, not which column id it names.
 */
const EXECUTOR_OWNED = [
  { label: "column transitions (store.moveTask)", needle: "this.store.moveTask(" },
  { label: "review transitions (handoffTaskToReview)", needle: "this.handoffTaskToReview(" },
  { label: "terminal parks (status: \"failed\")", needle: "status: \"failed\"" },
] as const;

/** The one way the implementation phase hands the decision back to the graph. */
const GRAPH_HANDBACK = { label: "graph handbacks (graphCompletion)", needle: "graphCompletion(" } as const;

/*
Measured 2026-07-27 against 387e83643. Lower these as U8 moves a disposition behind a graph
outcome; raising one is a new out-of-graph lifecycle decision and needs a stated reason.
*/
const LEDGER = {
  runImplementation: {
    "column transitions (store.moveTask)": 16,
    "review transitions (handoffTaskToReview)": 3,
    "terminal parks (status: \"failed\")": 9,
    "graph handbacks (graphCompletion)": 3,
  },
  /*
  handleGraphFailure moves NO card itself and hands off to NO review — every disposition it
  owns is a terminal park. That is a genuinely better starting position than the
  implementation phase, and it is measured, not assumed: the moveTask calls that look like
  they belong to this method sit past its closing brace, in the recovery helpers below it.
  */
  handleGraphFailure: {
    "column transitions (store.moveTask)": 0,
    "review transitions (handoffTaskToReview)": 0,
    "terminal parks (status: \"failed\")": 7,
  },
} as const;

describe("U8 execution-lifecycle ownership ledger", () => {
  /*
  The extraction guard. `runImplementation` is ~3.2k lines and `handleGraphFailure` ~0.9k; a
  comment-stripping or brace-matching regression would shrink them to a few lines and every
  count below would fall to zero — reporting "U8 complete" while nothing had changed.
  */
  it("extracts both junction-box method bodies at their real size", () => {
    const implLines = RUN_IMPLEMENTATION.split("\n").length;
    const failureLines = HANDLE_GRAPH_FAILURE.split("\n").length;
    expect(implLines).toBeGreaterThan(2000);
    expect(implLines).toBeLessThan(4500);
    expect(failureLines).toBeGreaterThan(500);
    expect(failureLines).toBeLessThan(1600);
  });

  it("runImplementation: executor-owned dispositions match the ledger", () => {
    const measured: Record<string, number> = {};
    for (const { label, needle } of EXECUTOR_OWNED) measured[label] = count(RUN_IMPLEMENTATION, needle);
    measured[GRAPH_HANDBACK.label] = count(RUN_IMPLEMENTATION, GRAPH_HANDBACK.needle);
    expect(measured).toEqual(LEDGER.runImplementation);
  });

  it("handleGraphFailure: executor-owned dispositions match the ledger", () => {
    const measured: Record<string, number> = {};
    for (const { label, needle } of EXECUTOR_OWNED) measured[label] = count(HANDLE_GRAPH_FAILURE, needle);
    expect(measured).toEqual(LEDGER.handleGraphFailure);
  });

  /*
  The headline number, stated once so a reader does not have to add the ledger up: the
  implementation phase decides its own lifecycle 28 times and asks the graph 3 times.
  */
  it("states the U8 baseline ratio: the implementation phase decides far more than it asks", () => {
    const owned = EXECUTOR_OWNED.reduce((sum, { label }) => sum + LEDGER.runImplementation[label], 0);
    const handbacks = LEDGER.runImplementation[GRAPH_HANDBACK.label];
    expect({ owned, handbacks }).toEqual({ owned: 28, handbacks: 3 });
  });
});
