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
/*
FNXC:InertFlagSeams 2026-07-30-23:30:
`plugins/` IS SCANNED, because plugins hold real lane logic and this gate could not see any of it.

The walk was rooted at `packages/` alone. Measured with a control: the identical unwired seam is
caught under `packages/` and MISSED under `plugins/` — so every lane parameter a plugin declares or
calls was outside the ratchet entirely.

Not hypothetical. `plugins/fusion-plugin-even-realities-glasses` resolves workflow IRs and filters by
column in `src/cards.ts` and `src/routes/board-routes.ts`. The sibling `check-lane-wiring` already
lists `plugins` in its roots, and its header records the incident that put it there: an unwired
`completeColumnsByTaskId` sat on `main` unreported because that plugin was not scanned. This gate
re-opened the same hole rather than learning from it.

Found while auditing my own gates after #3000 showed this one never scanned `scripts/` either. Two
scope holes in one instrument is a pattern: the roots deserve the same scrutiny as the matcher, and
they had none.
*/
const SCAN_ROOTS = [join(REPO, "packages"), join(REPO, "plugins")];
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__mocks__", "e2e", ".gate-bundle", "coverage"]);
const TRAILING_FLAG_PARAM = /([Cc]olumnFlags|[Ll]ifecycleColumns|[Rr]eviewColumns|[Tt]erminalColumns|[Pp]lannerLanes)$/;

/*
FNXC:LifecycleColumnCensus 2026-07-30-23:40:
PASSING `undefined` FOR THE LANE ANSWER IS NOT SUPPLYING IT.

The seam is a trailing optional parameter, so this gate asked how many ARGUMENTS each call site
passes. A call that spells the omission out —

    resolveSomething("KB-1", undefined)

— satisfies that count while the callee receives exactly what it received before: nothing. The
parameter is still inert and the board still reads the legacy vocabulary.

That spelling is not exotic. It is what a partial wiring-up produces when the flags are threaded
through an intermediate that has none to pass, and what a mechanical edit produces when it fills
argument slots positionally. Either way the gate reported the seam as answered.

Missed by BOTH gates: check-lane-wiring (#2966) covers the default-valued and options-object shapes
this one is structurally blind to, but it counts arguments the same way here. Found by probing my own
gate with shapes I had not designed it for — the discipline argued for in #2979.

TRAILING ONLY. A middle `undefined` still positions the arguments after it, so those are real answers.
*/
const isUndefinedArgument = (arg) =>
  (ts.isIdentifier(arg) && arg.text === "undefined") || ts.isVoidExpression(arg);

/** Arguments that actually carry a value, ignoring trailing `undefined` / `void 0` placeholders. */
export function effectiveArgCount(args) {
  let count = args.length;
  while (count > 0 && isUndefinedArgument(args[count - 1])) count -= 1;
  return count;
}

/** Unanchored twin used only to skip files fast; see the note at the call site. */
const PREFILTER = /(olumnFlags|ifecycleColumns|eviewColumns|erminalColumns|lannerLanes)/;

/** Known-unsupplied seams, each with why it is tolerated. Shrink this list; never grow it casually. */
const ALLOWED = new Map([
  /*
  TEMPORARY — real offenders in packages owned by other batches, reported to them rather than edited
  from outside. Remove each entry when that batch wires or deletes the parameter; the check will then
  start guarding those files too. All three are the same shape this check exists to catch.
  */
  [
    "isRecoverableMissingWorktreeReviewFailure",
    "No production caller; 5 test call sites. The previous entry blamed the scanner for excluding "
      + "__tests__ — that reason was wrong, the scan now reads tests and the count is real. The two "
      + "SIBLINGS it delegates to (`...WithProgress` / `...NoProgress`) are the live pair, called from "
      + "self-healing.ts and both supplying `reviewColumns`. This is the convenience wrapper over them, "
      + "kept as a public predicate and exercised only by its own tests. Engine-owned; left alone.",
  ],

  [
    "sortTasksForDisplayColumn",
    "PERMANENT, with evidence. core/task-priority.ts's copy has ZERO callers anywhere: the three "
      + "dashboard call sites bind to a DIFFERENT function of the same name in "
      + "app/components/taskSorting.ts, and only its own tests pass the flags. It is not reachable "
      + "externally either — @fusion/core is private, @runfusion/fusion declares no `exports` map and "
      + "re-exports nothing from core wholesale, and it is absent from plugin-sdk. So there is no "
      + "production behaviour to be wrong, and nothing to wire a supplier from.\n"
      + "Deliberately NOT 'fixed'. Deleting the parameter (this check's usual remedy) would trade a "
      + "dormant-but-correct implementation for a dormant legacy-only one, and deleting the function "
      + "would discard a well-documented ordering it is plausible someone wires later. Both are churn "
      + "with no product effect. The honest resolution is a duplicate-vs-core consolidation with the "
      + "dashboard twin, which is a refactor and needs an owner — not a seam fix.\n"
      + "Was TEMPORARY pending #2783; that PR merged without it, so the pending-owner framing was a "
      + "fiction and is removed rather than left to rot.",
  ],

]);

