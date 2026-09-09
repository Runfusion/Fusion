import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-21:30 (fleet — TaskDetailModal role conversion):
Pins the two invariants that made the async role conversion in this component SAFE.

Converting a column-id literal to a trait read makes the answer ASYNCHRONOUS: the flags arrive from a
workflow fetch that resolves after first paint. Review of this conversion found five distinct ways
that goes wrong (documented in docs/solutions/ui-bugs/async-resolved-column-roles-in-components.md).
Two of them are structural — they can be pinned in source, and both were REAL defects in earlier
revisions of this same file, not hypotheticals:

  STALE IDENTITY. The metadata resolves for task A; the operator opens task B before it lands. Without
  an identity tag the component answers B's role questions with A's flags — it is resolved, it is
  non-empty, and it is about the wrong card. Fixed by tagging the state with `taskId` and gating every
  read on `detailFlagsAreForThisTask`.

  EAGER ACTION ON AN UNRESOLVED GUESS. The reconciliation effects close the PR tab when the card is
  not in a review lane. Before the flags land, `isReviewColumn` is the legacy-id fallback — false for
  a custom review column — so the effect fired on a GUESS and the tab opened and instantly bounced.
  Fixed by making those effects wait for `detailFlagsAreForThisTask`.

WHY A SOURCE ASSERTION. Both invariants are about a race between a fetch and a re-render, which a
render test cannot force deterministically without freezing the very timing under test — and
`fireEvent`-style tests famously cannot observe remount/identity bugs at all. The repo already uses
source-level guards for exactly this class (see task-detail-modal-tablet-width.test.ts). This walks
the AST rather than grepping, so a renamed variable or a reordered argument cannot slip past.

VERIFIED TO FAIL ON THE ORIGINAL DEFECT: dropping the `taskId` tag fails case 1; removing the
`detailFlagsAreForThisTask` guard from either reconciliation effect fails case 2.
*/

const SOURCE_PATH = resolve(__dirname, "../components/TaskDetailModal.tsx");
const source = readFileSync(SOURCE_PATH, "utf8");
const sourceFile = ts.createSourceFile(SOURCE_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

/** Every `useEffect(cb, [deps])` call, with the identifiers used in each half. */
function collectEffects(): Array<{ line: number; used: Set<string>; declared: Set<string> }> {
  const effects: Array<{ line: number; used: Set<string>; declared: Set<string> }> = [];

  const identifiersIn = (node: ts.Node): Set<string> => {
    const out = new Set<string>();
    const walk = (n: ts.Node) => {
      if (ts.isIdentifier(n)) out.add(n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
    return out;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "useEffect"
    ) {
      const [callback, deps] = node.arguments;
      if (callback && deps && ts.isArrayLiteralExpression(deps)) {
        effects.push({
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          used: identifiersIn(callback),
          declared: new Set(deps.elements.flatMap((element) => [...identifiersIn(element)])),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return effects;
}

describe("TaskDetailModal resolved column roles are identity-safe", () => {
  /*
  STALE IDENTITY. Asserted on the read path, not the write path: what matters is that no role read
  can reach the flags without first proving they belong to THIS task.
  */
  it("gates resolved column flags on the metadata belonging to the open task", () => {
    expect(
      source,
      "workflow move metadata must carry the task id it was resolved for",
    ).toMatch(/taskId:\s*string\s*\}\s*\)\s*\|\s*null/);

    expect(
      source,
      "the identity check must compare the metadata's taskId against the open task",
    ).toMatch(/const detailFlagsAreForThisTask\s*=\s*workflowMoveMetadata\?\.taskId === task\.id/);

    /*
    The flags used for every role question must be the GATED value. Reading
    `workflowMoveMetadata?.currentColumnFlags` directly is the bug: resolved, non-empty, wrong card.
    */
    expect(
      source,
      "resolved flags must pass through the identity gate before any role read",
    ).toMatch(
      /const detailColumnFlags\s*=\s*detailFlagsAreForThisTask\s*\?\s*workflowMoveMetadata\?\.currentColumnFlags\s*:\s*undefined/,
    );

    const roleReadsOfUngatedFlags = source.match(
      /is[A-Za-z]*ColumnRole\(\s*workflowMoveMetadata\?\.currentColumnFlags/g,
    );
    expect(roleReadsOfUngatedFlags, "no role helper may read the ungated metadata").toBeNull();
  });

  /*
  EAGER ACTION ON AN UNRESOLVED GUESS. Any effect that ACTS on a resolved role must also depend on
  the identity gate — otherwise it runs during the pre-load window on the legacy-id fallback.
  */
  it("never lets a reconciliation effect act on a role before the flags resolve", () => {
    const effects = collectEffects();
    expect(effects.length, "expected to find useEffect calls to inspect").toBeGreaterThan(0);

    const ROLE_BINDINGS = ["isReviewColumn", "isDoneColumn", "isWipColumn"];

    const unguarded = effects.filter((effect) => {
      const actsOnARole = ROLE_BINDINGS.some((role) => effect.used.has(role));
      if (!actsOnARole) return false;
      return !effect.used.has("detailFlagsAreForThisTask");
    });

    expect(
      unguarded.map((effect) => `line ${effect.line}`),
      "every effect acting on a resolved column role must wait for detailFlagsAreForThisTask",
    ).toEqual([]);
  });

  /*
  The paired completeness check: the guard above is vacuous if no effect reads a role at all. The
  done-tab reconciliation disappeared when Task Detail tabs were consolidated; the PR-tab redirect
  remains the destructive role-driven effect this invariant protects.
  */
  it("still has a reconciliation effect reading a resolved role for the guard to protect", () => {
    const effects = collectEffects();
    const guarded = effects.filter(
      (effect) =>
        effect.used.has("detailFlagsAreForThisTask")
        && effect.used.has("isReviewColumn"),
    );

    expect(guarded.length, "expected the PR-tab reconciliation effect").toBeGreaterThanOrEqual(1);
  });
});
