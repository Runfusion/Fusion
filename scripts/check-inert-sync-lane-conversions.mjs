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

SCHEDULER 20 -> 18, AND WHY THAT IS NOT A RETIREMENT (2026-07-31-20:30). #3065 replaced three
`to === parked.complete || to === parked.archived` pairs with three `parked.terminal.has(to)` calls.
Six comparison sites became three membership sites, so the COUNT fell while the guards themselves are
unchanged and all three remain counted (#3068 taught this check to see `.has`). Verified before
re-recording, because from inside this check a fall caused by denser encoding is indistinguishable
from a fall caused by a gate being deleted — and only the second is a defect. That check is the
standing obligation attached to every `--update-baseline`.

FNXC:LifecycleColumnCensus 2026-08-01-05:01:
FN-8656 re-records the scheduler drop because it removes the inert sync-lane source entirely, not
because it deletes this guard. The synchronous prologue now uses emitter lanes and every await-safe
arm resolves asynchronously, so there are no sync-derived scheduler guards left to census.

WHY A RISE AND NOT ZERO. Existing sync-resolved guards are real, deliberate, and documented — the
scheduler's listeners genuinely cannot await today, and their authors said so. Demanding zero would
force either a revert or an exemption marker on day one. What must not happen is MORE literals
quietly becoming inert-resolved, which is precisely the fleet-phase failure. A drop is welcome and
re-records with `--update-baseline`.

CROSS-MODULE SOURCES ARE FOLLOWED (2026-07-31-19:05). The first two versions collected sync-lane
sources PER FILE, so a helper defined in one module and consumed in another was invisible. That limit
stopped being theoretical: `resolvePlannerLanes` lives in `replan-target.ts` and is consumed in
`triage.ts` and `executor.ts`, and `triage.ts:723` already reads
`task.column === disposeLanes.hold || ... || task.column === "in-progress"` — a sync-resolved pair
sitting beside a literal, i.e. a site a fleet worker would reach for next, whose "conversion" would be
inert and which this check could not have seen.

So sources are now collected in a FIRST PASS over the whole tree, and consumption is counted in a
second pass against that repo-wide set.

LIMITS, STATED SO NOBODY OVER-TRUSTS IT. Sources are still matched by function NAME, not by resolved
symbol, so two unrelated functions sharing a name are conflated — the same caveat
`check-inert-flag-seams.mjs` records. It proves a guard consumes a sync-resolved answer, not that the
answer is wrong for every caller. Treat a report as a pointer to investigate. Tests are excluded.

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

/** Role fields a lifecycle resolution hands back. A guard on any of these is a lane guard.
 *
 * FNXC:LifecycleColumnCensus 2026-07-31-16:05 (second evasion, found the same way as the first):
 * `terminal` is a SET of lane ids rather than one id, and it is here because PR #3065 rewrote
 * `to === parked.complete || to === parked.archived` into `parked.terminal.has(to)`. That is a real
 * bug fix — a board may declare more than one complete-trait column — but the answer is still sourced
 * from the same sync resolver, so the guard is exactly as inert while ceasing to be a `===`
 * comparison. Counting only comparisons, this check would have watched its own subject shrink and
 * called it progress. */
const ROLE_FIELDS = new Set(["hold", "intake", "wip", "review", "complete", "archived", "plannerColumn", "mergedPlanningColumn", "terminal", "lanes", "columns"]);

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
/*
FNXC:LifecycleColumnCensus 2026-07-31-23:59 (the check evaded its own check, SECOND shape):
THE INITIALIZER IS NOT ALWAYS THE CALL.

This registered a local only when the initializer WAS a call expression. The correct
payload-first/sync-fallback shape puts the call inside a conditional:

    const sync = moveLanes ? undefined : resolvePlannerLanes(this.store, taskId);
    const hold = moveLanes?.hold ?? sync?.hold ?? "todo";

`sync` was never registered, so its guards were never counted. MEASURED: writing `executor.ts` in
exactly that shape took it from 4 counted guards to ZERO while the sync resolver was still there and
still answering with the default board whenever the payload is absent.

That is the same class of evasion the note below records for the inline spelling, and it matters more
here because the shape it misses is the RECOMMENDED one — a fallback to the sync resolver is better
than a fallback to legacy literals, so authors are actively steered toward the form the scan cannot
see. A ratchet that goes quiet exactly when the code is written well is worse than no ratchet.

Conditionals and `??`/`||` chains are now unwrapped, so any branch containing a sync source registers
the local. Still a NAME match, not dataflow — the limits section above still applies.
*/
function unwrapForSyncCall(node) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n)) return walk(n.expression);
    /*
    FNXC:LifecycleColumnCensus 2026-07-31-22:40 (SEVENTH shape — a type assertion hid the source):
    `as`, `satisfies` and `!` are erased at runtime and change nothing about the value, but they are
    real AST nodes, so the walk stopped at them:

        resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(id) as never)   MISSED
        resolveLifecycleColumns(store.resolveTaskWorkflowIrSync(id))            caught

    Measured against a probe file — `as never` and `!` both took the count 20 -> 19 while the
    uncast form counted. #3251's audit reported this as "a DIRECT sync read is untracked"; the
    direct read is tracked, the CAST around it was not, which is why the two probes disagreed.

    Same shape as the six before it (inline, membership, cross-module, wrapper argument, census
    switch/includes, ternary destination): the rewrite that hides a guard is the one that changes its
    syntactic category without changing its meaning. Erased-at-runtime nodes are the purest case —
    they cannot change behaviour, only visibility.
    */
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression?.(n) || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression?.(n)) return walk(n.expression);
    if (ts.isConditionalExpression(n)) { walk(n.whenTrue); walk(n.whenFalse); return; }
    if (ts.isBinaryExpression(n)) { walk(n.left); walk(n.right); return; }
    /*
    FNXC:LifecycleColumnCensus 2026-07-31-23:55 (ARGUMENT POSITION — the fourth shape):
    A source call handed to a WRAPPER is still a sync answer. `scheduler.ts` reads

        const parked = mergeParkedColumns(resolveTaskParkedColumnsSync(store, id), lanes);

    which prefers the event payload and falls back to the sync value whenever `lanes` is absent. The
    callee is `mergeParkedColumns`, not a source, so the walker stopped at the call boundary and the
    whole file read as clean — measured: 13 guards invisible, the entire scheduler.

    Walking arguments before pushing the call keeps every shape above and adds this one. Still a NAME
    match, not dataflow; the limits section still applies.
    */
    if (ts.isCallExpression(n)) { for (const a of n.arguments) walk(a); }
    out.push(n);
  };
  walk(node);
  return out;
}