/*
PARTIAL-SUPPLY exemptions are keyed by CALL SITE, not by function name.

A name-level entry would waive every call site of the seam at once, which is the opposite of what a
partially-supplied seam needs: the whole point is that its OTHER sites are correct and must stay
guarded. `<file>::<function>` keeps the exemption to the one site whose omission is deliberate.

An omission earns an entry only when supplying the argument would be WRONG, not when it is awkward.
"Awkward" means wire it; the check exists to make that the cheaper path.
*/
const ALLOWED_OMISSIONS = new Map([
]);

/*
TEST CALL SITES ARE COLLECTED, AND COUNTED SEPARATELY FROM PRODUCTION ONES.

Excluding `__tests__` outright made a test-only export read as having NO callers, which is why two
permanent allow-list entries existed. But naively including tests is worse than excluding them: a
test that supplies the argument would clear a seam no production caller supplies — and that is not
hypothetical, it is exactly core's `sortTasksForDisplayColumn`, whose only suppliers ARE its tests.

So the two are tracked apart. "Supplied" means supplied by PRODUCTION. Test callers answer a
different and also useful question: is this function reachable at all, or is the export dead?
*/
const TEST_DIRS = new Set(["__tests__", "__mocks__", "e2e"]);
const isTestFile = (file) => file.split("/").some((segment) => TEST_DIRS.has(segment))
  || /\.(test|spec)\.tsx?$/.test(file);

