import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-09:00 (fleet — the same mistake, three times, one file):

THE RECURRING DEFECT. A signal helper in this subsystem gains a resolved-role parameter, and exactly
ONE of the two age-staleness hydration sites in `reads.ts` is updated. The guard is then correct, the
converted site works, and the other site keeps comparing against a legacy literal — so on a renamed
board the badge is silent for every card arriving through that path, with nothing failing anywhere.

  1. `holdColumn`   — PR #2470's review caught BOTH sites omitting it.
  2. `reviewColumn` — fixed for hold, missed for its sibling role; the file's own note reads
                      "same defect, same file, one role over".
  3. `lifecycle`    — #2746 threaded the list pass and left the MODIFIED-SINCE pass on the defaults.
                      That is the path a live board actually uses after first load, so the incremental
                      refresh silently stopped producing age-staleness badges.

Three occurrences is not a coincidence, it is a structural property: the two call sites are ~200 lines
apart, look identical, and nothing connects them. A comment asking the next person to remember has
already been tried twice.

So this asserts the INVARIANT rather than the instance: every `getTaskAgeStalenessSignal` call in
`reads.ts` must pass the resolved lifecycle. It is an AST walk, not a grep, so a reordered or renamed
argument cannot slip past — and it fails on the omission regardless of which role is added next.
*/

const READS_PATH = resolve(__dirname, "../task-store/reads.ts");
const source = readFileSync(READS_PATH, "utf8");
const sourceFile = ts.createSourceFile(READS_PATH, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

interface CallSite {
  line: number;
  propertyNames: string[];
}

function collectAgeStalenessCalls(): CallSite[] {
  const calls: CallSite[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "getTaskAgeStalenessSignal"
    ) {
      const context = node.arguments[1];
      const propertyNames: string[] = [];
      if (context && ts.isObjectLiteralExpression(context)) {
        for (const property of context.properties) {
          const name = property.name;
          if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
            propertyNames.push(name.text);
          }
        }
      }
      calls.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        propertyNames,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

describe("reads.ts hydrates age-staleness with resolved lanes at EVERY call site", () => {
  /*
  Completeness first: the invariant below is vacuous if the calls moved or were renamed. Two is the
  count this file has had throughout all three incidents (the list pass and the modified-since pass).
  */
  it("still has the two hydration call sites this guard exists to keep in step", () => {
    const calls = collectAgeStalenessCalls();

    expect(
      calls.length,
      "expected the list-pass and modified-since-pass hydration sites",
    ).toBeGreaterThanOrEqual(2);
  });

  /*
  The invariant. Stated over ALL call sites rather than naming the one that was missed, because the
  failure mode is "a NEW site, or a newly added role, gets forgotten" — and a test that only pins the
  known instance would go green the moment the next one appears.
  */
  it("passes the resolved lifecycle at every call site, not just the list pass", () => {
    const calls = collectAgeStalenessCalls();

    const missingLifecycle = calls
      .filter((call) => !call.propertyNames.includes("lifecycle"))
      .map((call) => `line ${call.line}`);

    expect(
      missingLifecycle,
      "every getTaskAgeStalenessSignal call must pass the task's resolved lifecycle columns — "
        + "an omitted site silently stops producing age-staleness badges on a renamed board",
    ).toEqual([]);
  });
});
