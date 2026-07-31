#!/usr/bin/env node
/*
FNXC:LifecycleColumnCensus 2026-07-31-14:10:
BLOCK THE OTHER INERT CONVERSION — a lane guard WIRED to a synchronous resolver that always answers
with the default board.

`check-inert-flag-seams.mjs` catches an optional lane parameter that NO caller supplies. This catches
the opposite shape, which passes that check cleanly: the parameter IS supplied, from a helper that
resolves through `store.resolveTaskWorkflowIrSync`. That reader's selection lookup
(`getTaskWorkflowSelectionImpl`) returns `undefined` unconditionally in PostgreSQL mode — the shipped
backend — so the resolver falls to its `!workflowId` branch and hands back the DEFAULT builtin IR.

Note the shape exactly, because the obvious reading is wrong and it is what makes this invisible: the
helper does NOT receive `undefined` and fall through to a `?? "in-review"` arm. It receives a REAL IR
that resolves REAL traits — the default board's — so it answers with full confidence, and the `??`
fallbacks beside it are dead code. `parked.review` is `"in-review"` for every card on every board.

    tsc passes         the value is a string, correctly typed
    tests pass         on the default board the constant answer IS the right answer
    the census DROPS   it counts comparisons against string literals, and the literal really is gone

So every instrument scores it as a win while the guard behaves exactly as the literal did. That is
worse than leaving the literal, because the literal was COUNTED and this is not.

NOT HYPOTHETICAL, AND PROSE DID NOT HOLD IT. `executor.ts:10459` states this finding in full, dated
2026-07-30, calling it "the most important finding in this sweep". The next day PR #3051 converted ten
`scheduler.ts` handler arms in exactly this way; the census fell by ten and no behaviour changed on any
board (refuted live in
`packages/engine/src/__tests__/workflow-scheduler-sync-role-conversion-inert-live-e2e.pg.test.ts`).
A comment cannot fail a build. This can.

WHAT IT CHECKS. Per file: functions whose body reaches `resolveTaskWorkflowIrSync` and that hand back
column ids ("sync lane sources"), the locals assigned from them, and the `===`/`!==` guards that
consume those locals' role fields. The per-file count is baselined and a RISE fails.

WHY A RISE AND NOT ZERO. Existing sync-resolved guards are real, deliberate, and documented — the
scheduler's listeners genuinely cannot await today, and their authors said so. Demanding zero would
force either a revert or an exemption marker on day one. What must not happen is MORE literals
quietly becoming inert-resolved, which is precisely the fleet-phase failure. A drop is welcome and
re-records with `--update-baseline`.

LIMITS, STATED SO NOBODY OVER-TRUSTS IT. Sources are matched within a file by function NAME, so a
helper imported from another module is not followed — this finds the dominant local-helper shape
(`resolveTaskParkedColumnsSync`, `resolvePlannerLanes`) and will miss a cross-module one. It proves a
guard consumes a sync-resolved answer, not that the answer is wrong for every caller. Treat a report
as a pointer to investigate. Tests are excluded.

TO CLEAR A FAILURE: resolve asynchronously (thread the lane in from a caller that has already awaited
a store read), or carry the resolved lanes on the event payload so no listener resolves at all. Do NOT
add the site to the baseline to make the build pass — that is the same false green one layer up.

  node scripts/check-inert-sync-lane-conversions.mjs
  node scripts/check-inert-sync-lane-conversions.mjs --update-baseline
*/
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(REPO, "scripts", "lib", "inert-sync-lane-baseline.json");

/** The reader whose selection lookup is unconditionally `undefined` under PostgreSQL. */
const SYNC_IR_READER = "resolveTaskWorkflowIrSync";

/** Role fields a lifecycle resolution hands back. A guard on any of these is a lane guard. */
const ROLE_FIELDS = new Set(["hold", "intake", "wip", "review", "complete", "archived", "plannerColumn", "mergedPlanningColumn"]);

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every function/method name in `sf` whose body mentions the sync IR reader. */
function syncLaneSources(sf) {
  const names = new Set();
  const visit = (node) => {
    const name = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)
      ? node.name?.getText(sf)
      : (ts.isVariableDeclaration(node) && node.initializer
        && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))
        ? node.name.getText(sf)
        : undefined;
    if (name && node.body && node.body.getText(sf).includes(SYNC_IR_READER)) names.add(name);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return names;
}