function* walkAll(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".gate-bundle" || entry === "coverage") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkAll(full);
    else if (/\.tsx?$/.test(full) && !/\.d\.ts$/.test(full)) yield full;
  }
}

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
for (const file of SCAN_ROOTS.flatMap((root) => [...walkAll(root)])) {
  const source = readFileSync(file, "utf8");
  const fileIsTest = isTestFile(relative(REPO, file).split("\\").join("/"));
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

  IMPORTED shadows are handled separately, below — that limitation is now closed.

  Two ways of matching by NAME remain: the one-supplier floor (any single caller passing the argument
  clears the seam, even if ten others omit it) and the test-exclusion (a function exported only for
  tests reads as having no callers, hence the two permanent ALLOWED entries).
  */
  /*
  IMPORTED SHADOWS, RESOLVED. `Lane.tsx` imports `sortTasksForDisplayColumn` from `./taskSorting`,
  not from core, so a name-only match attributed its calls to core's seam. That produced false
  reports twice — once costing a "fix" tsc rejected, once sending two other batches a list they had
  to audit. Recording the module each callee was imported FROM lets a call be matched to the seam's
  actual declaring file.

  It did not merely silence a false positive. Core's `sortTasksForDisplayColumn` really is unsupplied
  — its third `columnFlags` argument is passed by its own tests and nowhere else — and the dashboard
  function of the same name, called with more arguments from three components, was raising the max
  and reporting the seam as satisfied. So the name collision was hiding a genuine offender behind a
  row everyone had learned to read as noise, which is the worse half of this failure mode: a guard
  that cries wolf trains its readers to skip exactly the line that matters.
  */
  const { importedFrom, localAlias } = collectImportBindings(sf);

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
      if (!fileIsTest && exported && last.questionToken && ts.isIdentifier(last.name) && TRAILING_FLAG_PARAM.test(last.name.text)) {
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
        /* Attribute the call to the EXPORTED name when it came in under an alias. */
        const target = localAlias.get(callee) ?? callee;
        if (!callSites.has(target)) callSites.set(target, []);
        callSites.get(target).push({
          file: relative(REPO, file),
          args: effectiveArgCount(node.arguments),
          shadowed: locallyDeclared.has(callee),
          from: importedFrom.get(callee),
          viaProperty: ts.isPropertyAccessExpression(node.expression),
          isTest: fileIsTest,
        });
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
const callSitesFor = (fn, declaringFile) =>
  (callSites.get(fn) ?? []).filter((site) => isRelevantCallSite(site, declaringFile));

/*
FNXC:LifecycleColumnCensus 2026-07-30-23:20 (#2851 review — greptile, "call classification lacks
regression coverage"):

EXTRACTED SO THE CLASSIFICATION CAN BE TESTED WITHOUT WALKING THE REPO.

The alias remapping and the property-access exclusion were both added to fix REAL failures: one had
the gate reporting `enqueueMergeQueue() — best call passes 2 of 5` while its only production caller
supplied all five through an alias; the other had it red on main over two call sites that are
correct. Neither had a test, so the next edit could restore either false positive silently — and both
are the kind of rule whose breakage reads as the gate merely having an opinion, which is how a guard
trains its readers to skip it.

Pure by construction: it takes one recorded site plus the declaring file and returns a boolean. The
walk still produces the sites; this decides what they mean, which is the half with the rules in it.
*/
/*
FNXC:LifecycleColumnCensus 2026-07-30-23:55 (#2851 review — the OTHER half the finding named):

EXPORTED SO THE ALIAS DIRECTION IS TESTABLE, because the direction is the whole risk.

In the TypeScript AST an `ImportSpecifier` for `import { a as b }` holds the EXPORTED name in
`propertyName` and the LOCAL name in `name`. Reading them the other way round still produces a
populated map and still type-checks — it just maps the wrong way, and the gate then attributes calls
to a name nothing declares. That is not hypothetical: removing a stale exemption surfaced
`enqueueMergeQueue() — best call passes 2 of 5` while its ONLY production caller passed all five
through an alias.

Returns both maps because they are populated from the same walk over the same specifiers; splitting
them would mean two walks that could disagree about which imports exist.

Returns: `importedFrom` maps local name -> module specifier; `localAlias` maps local name -> the name
the module exported it under.
*/
export function collectImportBindings(sf) {
  const importedFrom = new Map();
  const localAlias = new Map();
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
      && ts.isNamedImports(node.importClause.namedBindings)
      && ts.isStringLiteral(node.moduleSpecifier)) {
      for (const element of node.importClause.namedBindings.elements) {
        importedFrom.set(element.name.text, node.moduleSpecifier.text);
        if (element.propertyName) localAlias.set(element.name.text, element.propertyName.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { importedFrom, localAlias };
}

export function isRelevantCallSite(site, declaringFile) {
  /* Basename of the seam's module, e.g. `near-duplicate-canonical` — enough to tell core's
     `task-priority` from the dashboard's `taskSorting` without resolving the module graph. */
  const declaringModule = declaringFile.replace(/\.tsx?$/, "").split("/").pop();
  {
    /*
    A METHOD CALL IS NOT THIS FUNCTION. Seams are module-level `function` declarations, but matching
    by name also swept up `obj.sameName(...)`. `store.enqueueMergeQueue(taskId, opts)` is a 2-arg
    TaskStore METHOD that internally resolves the review columns; the module function it shadows
    takes 5. Counting the method's calls reported the module seam as under-supplied and turned the
    gate red on main over two call sites that are correct.

    Tradeoff, stated: a genuine `namespace.fn(...)` call would now be skipped. This codebase calls
    module functions as bare identifiers (aliased ones are resolved above), so that trade buys a
    real false-positive fix at the cost of a shape that does not currently occur.
    */
    if (site.viaProperty) return false;
    if (site.file === declaringFile) return true;                       // the seam's own file
    if (site.shadowed) return false;                                    // a local same-named function
    if (site.from === undefined) return true;                           // not imported: ambiguous, count it
    /*
    BARREL AND PACKAGE IMPORTS CANNOT BE RESOLVED BY BASENAME, SO THEY COUNT.

    Correction to a regression I shipped while closing the imported-shadow hole. Engine and CLI reach
    core through `import { ... } from "@fusion/core"`, whose basename is "core" and never matches a
    module name like "near-duplicate-canonical". Comparing basenames therefore classified EVERY
    barrel-imported call site as "a different function of the same name" and dropped it — so the
    check stopped seeing engine's and cli's calls into core at all, which is most of the
    cross-package surface it exists to watch.

    Measured: `isNearDuplicateCanonicalInactive` reported "supplied by 5/6 call sites" while FOUR
    engine sites (self-healing.ts x2, triage.ts x2) omitted the argument and were invisible. The
    check read cleaner and caught less — the exact failure mode this gate exists to document.

    Only a RELATIVE specifier identifies a module well enough to exclude on. Anything else is
    unresolved, and unresolved must mean COUNTED: an over-counted seam produces a false report
    somebody investigates, an under-counted one produces silence.
    */
    if (!site.from.startsWith(".")) return true;
    return site.from.replace(/\.js$/, "").split("/").pop() === declaringModule;
  }
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-23:35 (#2851 review):
GUARDED REPORTING, so importing this module does not run the gate to completion.

`check-inert-flag-seams.test.mjs` imports `isRelevantCallSite`. Without this guard the import printed
the gate's report and could `process.exit(1)`, so the test file would pass or fail on unrelated repo
state rather than on what it asserts. Same fix, same reason, as check-sql-column-literals.

The AST WALK above stays unguarded on purpose: `declared` and `callSites` are the module's data, a
future test may want them, and the walk has no output and no exit. Only the reporting is entry-point
work.
*/
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const offenders = [];
  const partial = [];
  const stale = [];
  for (const [fn, { file, arity }] of declared) {
    const allSites = callSitesFor(fn, file);
    /*
    PRODUCTION suppliers are the only ones that make a seam live. A test passing the argument proves
    the parameter is exercised, not that anything in the shipped product ever reaches that branch.
    */
    const sites = allSites.filter((site) => !site.isTest);
    const testSites = allSites.filter((site) => site.isTest);
    const best = sites.reduce((max, site) => Math.max(max, site.args), 0);
    const unsupplied = best < arity;
    /*
    A seam with NO production caller is inert whether or not tests exercise it, so it is reported the
    same way. I briefly split those cases by "is it re-exported from the package index", reasoning that
    a public export could be called from outside — that was unsound, and it silently DOWNGRADED a real
    offender (`sortTasksForDisplayColumn`, suppliers are its own tests) from failing to a footnote.
    Neither function has production behaviour to be wrong; publication status does not change that.

    Test call sites are still tracked, and that half matters: they must never CLEAR a seam. Counting
    them as suppliers is what would have re-hidden `sortTasksForDisplayColumn` entirely.
    */
    const testNote = sites.length === 0 && testSites.length > 0 ? ` (${testSites.length} test call site(s))` : "";
    /*
    THE ONE-SUPPLIER FLOOR. `best < arity` asks only whether SOME caller supplies the argument, so one
    correct call site clears the seam while every other caller silently takes the legacy fallback. That
    is not hypothetical: `isTaskStuck` shipped with two of its three call sites omitting the flags, and
    review caught it, not this gate — the gate was green because the third call site was right.

    A partially-supplied seam is the harder defect of the two. A wholly-unsupplied one is at least
    uniformly wrong; this one works on the board you tested and degrades on the column you did not.
    */
    /*
    FNXC:InertFlagSeams 2026-07-31-03:10 (#2822 review — greptile):
    AN EXEMPTION IS BOUNDED BY COUNT, NOT OPEN-ENDED.

    `<file>::<function>` previously exempted EVERY call to that function in that file, so a later call
    added without the flags was silently covered and the gate stayed green — an exemption that grows to
    fit whatever arrives is not an exemption, it is a hole. That is the same defect this gate exists to
    catch (`isTaskStuck` shipped two of three sites unsupplied and the gate was green), one level up in
    the gate itself.

    Each entry now records HOW MANY omissions were reviewed. Extras beyond that count are reported like
    any other unsupplied site, so adding a call site cannot inherit someone else's review.
    */
    const omittingAll = sites.filter((site) => site.args < arity);
    const usedPerKey = new Map();
    const omitting = [];
    for (const site of omittingAll) {
      const key = `${site.file}::${fn}`;
      const entry = ALLOWED_OMISSIONS.get(key);
      if (entry === undefined) { omitting.push(site); continue; }
      const used = usedPerKey.get(key) ?? 0;
      if (used < entry.count) { usedPerKey.set(key, used + 1); continue; }
      omitting.push(site);
    }

    /* Same staleness rule as the name-level list: an exemption whose site now supplies is dead. */
    for (const [key, entry] of ALLOWED_OMISSIONS) {
      const [siteFile, siteFn] = key.split("::");
      if (siteFn !== fn) continue;
      const omittingHere = sites.filter((candidate) => candidate.file === siteFile && candidate.args < arity).length;
      if (omittingHere === 0) {
        stale.push(`  ${key} — no unsupplied call site remains; remove its ALLOWED_OMISSIONS entry`);
      } else if (omittingHere < entry.count) {
        /*
        A count that overshoots is the same hazard in miniature: it silently pre-authorises an omission
        that has not been reviewed. Narrow it in the change that fixed the site.
        */
        stale.push(`  ${key} — count is ${entry.count} but only ${omittingHere} site(s) omit; lower it`);
      }
    }
    if (ALLOWED.has(fn)) {
      /*
      An allow-list entry whose site is now SUPPLIED is stale, and a stale exemption is how a guard
      quietly stops guarding a file nobody is looking at any more. Fail so the entry is removed in the
      same change that fixed the site — the same staleness rule the sync-resolver allow-list uses.
      */
      if (!unsupplied) stale.push(`  ${fn} — now supplied; remove its ALLOWED entry`);
      continue;
    }
    if (unsupplied) {
      offenders.push(`  ${file}: ${fn}() — best call passes ${best} of ${arity}`);
    } else if (omitting.length > 0) {
      const where = omitting.map((site) => `${site.file}:${site.args}`).join(", ");
      partial.push(`  ${file}: ${fn}() — supplied by ${sites.length - omitting.length}/${sites.length}`
        + ` call sites; omitted at ${where} (of ${arity})`);
    }
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

  /*
  AN EXEMPTION FOR A FUNCTION THAT NO LONGER EXISTS ALSO ROTS.

  The staleness check above only fires for a seam the scan still FINDS — it asks "is this site supplied
  now?". Delete the declaration and the name is never iterated, so its entry sits in the list forever,
  silently exempting nothing and misleading the next reader about what is tolerated. Found by deleting
  `evaluateMergeBlockerGuard` and watching the gate stay quiet about its leftover entry.
  */
  for (const fn of ALLOWED.keys()) {
    if (!declared.has(fn)) stale.push(`  ${fn} — no such seam declared any more; remove its ALLOWED entry`);
  }

  /*
  FNXC:InertFlagSeams 2026-07-31-03:45 (#2830 review — greptile):
  THE SAME ROT REACHES ALLOWED_OMISSIONS, and the pass above did not cover it.

  Both staleness rules for the per-site list live inside the per-declaration loop, so they only run for
  a function the scan still FINDS. Delete or rename the function and that loop never visits it: the
  `<file>::<fn>` entry survives, exempting nothing, while reading as a reviewed and tolerated omission.

  This is the identical defect the ALLOWED pass above was added to fix — written for one of the two
  lists and not the other, which is the half-conversion shape this repo keeps producing. Same check,
  same failure mode, so it belongs immediately beside it rather than folded into the loop that cannot
  see deletions.
  */
  for (const key of ALLOWED_OMISSIONS.keys()) {
    const [, siteFn] = key.split("::");
    if (!declared.has(siteFn)) {
      stale.push(`  ${key} — no such seam declared any more; remove its ALLOWED_OMISSIONS entry`);
    }
  }

  /*
  FNXC:LifecycleColumnCensus 2026-07-30-23:55 (a STALE exemption WARNS; it does not fail):

  This used to exit 1. Same mistake as the SQL ratchet's drop check, and with the same measured cost:
  an entry goes stale precisely because somebody FIXED the seam it covered, so the gate punished the
  people who did the right thing.

  Three times this week — `getTotalAgentActiveMs`, the two near-duplicate omission entries, and
  `isPlanningContinuationTaskDispatchable`. Each fix was correct, each left an entry behind, and each
  turned the check red for everyone until the entry was deleted by hand. Twice that was main.

  A stale entry is worth removing: it exempts a function nobody is guarding any more. But the cost of
  leaving it is bounded — one function unguarded, listed loudly on every run — while a gate that fails
  on other people's correct fixes gets ignored, and then nothing is guarded at all. That is the
  census's reasoning, applied unchanged.

  The RISE case — a NEW unsupplied or partially-supplied seam, the actual purpose — still fails hard
  below. Unlike the SQL baseline this cannot auto-prune: the entries live in source with their reasons
  attached, and rewriting them from a script would delete the reasoning with the line.
  */
  if (stale.length > 0) {
    console.warn("\n[check-inert-flag-seams] STALE allow-list entries — supplied now, or no longer declared:\n");
    for (const line of stale.sort()) console.warn(line);
    console.warn(
      "\nDelete them: each exempts a function that is no longer unguarded, so the list now claims to\n"
      + "tolerate something it does not. Not fatal — the seam it covered is FIXED, and failing here\n"
      + "would punish whoever fixed it.\n",
    );
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

  if (partial.length > 0) {
    console.error("\n[check-inert-flag-seams] lane/flag parameter supplied at SOME call sites only:\n");
    for (const line of partial.sort()) console.error(line);
    console.error(
      "\nThe listed call sites take the legacy fallback while their siblings resolve the real column,\n"
      + "so the guard is correct on the board you tested and degrades on the one you did not. Supply the\n"
      + "argument at every site, or delete the parameter and leave the literal counted.\n",
    );
    process.exit(1);
  }

  console.log(
    `[check-inert-flag-seams] ${declared.size} lane/flag seams, all supplied at every production call site.`,
  );
}