/*
FNXC:LifecycleColumnCensus 2026-07-31-23:59 (the SECOND hop — a sync lane laundered through an
object literal):
One hop was not enough. The real shape in `executor.ts` rebuilds the lanes into a fresh object before
comparing, so the sync local never appears in a guard:

    const sync  = payload ? undefined : resolvePlannerLanes(this.store, taskId);
    const lanes = { hold: payload?.hold ?? sync?.hold ?? "todo", … };
    if (from !== lanes.hold && from !== lanes.intake) return false;

`sync` is registered, `lanes` is not, and every guard reads `lanes`. MEASURED: `executor.ts` reported
ZERO counted guards while the sync resolver was still present.

So a local built from an object literal that mentions a sync local is itself a sync local. Iterated to
a fixpoint because the laundering can chain (`a -> b -> c`); a single pass catches only the first link.

DELIBERATELY NOT full dataflow: `const` object construction only — no function returns, no
cross-module spread, no reassignment. The LIMITS section above still governs.
*/
function syncLaneLocals(sf, sources) {
  /*
  FNXC:LifecycleColumnCensus 2026-07-31-23:59 (review finding on #3169 — provenance is PER PROPERTY):
  The map is name -> tainted role set, not a flat set of names. `null` means "every role", which is
  what a DIRECT sync local is; an object rebuilt from one taints only the properties whose VALUES read
  it. Marking a whole object over-approximated: `{ hold: sync?.hold, review: "todo" }` made
  `lanes.review` count as inert though it is a literal, and `{ sync: "todo" }` matched a local's NAME
  in a key without reading it. Over-counting is not a safe direction here — it inflates the baseline
  and trains readers to skip the report, which this program's learnings record as how the next real
  finding gets missed.
  */
  const taint = new Map();
  const objectDecls = [];

  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      for (const call of unwrapForSyncCall(node.initializer)) {
        if (!ts.isCallExpression(call)) continue;
        const callee = ts.isPropertyAccessExpression(call.expression)
          ? call.expression.name.getText(sf)
          : call.expression.getText(sf);
        if (sources.has(callee)) taint.set(node.name.getText(sf), null);
      }
      if (ts.isObjectLiteralExpression(node.initializer)) {
        /* Property-level provenance: which KEY, and the text of its VALUE only. A key that merely
           shares a local's name (`{ sync: "todo" }`) must not taint anything, and a sibling literal
           (`{ hold: sync?.hold, review: "todo" }`) must not make `review` inert. */
        const props = [];
        for (const p of node.initializer.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            props.push({ key: p.name.text, valueText: p.initializer.getText(sf) });
          } else if (ts.isShorthandPropertyAssignment(p)) {
            props.push({ key: p.name.getText(sf), valueText: p.name.getText(sf) });
          }
        }
        objectDecls.push({ name: node.name.getText(sf), props });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  /* Fixpoint: an object built from a sync local is one too, and that can chain. Bounded by the
     number of object declarations, so it always terminates. */
  for (let pass = 0; pass < objectDecls.length + 1; pass += 1) {
    let grew = false;
    for (const decl of objectDecls) {
      const tainted = taint.get(decl.name) ?? new Set();
      const before = tainted.size;
      for (const prop of decl.props) {
        if (tainted.has(prop.key)) continue;
        for (const known of taint.keys()) {
          if (mentionsIdentifier(prop.valueText, known)) { tainted.add(prop.key); break; }
        }
      }
      if (tainted.size > before) { taint.set(decl.name, tainted); grew = true; }
    }
    if (!grew) break;
  }
  return taint;
}

