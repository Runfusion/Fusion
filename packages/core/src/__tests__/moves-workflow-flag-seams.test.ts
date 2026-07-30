/*
FNXC:WorkflowColumns 2026-07-30-19:00 (U12 — the move-path flag, blast radius pinned):
`moves.ts` still asks the RETIRED question. `useWorkflow` reads
`isWorkflowColumnsCompatibilityFlagEnabled` — the raw compatibility flag that nothing in
production source writes — and it gates the hottest lifecycle path in the system: every task move.

WHY THIS TEST EXISTS INSTEAD OF A FLIP. The flag looks like one switch and is six. Flipping it does
not "enable workflow columns"; it simultaneously turns on validation, capacity markers, plugin
hooks, and an audit field, and swaps the implementation of every column side effect. Each seam is
enumerated below with what it turns on, and the test FAILS if the count changes — so the next person
to touch this cannot under-scope it the way it has been under-scoped in every summary so far
(including mine: I described it as the 789/837 pair).

THE RISK IS NOT THE SIDE EFFECTS, IT IS SEAM 2. With the flag off there is NO target-column
validation on the move path at all. Flipping introduces typed rejections — unknown-column, adjacency
— for moves that succeed today. That is not an equivalence question, it is new refusals on the path
every engine lane uses, and it is why "the suite is green after the flip" is not evidence.

WHAT WOULD MAKE THE FLIP SAFE, recorded so the obligation survives this session:
  1. An equivalence proof for seam 3, comparing the inline legacy side effects against the trait
     hooks for timing, reset-on-entry, abort-on-exit and merge.onEnter. The two implementations have
     NEVER both run in production, so neither is the observed baseline.
  2. A census of moves that seam 2 would newly reject — every engine caller that moves a card to a
     column its workflow does not declare. `recoveryRehome` already carves out legacy targets
     (#1411); nothing proves the other callers are covered.
  3. Both raw-flag readers flipped ATOMICALLY. `workflow-task-create-ops.ts` computes the
     `movePolicyPreflight` that `moves.ts` consumes, so un-gating either alone starts evaluating
     workflow move policies — with their plugin-gate side effects — while the consumer stays off.
     Pinned separately by `raw-workflow-columns-flag-census.test.ts`.

This test asserts (1) the seam count, (2) that every seam reads the SAME flag rather than drifting
onto separate conditions, and (3) that the flag-off branch is still present and inline — because the
agreed sequencing is to DELETE it with the branch rather than convert its guards, and a deletion
needs to know the branch is still there.
*/
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const MOVES_PATH = join(import.meta.dirname, "..", "task-store", "moves.ts");

/**
 * The six decision points, measured on `main` at 2026-07-30. `line` is documentation only — the
 * assertions below are position-independent so ordinary edits above a seam do not fail this test.
 */
const SEAMS: ReadonlyArray<{ line: number; turnsOn: string }> = [
  { line: 392, turnsOn: "resolves the task's workflow IR (undefined when off, so every IR-dependent guard below is inert)" },
  { line: 489, turnsOn: "typed REJECTIONS: unknown-column and adjacency validation. Off = no target validation at all — the riskiest seam" },
  { line: 789, turnsOn: "column side effects route through the default-workflow TRAIT HOOKS instead of the inline legacy block (timing, reset-on-entry, abort-on-exit, merge.onEnter)" },
  { line: 1092, turnsOn: "writes the transition-pending marker, which capacity counting reads — load-bearing for the in-transaction capacity gate" },
  { line: 1330, turnsOn: "runs PLUGIN hooks on column change (skipped for engine/recovery moves and same-column no-ops)" },
  { line: 1395, turnsOn: "records `workflowId` on the emitted move payload" },
];

/** Parse `moves.ts` once. Comments are absent from the tree, which is the whole point. */
function parseMoves(): ts.SourceFile {
  const source = readFileSync(MOVES_PATH, "utf-8");
  const sf = ts.createSourceFile(MOVES_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  /*
  `parseDiagnostics` is not on the PUBLIC `SourceFile` type, so it needs a cast. It is still the
  right signal rather than a try/catch: `createSourceFile` is error-tolerant and returns diagnostics
  instead of throwing, which is what makes a catch-based check unreachable.
  */
  const parseErrors = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseErrors.length > 0) {
    /*
    Fail loudly rather than counting a partial tree. `ts.createSourceFile` is error-TOLERANT — it
    returns diagnostics instead of throwing — so a syntax error would otherwise yield a smaller
    count and read as "seams were removed", which is the opposite of the truth.
    */
    throw new Error(`could not parse moves.ts: ${ts.flattenDiagnosticMessageText(parseErrors[0]!.messageText, " ")}`);
  }
  return sf;
}

