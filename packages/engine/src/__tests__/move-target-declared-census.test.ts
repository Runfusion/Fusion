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

/*
FNXC:WorkflowLifecycleColumns 2026-07-31-23:20 (the population this file measured reached ZERO):
`collectMoveCalls` now takes an optional (name, source) list so the collector can be exercised against
a SYNTHETIC fixture. Reason in the describe block below: the engine's literal move-target population
is 0, so every assertion that proved this census works by pointing at real debt has nothing left to
point at. A vacuity guard that depends on real debt existing expires the moment the work succeeds —
and it expires by FAILING, which reads as a regression in the thing it was guarding.
*/
type SourceFileInput = { name: string; source: string };

function collectMoveCalls(inputs?: readonly SourceFileInput[]): MoveCall[] {
  let entries: SourceFileInput[];
  if (inputs) {
    entries = [...inputs];
  } else {
    const files: string[] = [];
    collectFiles(ENGINE_SRC, files);
    // Guards the guard: a broken path would make every assertion below vacuously true.
    if (files.length < 20) throw new Error(`census scanned only ${files.length} engine files; path resolution is broken`);
    entries = files.map((f) => ({ name: f, source: readFileSync(f, "utf-8") }));
  }

  const calls: MoveCall[] = [];
  for (const { name: file, source } of entries) {
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
            file: file.startsWith(ENGINE_SRC) ? file.slice(ENGINE_SRC.length + 1) : file,
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
  /*
  FNXC:WorkflowLifecycleColumns 2026-07-31-23:20 (the precondition this file measured is now MET):
  Every assertion here used to rest on the engine HAVING literal move targets — ">10 exist", "the
  rescue and plain groups are both non-empty". The conversion program drove that population to 0, so
  those three assertions began failing on main. Nothing regressed: the census is reporting the
  success condition for the U12 flip, and the test was written to describe the world before it.

  A guard whose premise is "the debt still exists" expires the moment the work succeeds, and expires
  by FAILING — which reads as a regression in the very thing it was guarding. Re-pointed rather than
  deleted, in two halves:

    - VACUITY is now proven against a SYNTHETIC fixture, so the collector is exercised forever
      regardless of how much real debt remains. This is the assertion that keeps the two below
      honest: at a real population of 0 they are trivially true, and only the fixture proves they
      would still fire.
    - The two real-tree assertions now assert ZERO, so a reintroduced literal move target fails them.
      That is the same guarantee as before, pointed at the state the tree is actually in.

  `check-move-target-literals` ratchets the same population at 0 from the script side. This file is
  not redundant with it: it judges targets against the columns the DEFAULT workflow declares, which
  is the U12 flip question, and the ratchet does not.
  */
  const FIXTURE: readonly { name: string; source: string }[] = [{
    name: "synthetic-fixture.ts",
    source: [
      `declare const store: { moveTask: (id: string, to: string, opts?: object) => void };`,
      `export function a(id: string): void { store.moveTask(id, "in-review"); }`,
      `export function b(id: string): void { store.moveTask(id, "done", { recoveryRehome: true }); }`,
      `export function c(id: string): void { store.moveTask(id, "not-a-declared-column"); }`,
    ].join("\n"),
  }];

  it("VACUITY — the collector finds literal targets, options and all, in a synthetic fixture", () => {
    /* Proves the census can still see what it claims to measure, without needing real debt to exist.
       If the collector breaks, the two zero-assertions below would pass for the wrong reason and this
       is the only case that notices. */
    const calls = collectMoveCalls(FIXTURE);

    expect(calls.map((c) => c.target).sort()).toEqual(["done", "in-review", "not-a-declared-column"]);
    expect(calls.find((c) => c.target === "done")?.optionKeys).toEqual(["recoveryRehome"]);
    expect(calls.find((c) => c.target === "in-review")?.optionKeys).toEqual([]);

    /* ...and that the declared-column comparison still discriminates, which is the actual U12
       question. `not-a-declared-column` is not in any lineage; the other two are default ids. */
    const declared = defaultColumnIds();
    expect(calls.filter((c) => !declared.has(c.target)).map((c) => c.target)).toEqual(["not-a-declared-column"]);
  });

  it("the engine has NO literal move targets left — the U12 flip precondition is met", () => {
    /* Was ">10 exist". The population is 0; asserting the number keeps a reintroduction failing. */
    const calls = collectMoveCalls();
    expect(calls.map((call) => `${call.file}:${call.line} -> "${call.target}"`)).toEqual([]);
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

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-31-23:20 (the exposure is now NIL):
    Was `rescueMoves > 0 && plainMoves > 0` — "both groups exist, so the distinction is meaningful".
    Both are now empty because no literal move targets remain, which means NO engine move's safety
    rests on the #1411 `recoveryRehome` carve-out. That is the answer the flip PR wanted, and it is
    worth asserting exactly: if a literal move target returns, `plainMoves` becomes non-empty and the
    inventory below stops being empty, so this fails and a human reads the list again.

    The synthetic-fixture case above is what proves this grouping still works at a real population of
    0 — without it, a collector that returned nothing would satisfy these two lines forever.
    */
    expect(rescueMoves).toEqual([]);
    expect(plainMoves).toEqual([]);

    const fixtureGrouping = collectMoveCalls(FIXTURE);
    expect(fixtureGrouping.filter((c) => c.optionKeys.includes("recoveryRehome")).length).toBe(1);
    expect(fixtureGrouping.filter((c) => !c.optionKeys.includes("recoveryRehome")).length).toBe(2);

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
