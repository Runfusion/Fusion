/*
FNXC:WorkflowColumns 2026-07-30-21:00 (U12 — precondition 2 for flipping the move-path flag):
WHICH ENGINE MOVES WOULD SEAM 2 NEWLY REJECT?

`moves.ts` gates target-column validation on the retired compatibility flag (see
`packages/core/src/__tests__/moves-workflow-flag-seams.test.ts` for all six seams). With the flag
off there is NO validation: any `moveTask(id, column)` is accepted. Flipping it turns on
unknown-column and adjacency rejections, so a move whose target the task's workflow does not declare
starts FAILING on the path every engine lane uses. That is new refusals, not an equivalence
question, and it is the precondition that has to be measured rather than asserted.

WHAT THIS MEASURES, and the finding. Every engine `moveTask` call whose target is a string LITERAL,
against the columns the default workflow declares:

  todo 27, in-progress 7, done 6, archived 1  (41 calls)  -> all four ARE declared by the default lineage.

Of those 41, twenty carry no `recoveryRehome` (todo 7, in-progress 7, done 6) and twenty-one do. The
numbers are the AST census's, not a grep's: a line-oriented grep reported todo=29 because it cannot
tell a call from a comment mentioning one, which is exactly the class of error this file exists to
stop repeating.

So the default board is not the exposure. `triage` appears only inside a comment recording that
`replan-target.ts` "used to hardcode moveTask(id, 'triage')" — a live call would have been the first
thing to break, and there isn't one.

THE EXPOSURE IS CUSTOM WORKFLOWS. Those same hardcoded legacy ids are not guaranteed to exist in a
custom lineage, so post-flip an engine recovery moving a custom-workflow card to `todo` rejects with
unknown-column unless it carries `recoveryRehome` — the #1411 carve-out that exempts legacy landing
columns precisely so a custom-workflow card can still be rescued. That carve-out is therefore
load-bearing for the flip, and this test pins which call sites depend on it.

A rejection here is not a crash — it is a recovery that silently stops recovering, which is the
failure class this whole program has been finding. Hence a census with names, not a count.
*/
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { getBuiltinWorkflow, parseWorkflowIr } from "@fusion/core";

const ENGINE_SRC = join(import.meta.dirname, "..");

interface MoveCall {
  file: string;
  line: number;
  target: string;
  /** Options-object keys we can see statically, e.g. `recoveryRehome`, `bypassGuards`. */
  optionKeys: string[];
}

function collectFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.includes(".test.")) out.push(full);
  }
}