/*
FNXC:LifecycleColumnCensus 2026-07-31-23:59 (review finding on #3169 — the match could not fire):
`\b` IS THE WRONG BOUNDARY FOR A JS IDENTIFIER, and the name was interpolated unescaped.

`new RegExp(`\\b${name}\\b`)` is wrong in BOTH directions, and `$` is where each shows up:

  MISS   name `$sync` builds `\b$sync\b`, where `$` is an ANCHOR — the pattern can never match, so a
         laundered guard is silently uncounted. That is the failure this scanner exists to prevent.
  FALSE  name `sync` builds `\bsync\b`, which DOES match inside `$sync` — `$` is a non-word character,
         so a word boundary falls between it and `s`. An unrelated local taints the object.

A CORRECTION TO AN EARLIER VERSION OF THIS NOTE, which claimed `_sync` also fails: it does not.
`_` IS a word character, so `\b_sync\b` matches `_sync` correctly. Checked rather than reasoned
about, after asserting the opposite here without checking.

So the name is escaped, and the boundary is an explicit identifier class — `$` and `_` are identifier
characters in JS and must not count as separators in either direction.
*/
function mentionsIdentifier(haystack, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`).test(haystack);
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
    /* `parked.review` — resolved once into a local.
       A DIRECT sync local taints every role (`null`); an object rebuilt from one taints only the
       properties whose values read it, so the role must be in that set or this is a sibling literal
       and not inert at all. */
    if (ts.isIdentifier(base) && locals.has(base.getText(sf))) {
      const tainted = locals.get(base.getText(sf));
      if (tainted === null || tainted.has(field)) return `${base.getText(sf)}.${field}`;
      return undefined;
    }

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
    /* `to === parked.review` — one lane id, compared. */
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        const hit = consumesLocal(node.left) ?? consumesLocal(node.right);
        if (hit) {
          hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, expr: hit });
        }
      }
    }
    /* `parked.terminal.has(to)` — a SET of lane ids, tested for membership. Same source, same
       inertness, no comparison node anywhere. See the note on ROLE_FIELDS. */
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.getText(sf);
      if (method === "has" || method === "includes") {
        const hit = consumesLocal(node.expression.expression);
        if (hit) {
          hits.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, expr: `${hit}.${method}(...)` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return hits;
}

const files = sourceFiles(join(REPO, "packages"));

/* PASS 1 — every sync-lane source in the tree, so a helper consumed across a module boundary counts. */
const sources = new Set();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (!text.includes(SYNC_IR_READER)) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const name of syncLaneSources(sf)) sources.add(name);
}

/* PASS 2 — guards consuming any of them, anywhere. */
const byFile = {};
const detail = {};
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (![...sources].some((n) => text.includes(n))) continue;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
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

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:35:
AN UNRECORDED DROP NOW FAILS, matching the sibling ratchet `check-lane-wiring.mjs`.

This warned and exited 0, which left the allowance stale-high and the ratchet SLACK. Measured, and
the example is mine: #3065 replaced three `to === parked.complete || to === parked.archived` guards
with `parked.terminal.has(to)` and took the count 20 -> 18. I did not re-record, nothing failed, and
`main` then carried a baseline of 20 against a real count of 18 — TWO FREE SLOTS in the gate whose
entire purpose is to stop this class growing. Someone could add two new inert conversions and the
build would stay green.

A ratchet that only tightens on request does not ratchet. `check-lane-wiring` already exits 1 here
and says why; this is the same rule for the same reason, so the two gates cannot drift in how
seriously they take their own ledger.

NOT EVERY RATCHET SHOULD DO THIS, and the counter-example is worth naming so nobody "fixes" it to
match. `check-fnxc-future-dates` deliberately AUTO-TIGHTENS and exits 0, because its population moves
on its own: "is this stamp in the future" is answered against TODAY, so every date boundary the runner
crosses converts future stamps into past ones and the count falls with NO code change and NO author to
fix it. Drop-fails there guarantees a red gate on some later day, and did.

The distinction is whether a drop has an AUTHOR. This count only moves when someone edits a guard, so
there is always someone holding the diff that caused it — which is exactly who should re-record. (That
file's header says "both sibling ratchets reached the same conclusion"; measured today,
`check-lane-wiring` exits 1 on a stale-high baseline, so that parenthetical is inaccurate about at
least one sibling. Its own reasoning for ITSELF is sound and stands.)
*/
if (total < (baseline.total ?? 0)) {
  console.error(`\ninert-sync-lane: total fell ${baseline.total} -> ${total}.`);
  console.error("\nGood news — but re-record the baseline in the SAME commit, or the allowance stays");
  console.error("high and the gate silently accepts that many NEW inert conversions:\n");
  console.error("  node scripts/check-inert-sync-lane-conversions.mjs --update-baseline\n");
  process.exit(1);
}
process.exit(0);
