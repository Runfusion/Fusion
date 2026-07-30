#!/usr/bin/env node
/*
FNXC:LifecycleColumnCensus 2026-07-30-23:50:
BLOCK NEW INERT CONVERSIONS — an optional trailing lane/flag parameter that no caller supplies.

The lifecycle-column program replaces `column === "done"` with a resolved-role read. A conversion
that adds the parameter and never wires a caller is WORSE than the literal:

  tsc passes        the parameter is optional, so omitting it is legal
  tests pass        the fallback IS the old behaviour — that is what the fallback is for
  the census DROPS  it counts comparisons, and the literal really is gone

So the instrument measuring the program scores the broken version as a win. Measured rate when this
check was written: five of nine conversions in one reviewed-and-green tranche were inert.

WHAT IT CHECKS. Exported functions whose LAST parameter is optional and named like resolved lanes
(`columnFlags`, `lifecycleColumns`, `reviewColumns`, ...). At least one call site must pass that many
arguments. Component props are covered separately by
`packages/dashboard/app/__tests__/resolved-flags-seams-have-suppliers.test.ts`.

LIMITS, STATED SO NOBODY OVER-TRUSTS IT. Call sites are matched by FUNCTION NAME, not by resolved
symbol, so two different functions sharing a name are conflated — `sortTasksForDisplayColumn` exists
in both `core/task-priority.ts` and `dashboard/components/taskSorting.ts` with different signatures,
and a naive reading of this scan sent me to "fix" callers of the wrong one (tsc caught it). Treat a
report as a pointer to investigate, never as a diff to apply. Tests are excluded, so a function called only from tests
reports zero callers — those are allow-listed below, not silently skipped. It proves a caller passes
SOMETHING in that position, not that the value is correct or non-undefined. Cheap half of the
question; it is the half that was silently wrong.

TO CLEAR A FAILURE: wire a supplier, or delete the parameter and leave the literal counted. Adding an
allow-list entry is the last resort and needs the reason spelled out.
*/
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(REPO, "packages");
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__mocks__", "e2e", ".gate-bundle", "coverage"]);
const TRAILING_FLAG_PARAM = /([Cc]olumnFlags|[Ll]ifecycleColumns|[Rr]eviewColumns|[Tt]erminalColumns|[Pp]lannerLanes)$/;
/** Unanchored twin used only to skip files fast; see the note at the call site. */
const PREFILTER = /(olumnFlags|ifecycleColumns|eviewColumns|erminalColumns|lannerLanes)/;

/** Known-unsupplied seams, each with why it is tolerated. Shrink this list; never grow it casually. */
const ALLOWED = new Map([
  ["evaluateMergeBlockerGuard", "Exported for tests only; scanner excludes __tests__ so it reports 0 callers."],
  ["isRecoverableMissingWorktreeReviewFailure", "Exported for tests only; same scanner limitation."],
  /*
  TEMPORARY — real offenders in packages owned by other batches, reported to them rather than edited
  from outside. Remove these two entries when those batches wire or delete the parameters; the check
  will then start guarding those files too. Both are the same shape this check exists to catch.
  */
  ["getTotalAgentActiveMs", "TEMPORARY: core-owned; reported on #2783. Twin of a dashboard function reverted for exactly this."],
  ["isPlanningContinuationTaskDispatchable", "TEMPORARY: engine-owned; reported on #2785."],
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(full) && !/\.d\.ts$/.test(full)) yield full;
  }
}

const declared = new Map();
const callSites = new Map();