/** Every `useWorkflow` reference, declaration excluded, so the number is "reads". */
function useWorkflowReferences(): number {
  const sf = parseMoves();
  let count = 0;
  const visit = (node: ts.Node): void => {
    // Identifier references only: the declaration itself is excluded so the number is "reads".
    if (ts.isIdentifier(node) && node.text === "useWorkflow") {
      const isDeclarationName = node.parent && ts.isVariableDeclaration(node.parent) && node.parent.name === node;
      if (!isDeclarationName) count++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

describe("the move-path workflow flag (U12's actual completion criterion)", () => {
  it("still gates the move path at SIX seams, not one", () => {
    /*
    If this fails LOW, seams were removed — either the flip landed (then delete this test with the
    flag) or someone narrowed the gate without accounting for what stopped happening. If it fails
    HIGH, a seventh behaviour was hung off a retired flag, which means it has never run.
    */
    expect(useWorkflowReferences()).toBe(SEAMS.length);
  });

  it("documents what each seam turns on, so the flip cannot be under-scoped", () => {
    // Cheap, but it forces the next person to state the effect when they add or remove a seam.
    expect(SEAMS).toHaveLength(6);
    for (const seam of SEAMS) {
      expect(seam.turnsOn.length).toBeGreaterThan(40);
    }
  });

  it("reads ONE flag, so the six seams cannot drift apart", () => {
    /*
    The property that makes a single flip coherent. If a seam were rewritten to consult the settings
    object directly, the flip would move five behaviours and leave one behind — and nothing else in
    the suite would notice, because both states are individually valid.
    */
    /*
    FNXC:WorkflowColumns 2026-07-30-22:00 (PR #2639 review — greptile, and it is the same defect one
    level up): these were `toContain` substring checks against raw source, so they matched text in a
    comment or a dead branch just as happily as real code. A test about structural drift that cannot
    see structure is the exact failure this PR is documenting. Asserted on the AST now.
    */
    const sf = parseMoves();
    const declarations: ts.VariableDeclaration[] = [];
    const findDeclarations = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "useWorkflow") {
        declarations.push(node);
      }
      ts.forEachChild(node, findDeclarations);
    };
    findDeclarations(sf);

    expect(declarations).toHaveLength(1);
    // And it is initialized from the raw compatibility-flag reader, not something else.
    const initializer = declarations[0]!.initializer;
    expect(initializer && ts.isCallExpression(initializer)).toBe(true);
    const callee = (initializer as ts.CallExpression).expression;
    expect(ts.isIdentifier(callee) ? callee.text : undefined).toBe("isWorkflowColumnsCompatibilityFlagEnabled");
  });

  it("still has the inline flag-OFF branch that the agreed sequencing DELETES", () => {
    /*
    The sequencing agreed with the coordinator is: U12 resolves the flag first, then the flag-off
    branch is deleted wholesale rather than having its guards converted — converting code we intend
    to delete is waste and leaves a second definition alive to drift.

    This asserts the branch is still present, so if someone converts its lifecycle guards instead,
    the deletion step has a test naming the plan. It is deliberately a source assertion: the branch's
    behaviour is what the equivalence proof in seam 3 must cover, and that proof does not exist yet.
    */
    /*
    Structural, not a comment match (PR #2639 review). The previous assertion looked for the string
    "Flag-OFF legacy inline side effects" — which is a COMMENT. Deleting the entire legacy branch
    while leaving its header comment in place would have passed, and the comment is exactly the kind
    of prose this program deliberately keeps after deleting code.

    What actually matters is that some `if (useWorkflow)` still has an ELSE: that else IS the legacy
    inline path, and its existence is what the delete-with-the-branch sequencing depends on.
    */
    const sf = parseMoves();
    let seamsWithElse = 0;
    const findIfElse = (node: ts.Node): void => {
      if (
        ts.isIfStatement(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "useWorkflow" &&
        node.elseStatement !== undefined
      ) {
        seamsWithElse++;
      }
      ts.forEachChild(node, findIfElse);
    };
    findIfElse(sf);
    expect(seamsWithElse).toBeGreaterThan(0);
  });

  it("names the second reader that must flip atomically with this one", () => {
    /*
    Recorded here because it is the constraint most likely to be forgotten: the preflight in
    `workflow-task-create-ops.ts` is computed under the same flag and CONSUMED by moves.ts. Flipping
    one without the other either evaluates workflow move policies whose result is ignored, or
    validates against a preflight that was never computed.
    */
    /*
    An IDENTIFIER reference, not a substring (PR #2639 review): this symbol is discussed by name in
    the comments around the preflight, so a text match proved nothing about whether the code still
    consumes it — and "moves.ts consumes the preflight" is the entire reason the two readers must
    flip together.
    */
    const sf = parseMoves();
    let references = 0;
    const findReferences = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "movePolicyPreflight") references++;
      ts.forEachChild(node, findReferences);
    };
    findReferences(sf);
    expect(references).toBeGreaterThan(0);
  });
});
