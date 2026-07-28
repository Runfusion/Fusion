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

SELF-CHECK DISCIPLINE. A source-scanning guard that silently matches nothing passes forever, so
two things hold it honest. The extraction is AST-based (`ts.createSourceFile`), not brace
matching over text: a `}` inside a string, a template literal, a regex, or a comment is a token
to the parser, never structure, so ordinary edits to literal content cannot truncate a body or
shift a count. And the extracted bodies are still range-checked below, because "the parser found
something" is not the same as "the parser found the 3.2k-line method we meant".

WHY AST AND NOT GREP (greptile P2, PR #2490). The first cut brace-matched over comment-stripped
text. Its failure mode was demonstrable rather than theoretical — a single `const brace = "}"`
inside `runImplementation` truncated the body to 13 lines — and while the size guard caught that
loudly, the cost landed on whichever unrelated PR happened to add such a literal. A ratchet that
misfires on innocent edits gets deleted, and then it protects nothing.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const EXECUTOR_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "executor.ts");

const SOURCE_FILE = ts.createSourceFile(
  EXECUTOR_PATH,
  readFileSync(EXECUTOR_PATH, "utf8"),
  ts.ScriptTarget.ESNext,
  /* setParentNodes */ true,
);

/**
 * Find a class method's body by NAME through the AST. Throws rather than returning empty — a
 * silent miss would make every count zero and report "U8 complete" while nothing had changed.
 */
function methodBody(name: string): ts.Block {
  let found: ts.Block | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.body) {
      if (found) throw new Error(`ambiguous method name (declared more than once): ${name}`);
      found = node.body;
    }
    ts.forEachChild(node, visit);
  };
  visit(SOURCE_FILE);
  if (!found) throw new Error(`method not found: ${name}`);
  return found;
}

/**
 * Count call expressions of `this.<property>.…(…)` shapes inside a method body.
 * `member` is the dotted path after `this.` — e.g. `store.moveTask` or `handoffTaskToReview`.
 * Matching on the callee EXPRESSION (not text) is what makes a call inside a string impossible
 * to miscount, and a renamed-but-equivalent call impossible to miss.
 */
function countCalls(body: ts.Block, member: string): number {
  const path = member.split(".");
  let total = 0;
  const matchesPath = (expr: ts.Expression): boolean => {
    let current: ts.Expression = expr;
    for (let i = path.length - 1; i >= 0; i--) {
      if (!ts.isPropertyAccessExpression(current) || current.name.text !== path[i]) return false;
      current = current.expression;
    }
    return current.kind === ts.SyntaxKind.ThisKeyword;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && matchesPath(node.expression)) total++;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return total;
}

/** Count calls to a plain identifier (a local callback such as `graphCompletion`). */
function countIdentifierCalls(body: ts.Block, name: string): number {
  let total = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) total++;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return total;
}

/**
 * Count object-literal properties that write a terminal park, i.e. `status: "failed"`.
 * A property assignment is a node, so `status: "failed"` appearing inside a log string or an
 * FNXC note is structurally not a write and is never counted.
 */
function countTerminalParks(body: ts.Block): number {
  let total = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "status"
      && ts.isStringLiteral(node.initializer)
      && node.initializer.text === "failed"
    ) total++;
    ts.forEachChild(node, visit);
  };
  visit(body);
  return total;
}

const RUN_IMPLEMENTATION = methodBody("runImplementation");
const HANDLE_GRAPH_FAILURE = methodBody("handleGraphFailure");

/** The three ways the executor performs a lifecycle disposition itself. */
const EXECUTOR_OWNED_LABELS = [
  "column transitions (store.moveTask)",
  "review transitions (handoffTaskToReview)",
  "terminal parks (status: \"failed\")",
] as const;

/** The one way the implementation phase hands the decision back to the graph. */
const GRAPH_HANDBACK_LABEL = "graph handbacks (graphCompletion)";

function bodyLineCount(body: ts.Block): number {
  const { line: start } = SOURCE_FILE.getLineAndCharacterOfPosition(body.getStart(SOURCE_FILE));
  const { line: end } = SOURCE_FILE.getLineAndCharacterOfPosition(body.getEnd());
  return end - start + 1;
}

function measure(body: ts.Block, includeHandbacks: boolean): Record<string, number> {
  const measured: Record<string, number> = {
    "column transitions (store.moveTask)": countCalls(body, "store.moveTask"),
    "review transitions (handoffTaskToReview)": countCalls(body, "handoffTaskToReview"),
    "terminal parks (status: \"failed\")": countTerminalParks(body),
  };
  if (includeHandbacks) measured[GRAPH_HANDBACK_LABEL] = countIdentifierCalls(body, "graphCompletion");
  return measured;
}

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
  The extraction guard. Parsing cannot silently truncate a body the way brace matching could,
  but it CAN silently find the wrong thing — a renamed method, a moved declaration, a parser
  that gave up. `runImplementation` is ~3.2k lines and `handleGraphFailure` ~0.9k; anything far
  outside that is not the method this ledger is about, and every count below would be measuring
  something else while still reporting a comfortable pass.
  */
  it("extracts both junction-box method bodies at their real size", () => {
    expect(bodyLineCount(RUN_IMPLEMENTATION)).toBeGreaterThan(2000);
    expect(bodyLineCount(RUN_IMPLEMENTATION)).toBeLessThan(4500);
    expect(bodyLineCount(HANDLE_GRAPH_FAILURE)).toBeGreaterThan(500);
    expect(bodyLineCount(HANDLE_GRAPH_FAILURE)).toBeLessThan(1600);
  });

  it("runImplementation: executor-owned dispositions match the ledger", () => {
    expect(measure(RUN_IMPLEMENTATION, true)).toEqual(LEDGER.runImplementation);
  });

  it("handleGraphFailure: executor-owned dispositions match the ledger", () => {
    expect(measure(HANDLE_GRAPH_FAILURE, false)).toEqual(LEDGER.handleGraphFailure);
  });

  /*
  The headline number, stated once so a reader does not have to add the ledger up: the
  implementation phase decides its own lifecycle 28 times and asks the graph 3 times.
  */
  it("states the U8 baseline ratio: the implementation phase decides far more than it asks", () => {
    const owned = EXECUTOR_OWNED_LABELS.reduce<number>((sum, label) => sum + LEDGER.runImplementation[label], 0);
    const handbacks = LEDGER.runImplementation[GRAPH_HANDBACK_LABEL];
    expect({ owned, handbacks }).toEqual({ owned: 28, handbacks: 3 });
  });
});