/*
CALL SITES ARE COLLECTED FROM EVERY FILE, DECLARATIONS ONLY FROM CANDIDATES.

The prefilter must NOT gate call-site collection, and that was a real hole rather than a tidy-up: a
caller that OMITS the flags argument mentions no flag name, so a prefiltered scan skipped exactly the
files containing the omissions it exists to find. It saw only the callers that already pass the
argument, concluded "supplied", and stayed green. That is why this gate did not catch `isTaskStuck`'s
missing suppliers in ListView and Column — review did.

Declarations still use the prefilter: a file DECLARING a flags parameter necessarily contains the
name, so that half is safe and keeps the scan quick.
*/
for (const file of walk(PACKAGES)) {
  const source = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declares = PREFILTER.test(source);

  /*
  LOCAL SHADOWS ARE NOT CALLS TO THE SEAM. Matching call sites by NAME conflates same-named functions
  in different modules, and this repo has at least two such pairs: `sortTasksForDisplayColumn`
  (core/task-priority + dashboard/taskSorting) and `resolveEffectiveExecutor`
  (effective-model-resolution + a 2-arg private one inside ModelSelectorTab). Both produced false
  reports that cost real investigation, and one nearly produced a wrong "fix" that tsc rejected.

  It can also mask a REAL omission in the other direction: a locally-defined same-named function
  called with more arguments raises the global max and makes an under-supplied seam look supplied.

  So a file that declares its own function with that name has its calls attributed to the local one.
  */
  const locallyDeclared = new Set();
  const collectLocal = (node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) locallyDeclared.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      locallyDeclared.add(node.name.text);
    }
    ts.forEachChild(node, collectLocal);
  };
  collectLocal(sf);

  const visit = (node) => {
    if (declares && ts.isFunctionDeclaration(node) && node.name && node.parameters.length > 0) {
      /* `exported` matches this file's stated contract; a module-private helper is not a seam
         other packages can under-supply. */
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) === true;
      const last = node.parameters[node.parameters.length - 1];
      if (exported && last.questionToken && ts.isIdentifier(last.name) && TRAILING_FLAG_PARAM.test(last.name.text)) {
        declared.set(node.name.text, { file: relative(REPO, file), arity: node.parameters.length });
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isIdentifier(node.expression) ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : null;
      /*
      Record the call WITH the file it came from; whether a local shadow disqualifies it cannot be
      decided here, because the seam's declaring file is not known until every file is scanned.
      Deciding it inline used a file-level "mentions a flag name" flag, which any COMMENT sets — so a
      shadow in a file that merely discussed flags still counted, and the probe test caught that.
      */
      if (callee) {
        if (!callSites.has(callee)) callSites.set(callee, []);
        callSites.get(callee).push({ file: relative(REPO, file), args: node.arguments.length, shadowed: locallyDeclared.has(callee) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/*
A call in a file that declares its OWN function of the same name belongs to that local one, unless the
file is where the seam itself is declared. Resolved here, once the declaring file for each seam is
known.
*/
const bestArgsFor = (fn, declaringFile) => {
  const sites = callSites.get(fn) ?? [];
  const relevant = sites.filter((site) => !site.shadowed || site.file === declaringFile);
  return relevant.reduce((best, site) => Math.max(best, site.args), 0);
};

const offenders = [];
const stale = [];
for (const [fn, { file, arity }] of declared) {
  const best = bestArgsFor(fn, file);
  const unsupplied = best < arity;
  if (ALLOWED.has(fn)) {
    /*
    An allow-list entry whose site is now SUPPLIED is stale, and a stale exemption is how a guard
    quietly stops guarding a file nobody is looking at any more. Fail so the entry is removed in the
    same change that fixed the site — the same staleness rule the sync-resolver allow-list uses.
    */
    if (!unsupplied) stale.push(`  ${fn} — now supplied; remove its ALLOWED entry`);
    continue;
  }
  if (unsupplied) offenders.push(`  ${file}: ${fn}() — best call passes ${best} of ${arity}`);
}

/*
TEMPORARY entries are exemptions for OTHER teams' code, granted so their CI does not break mid-batch.
They are the ones that rot: nobody who could remove them is looking at this file. Announce them on
every run so they stay visible rather than becoming permanent by silence.
*/
const temporary = [...ALLOWED].filter(([, reason]) => reason.startsWith("TEMPORARY"));
if (temporary.length > 0) {
  console.log(`[check-inert-flag-seams] ${temporary.length} TEMPORARY exemption(s) still active:`);
  for (const [fn, reason] of temporary) console.log(`    ${fn} — ${reason}`);
}

if (declared.size === 0) {
  console.error("[check-inert-flag-seams] found NO trailing lane/flag params — the scan is broken, not the code.");
  process.exit(1);
}

if (stale.length > 0) {
  console.error("\n[check-inert-flag-seams] STALE allow-list entries — the sites are supplied now:\n");
  for (const line of stale.sort()) console.error(line);
  console.error("\nRemove them, or the check silently stops guarding those functions.\n");
  process.exit(1);
}

if (offenders.length > 0) {
  console.error("\n[check-inert-flag-seams] optional trailing lane/flag parameter with no supplier:\n");
  for (const line of offenders.sort()) console.error(line);
  console.error(
    "\nThe literal it replaced is gone, the census counted the conversion, and the behaviour is the\n"
    + "legacy fallback forever. Wire a supplier, or delete the parameter and leave the literal counted.\n",
  );
  process.exit(1);
}

console.log(`[check-inert-flag-seams] ${declared.size} lane/flag seams, all supplied.`);