/** Locals assigned from one of those sources: `const parked = resolveTaskParkedColumnsSync(...)`. */
function syncLaneLocals(sf, sources) {
  const locals = new Set();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      let call = node.initializer;
      if (ts.isAwaitExpression(call)) call = call.expression;
      if (ts.isCallExpression(call)) {
        const callee = ts.isPropertyAccessExpression(call.expression)
          ? call.expression.name.getText(sf)
          : call.expression.getText(sf);
        if (sources.has(callee)) locals.add(node.name.getText(sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return locals;
}

/** `x === parked.review` / `parked.hold !== y` — a guard consuming a sync-resolved role.
 *
 * FNXC:LifecycleColumnCensus 2026-07-31-14:35 (the check evaded its own check):
 * Both spellings count. The first draft matched only a LOCAL (`const parked = resolveX(...)` then
 * `parked.review`), which is the shape #3051 used — and a mutation run proved the INLINE spelling
 * `resolveX(store, id).review` walked straight past it while being exactly as inert. A ratchet that
 * one rewrite evades is worse than none, because the green result reads as proof. */
function countInertGuards(sf, locals, sources) {
  const hits = [];
  const consumesLocal = (expr) => {
    if (!ts.isPropertyAccessExpression(expr)) return undefined;
    const field = expr.name.getText(sf);
    if (!ROLE_FIELDS.has(field)) return undefined;

    const base = expr.expression;
    /* `parked.review` — resolved once into a local. */
    if (ts.isIdentifier(base) && locals.has(base.getText(sf))) return `${base.getText(sf)}.${field}`;

    /* `resolveTaskParkedColumnsSync(store, id).review` — resolved inline at the guard. */
    let call = base;
    if (ts.isAwaitExpression(call)) call = call.expression;
    if (ts.isCallExpression(call)) {
      const callee = ts.isPropertyAccessExpression(call.expression)
        ? call.expression.name.getText(sf)
        : call.expression.getText(sf);
      if (sources.has(callee)) return `${callee}(...).${field}`;
    }
    return undefined;
  };
  const visit = (node) => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        const hit = consumesLocal(node.left) ?? consumesLocal(node.right);
        if (hit) {
          hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, expr: hit });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

const byFile = {};
const detail = {};
for (const file of sourceFiles(join(REPO, "packages"))) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(SYNC_IR_READER)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sources = syncLaneSources(sf);
  if (sources.size === 0) continue;
  const locals = syncLaneLocals(sf, sources);
  const hits = countInertGuards(sf, locals, sources);
  if (hits.length === 0) continue;
  const rel = relative(REPO, file);
  byFile[rel] = hits.length;
  detail[rel] = hits;
}

const total = Object.values(byFile).reduce((a, b) => a + b, 0);

if (process.argv.includes("--update-baseline")) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ total, byFile }, null, 2)}\n`);
  console.log(`inert-sync-lane: baseline re-recorded — ${total} guard(s) across ${Object.keys(byFile).length} file(s)`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
  console.error(`inert-sync-lane: no baseline at ${BASELINE_PATH}`);
  console.error("  Record one:  node scripts/check-inert-sync-lane-conversions.mjs --update-baseline");
  process.exit(1);
}

const risen = [];
for (const [file, count] of Object.entries(byFile)) {
  const was = baseline.byFile?.[file] ?? 0;
  if (count > was) risen.push({ file, was, now: count });
}

console.log(`inert-sync-lane: ${total} guard(s) consuming a sync-resolved lane across ${Object.keys(byFile).length} file(s)`);
for (const [file, count] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${file}`);
}

if (risen.length > 0) {
  console.error("\ninert-sync-lane: NEW inert conversions — a lane guard now reads a sync resolver that always answers with the DEFAULT board.");
  console.error("The census will have gone DOWN for these. The behaviour did not change.\n");
  for (const r of risen) {
    console.error(`  ${r.file}: ${r.was} -> ${r.now}`);
    /* Every sync-resolved guard in the file, not only the new one: the baseline stores counts, so
       which line is new is not knowable here. Listing all of them is the honest report — the reader
       diffs against their own change. */
    console.error(`      all ${detail[r.file].length} sync-resolved guard(s) in this file:`);
    for (const hit of detail[r.file]) console.error(`        line ${hit.line}: ${hit.expr}`);
  }
  console.error("\nFix: resolve asynchronously (thread the lane in from a caller that already awaited a store read),");
  console.error("or carry the resolved lanes on the event payload so no listener resolves at all.");
  console.error("Do NOT re-record the baseline to clear this — that is the same false green one layer up.");
  process.exit(1);
}

if (total < (baseline.total ?? 0)) {
  console.log(`\ninert-sync-lane: total fell ${baseline.total} -> ${total}. Re-record with --update-baseline.`);
}
process.exit(0);