/** Rightmost name of a possibly-qualified callee, so `store.moveTask` and `this.store.moveTask` both match. */
function calleeName(node: ts.Expression): string | undefined {
  let cur: ts.Node = node;
  while (ts.isPropertyAccessExpression(cur)) cur = cur.name;
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function collectMoveCalls(): MoveCall[] {
  const files: string[] = [];
  collectFiles(ENGINE_SRC, files);
  // Guards the guard: a broken path would make every assertion below vacuously true.
  if (files.length < 20) throw new Error(`census scanned only ${files.length} engine files; path resolution is broken`);

  const calls: MoveCall[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    /*
    `createSourceFile` is error-tolerant, so a syntax error yields a PARTIAL tree whose calls are
    simply absent. Reporting that as "no undeclared targets" would report not-inspected as inspected.
    */
    const parseErrors = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseErrors.length > 0) {
      throw new Error(`census could not parse ${file}: ${ts.flattenDiagnosticMessageText(parseErrors[0]!.messageText, " ")}`);
    }

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node.expression) === "moveTask") {
        const target = literalText(node.arguments[1]);
        if (target !== undefined) {
          const optionsArg = node.arguments[2];
          const optionKeys =
            optionsArg && ts.isObjectLiteralExpression(optionsArg)
              ? optionsArg.properties
                  .map((prop) => (prop.name && ts.isIdentifier(prop.name) ? prop.name.text : undefined))
                  .filter((name): name is string => name !== undefined)
              : [];
          calls.push({
            file: file.slice(ENGINE_SRC.length + 1),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            target,
            optionKeys,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return calls;
}

function defaultColumnIds(): Set<string> {
  /*
  Read through the builtin registry rather than a private default helper: this is the same lookup
  `resolveWorkflowIrById` uses for a builtin id, so the census is judged against the IR the product
  actually resolves.
  */
  const builtin = getBuiltinWorkflow("builtin:stepwise-coding");
  if (!builtin) throw new Error("census could not resolve the default builtin workflow");
  const resolved = typeof builtin.ir === "string" ? parseWorkflowIr(builtin.ir) : builtin.ir;
  return new Set(resolved.columns.map((column: { id: string }) => column.id));
}

describe("engine move targets vs the columns a workflow declares (U12 flip precondition)", () => {
  it("finds engine moveTask calls with literal targets, so the census is not vacuous", () => {
    const calls = collectMoveCalls();
    expect(calls.length).toBeGreaterThan(10);
  });

  it("every literal engine move target IS declared by the DEFAULT workflow", () => {
    /*
    The reassuring half, and the reason the flip is not immediately fatal: nothing in the engine moves
    a card to a column the default lineage lacks. If this fails, a call site was added whose target
    the default workflow does not declare, and it will reject the moment the flag flips — on the
    default board, for every user.
    */
    const declared = defaultColumnIds();
    const undeclared = collectMoveCalls().filter((call) => !declared.has(call.target));

    expect(
      undeclared.map((call) => `${call.file}:${call.line} -> "${call.target}"`),
      undeclared.length
        ? `These engine moves target a column the DEFAULT workflow does not declare, so seam 2 will\n` +
          `reject them once the move-path flag flips:\n` +
          undeclared.map((c) => `  ${c.file}:${c.line}  "${c.target}"  options: ${c.optionKeys.join(", ") || "(none)"}`).join("\n")
        : undefined,
    ).toEqual([]);
  });

  it("records which call sites depend on the #1411 recoveryRehome carve-out", () => {
    /*
    THE ACTUAL EXPOSURE. The default board is safe; a CUSTOM lineage need not declare `todo`,
    `in-progress`, `done` or `archived` at all. Post-flip, an engine move sending a custom-workflow
    card to one of those hardcoded ids rejects with unknown-column UNLESS it carries
    `recoveryRehome`, which exempts legacy landing columns so a custom-workflow card can still be
    rescued (#1411).

    So this is not "are we safe" — it is the list of moves whose safety RESTS ENTIRELY on that
    carve-out, which is the thing the flip PR has to argue about. Asserted as a non-empty inventory
    rather than a pass/fail, because the answer is a list a human must read, and a green tick would
    hide it.
    */
    const calls = collectMoveCalls();
    const rescueMoves = calls.filter((call) => call.optionKeys.includes("recoveryRehome"));
    const plainMoves = calls.filter((call) => !call.optionKeys.includes("recoveryRehome"));

    // Both groups exist; if either were empty the distinction below would be meaningless.
    expect(rescueMoves.length).toBeGreaterThan(0);
    expect(plainMoves.length).toBeGreaterThan(0);
    const all = new Map<string, number>();
    for (const call of calls) all.set(call.target, (all.get(call.target) ?? 0) + 1);
    console.info(`ALL literal engine move targets: ${[...all.entries()].sort((a,b)=>b[1]-a[1]).map(([t,n])=>`${t}=${n}`).join(", ")} (total ${calls.length})`);

    const byTarget = new Map<string, number>();
    for (const call of plainMoves) byTarget.set(call.target, (byTarget.get(call.target) ?? 0) + 1);
    console.info(
      `engine moves with a literal target, NO recoveryRehome (reject on a custom lineage post-flip):\n` +
        [...byTarget.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `  ${String(n).padStart(3)} -> "${t}"`).join("\n") +
        `\nwith recoveryRehome (exempt via #1411): ${rescueMoves.length}`,
    );
  });
});
