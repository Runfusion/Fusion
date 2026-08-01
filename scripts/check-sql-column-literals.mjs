#!/usr/bin/env node
/*
FNXC:LifecycleColumnCensus 2026-07-30-09:30:
FREEZE THE SQL SURFACE — a legacy column id inside a query string is invisible to every other check.

The lifecycle-column census parses TypeScript COMPARISONS. A legacy id inside a SQL string is not a
comparison, it is string data, so the census has never counted these. The inert-seam gate reasons
about parameters and call sites, so it cannot see them either. The surface was uninstrumented.

WHAT IT COST. `cleanupStaleMergeQueueRowsImpl` filtered on `t.column != 'in-review'`. On a board with
a renamed review lane every queued card looked stale, its merge_queue row was deleted, and the card
became unleaseable. Found by the operator reviewing #2819 — in SQL that had already been read past
during that same work, because nothing draws the eye to a literal inside a query.

The analytics group is the quieter half: five sites count `"column" = 'done'`, so on a renamed board
throughput, cycle time, and team dashboards report zero completed work. Nothing errors. Wrong-but-
plausible numbers are the least likely defect for anyone to file.

WHAT THIS DOES. It does NOT fix the existing sites — `resolveProjectColumnsForRoles`
(core/src/project-lane-vocabulary.ts) is the mechanism for that and its migration has an owner (see
issue #2839). This freezes the population so the surface cannot grow while that migration runs: the
baseline records per-file counts, a new file or a higher count fails, and a LOWER count fails too so
the baseline is ratcheted down as sites are migrated rather than silently drifting.

COMMENTS ARE NOT MATCHED, and that is the whole reason this is AST-based. A line-oriented grep for
the same pattern reported 37 hits when this was written (2026-07-30), 25 of them prose quoting
`column === "done"` in an explanatory note. Re-measured 2026-07-31: 38 grep hits against 20 real ones.
The totals drift as conversions land and comments do not — the RATIO is the argument, and it has held
at roughly half. A guard with a 68% false-positive rate teaches its readers to skip it, and this repo already
learned that lesson the expensive way. Comments are not AST nodes, so walking string and template
literals cannot match them at all.
*/
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(REPO, "packages");
/*
FNXC:LifecycleColumnCensus 2026-07-30-23:58:
`scripts/` is scanned, and `.mjs` counts — the operator scripts were the one place raw SQL actually
lived, and this gate could not see any of it.

Found by removing a raw-SQL lane literal from `scripts/reconcile-leaked-soft-deletes.mjs` and watching
this gate report "22 known, none added" — unchanged and green. Its own header promises the opposite
("a LOWER count fails too so the baseline is ratcheted down"), so the silence was the tell.

TWO changes, and either alone still sees nothing: the walk started at `packages` only, and the filter
took `.tsx?`, while every operator script is a repo-root `.mjs`. Adding one without the other scans
nothing new and reports a reassuring zero — the same trap #2978 hit widening the lane-wiring census.

This does NOT contradict the `.sql` note below. That reasoning is about feeding DDL to a TypeScript
parser; `.mjs` IS JavaScript, so the existing AST walk applies unchanged.

The ScriptKind move is DEFENSIVE, and I could not demonstrate it was necessary — stated plainly
because the opposite claim would be easy to make and wrong. TSX reads `<` as JSX, so an ordinary
comparison in a plain script is a plausible misparse; I tried three shapes for it
(`x <div> y`, `f<b, c>(d)`, a literal between `<` and `>` comparisons) and TSX recovered from all of
them, returning the same count as JS. So JS is used for `.mjs` because it is the correct kind for the
file, not because a miss was observed.
*/
const SCRIPTS = join(REPO, "scripts");
const BASELINE = join(REPO, "scripts", "lib", "sql-column-literals-baseline.json");
const SKIP_DIRS = new Set(["node_modules", "dist", "__tests__", "__mocks__", "e2e", ".gate-bundle", "coverage"]);

/** The pre-workflow column ids. A query comparing a column to one of these is board-vocabulary-bound. */
const LEGACY_IDS = ["todo", "in-progress", "in-review", "done", "archived", "triage"];
/*
GLOBAL, because the unit of measurement is the COMPARISON, not the literal — two legacy comparisons
in one query must count as two. No file currently has that shape (every matching literal holds
exactly one), so this is defensive rather than a recorded incident; it is the same class as the
one-supplier floor the inert-seam gate had to fix, and cheaper to get right now than to discover.
*/
const COLUMN_REF = `(?:"column"|\\bcolumn)`;
const LEGACY_ID = `'(?:${LEGACY_IDS.join("|")})'`;
/*
FNXC:LifecycleColumnCensus 2026-07-30-20:20 (#2841 review, second round — greptile P1 "IN predicates
bypass the gate"):

`IN (...)` IS A COMPARISON, AND EACH ELEMENT IS ONE.

The operator list was `=`, `!=`, `<>`, so `"column" IN ('in-progress', 'in-review')` contributed
nothing and a second predicate in that form could be added while the baseline stayed green. It is the
same false-negative class as the pre-filters removed in the first round — a shape the pattern simply
did not describe.

`IS DISTINCT FROM` was a sixth-round finding and a live one: `async-merge-coordination.ts` writes
`${schema.project.tasks.column} IS DISTINCT FROM 'in-review'` — the merge-queue stale sweep, one of
the queries this gate exists to freeze — and the operator list did not contain it, so the predicate
counted zero. `IS`/`IS NOT` are included alongside for the same reason: they are the same comparison
wearing different SQL spelling, and enumerating operators one review round at a time is how the last
five holes happened.

The IN arm counts its LEGACY ELEMENTS, not the predicate: two ids in one list is two vocabulary-bound
sites, the same accounting the `=` arm uses when a query holds two comparisons. The list body is
matched loosely (`[^)]*`) so a mixed list — a legacy id beside a resolved one — is still caught, and
the per-element count is taken from the matched text afterwards.
*/
/*
FNXC:LifecycleColumnCensus 2026-07-30-22:20 (#2841 review, third round — greptile P1 "nested IN
expressions evade scanning"):

`[^)]*` STOPS AT THE FIRST `)`, WHICH A NESTED CALL SUPPLIES.

`"column" IN (COALESCE(x, y), 'done')` never reached its legacy id: the leading `[^)]*` halted at
`COALESCE(x, y)`'s closing paren, the id after it was unreachable, and the predicate contributed
nothing. A third false negative of the same family as the first two rounds — a shape the pattern did
not describe — and the reviewer is right that another one could be added with the baseline green.

The IN body now tolerates nested groups TWO levels deep (`LOWER(COALESCE(a, b))` is the realistic
worst case in this codebase). A regex cannot balance arbitrary nesting, and the alternative — matching
the predicate head and extracting the balanced region programmatically — buys a depth nobody writes at
the cost of a second scanner to keep correct. The bound is stated here rather than hidden: at three
levels the gate under-counts again, which is a known limit, not an unknown one.
*/
const IN_BODY = `(?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*`;
export const COMPARISON = new RegExp(
  `${COLUMN_REF}\\s*(?:(?:=|!=|<>|IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM|IS\\s+(?:NOT\\s+)?)\\s*${LEGACY_ID}|(?:NOT\\s+)?IN\\s*\\(${IN_BODY}${LEGACY_ID}${IN_BODY}\\))`,
  "gi",
);
/** Legacy ids inside one matched predicate — an `IN` list can hold several. */
const LEGACY_ID_GLOBAL = new RegExp(LEGACY_ID, "gi");

/** How many vocabulary-bound sites one matched predicate represents. */
export function comparisonWeight(match) {
  LEGACY_ID_GLOBAL.lastIndex = 0;
  return (match.match(LEGACY_ID_GLOBAL) ?? []).length;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-00:00: `.sql` IS DELIBERATELY NOT SCANNED, AND THE REASON
    IS THE PARSER, NOT AN OVERSIGHT.

    The sibling FNXC-date gate had the opposite defect — a plain-text scanner whose extension list
    named the file types stamps were EXPECTED in rather than the ones they OCCUR in, so it was blind
    to `.sql` and `.css` (#2954). That fix does not generalize here, and the two look alike enough
    that it is worth saying so once.

    This gate is AST-based: `ts.createSourceFile(..., ScriptKind.TSX)`, then a walk over string and
    template nodes. A `.sql` file is not TypeScript, so adding the extension would not widen coverage
    — it would feed DDL to the TS parser and traverse whatever lenient-mode nodes fell out, which is
    worse than not looking, because the gate would then REPORT coverage it does not have.

    Measured before deciding (2026-07-30): 38 tracked `.sql` files hold exactly one lifecycle-looking
    literal, `CHECK (status IN ('open','converged','archived'))` in 0022_ideation.sql. That is the
    ideation-session status enum — a different domain that happens to reuse the word, and not a
    `tasks.column` comparison this gate would flag even if it could see it. Zero real offenders.

    So the honest scope is: raw SQL is UNWATCHED, and the thing that would make it worth watching is a
    data backfill (`UPDATE tasks SET column = ...`) landing in a migration. If one ever does, this
    needs a separate raw-text matcher against `COMPARISON`, not an entry in the filter below.
    */
    else if (/\.(tsx?|mjs)$/.test(full) && !/\.d\.ts$/.test(full)) yield full;
  }
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-19:10 (#2841 review — greptile x2 + coderabbit x2, one root cause):

THE PRE-FILTERS WERE THE HOLE, SO THEY ARE GONE.

Four findings arrived against three lines and all reduce to the same mistake: deciding whether to RUN
the comparison regex, using cheaper patterns that disagree with it.

  - A FILE-LEVEL `SQL_SHAPE.test(source)` short-circuit skipped whole files. A file holding only a
    clause fragment (`"column" = 'done'`) has no SELECT/WHERE anywhere, so a new forbidden site could
    be added to it and the gate passed. The exact shape the fragment carve-out below was added for,
    reintroduced one level up.
  - `BARE_CLAUSE` is anchored `^...$`, so a qualified or compound fragment — `t."column" = 'done'`,
    `("column" = 'done' OR active = 1)` — matched neither it nor `SQL_SHAPE`, and the comparison never
    ran.
  - `node.getText()` returns SOURCE text, so a double-quoted TypeScript string spells the identifier
    `\"column\"` with the backslashes intact, and every pattern here expects the decoded `"column"`.

A gate whose false-NEGATIVES are this easy to construct is worse than no gate, because the baseline it
prints reads as coverage. The fix is to stop pre-filtering: run `COMPARISON` — which is already
unanchored and already the definition of a forbidden site — over the DECODED text of every string and
template literal. One pattern, one answer, nothing to disagree with.

THE FALSE-POSITIVE ARGUMENT SURVIVES INTACT, because it never depended on the pre-filters: comments
are not AST nodes, so walking literals cannot match prose no matter how permissive the pattern is.
That is what makes dropping them safe.

`SQL_SHAPE` and `BARE_CLAUSE` are deleted rather than left unused — an unused pattern in a gate is an
invitation to re-add a filter that uses it.
*/

/**
 * The DECODED content of a string or template literal, or null for any other node.
 *
 * `.text` is decoded (`\"` becomes `"`); `.getText()` is not.
 *
 * FNXC:LifecycleColumnCensus 2026-07-30-20:35 (#2841 review, second round — greptile P1
 * "interpolated columns disappear during scanning"):
 *
 * A DRIZZLE COLUMN REFERENCE IS AN INTERPOLATION, AND DROPPING IT DROPPED THE WHOLE PREDICATE.
 *
 * The first version joined only the STATIC spans, on the reasoning that an interpolated expression
 * cannot be part of a matched comparison. That is exactly backwards for the dominant production
 * shape: a Drizzle template puts the COLUMN in the hole and the legacy id in the static text, so
 * `${schema.project.tasks.column} != VALUE` joined to text with no column identifier in it and
 * matched nothing. The merge-queue and self-healing queries this gate exists to freeze are written
 * this way, so it was blind on its primary target.
 *
 * An interpolation that NAMES a column is therefore rendered as the literal token `"column"` — the
 * spelling the pattern already looks for — and every other interpolation becomes a NUL sentinel.
 * A space would not do: `\`"column" = ${expr}'done'\`` joins to `"column" =  'done'`, a comparison
 * that is not in the source. NUL cannot appear inside any pattern here, so it breaks the splice.
 *
 * The test is the expression's TRAILING property, not a resolved type: this is a standalone script
 * with no type-checker, and an AST gate earns its place by staying cheap. A false positive costs one
 * baseline entry; the false NEGATIVE it replaces cost the gate its meaning on its own target files.
 */
/*
FNXC:LifecycleColumnCensus 2026-07-30-17:25 (#2841 review, fourth round — greptile P1
"bracket-access columns evade scanning"):

`schema.project.tasks["column"]` IS THE SAME REFERENCE WRITTEN DIFFERENTLY.

The dot form was the only one matched, so an element-access reference fell through to the NUL
sentinel and its predicate vanished — the identical blindness the static-span join had, reachable by
changing punctuation. Drizzle accepts both spellings and a formatter or a reserved-word column can
produce the bracket one.

Both quote styles and a trailing `!`/`?` are tolerated for the same reason the rest of this scanner
is permissive: the cost of a false positive is one baseline entry, and the cost of a false negative
is a gate that reads as coverage.

The `!` arrived as its own finding (#2841 review, fifth round) because the previous version DOCUMENTED
tolerating it and did not implement it — the comment described the intent and the regex described the
behaviour, and only one of them was executable. A comment that overstates a guard is worse than none:
it is the thing a reader checks instead of the code.
*/
const COLUMN_PROPERTY = /(?:(?:^|\.)column|\[\s*["'`]column["'`]\s*\])[!?]*$/;

/*
FNXC:LifecycleColumnCensus 2026-07-30-22:30:
A LITERAL HOISTED INTO A NAMED CONST IS THE SAME DEFECT, and the span scan could not see it.

    const LANE = "done";
    sql`... WHERE "column" = ${LANE}`

    const LANES = ["in-progress", "in-review"];
    sql`... WHERE "column" IN (${sql.join(LANES)})`

Both bind a query to the legacy vocabulary exactly as an inline 'done' does. Neither was counted: an
interpolation that is not a column reference became the NUL sentinel, so the predicate dissolved
before the matcher ever ran.

THIS IS THE SHAPE A CLEANUP PRODUCES. Hoisting a repeated string to a named const reads as tidying,
and is the most likely way one of these gets rewritten — the gate would go quiet on a file that
changed only in punctuation, which is the failure this scanner has now had three times (the static
span join, the element-access column reference, and this).

The array form is not hypothetical: IN ('in-progress','in-review') was the live workflow-analytics
defect, and hoisting that list is the obvious tidy-up.

Found by mutation with shapes deliberately NOT in mind when the scanner was written, after arguing in
#2979 that ratchets should be probed that way on the day they ship. Two of three probes got through.

SCOPE: same-file const declarations holding a string or an array of strings. Cross-file imports are
NOT resolved — that needs a type checker and a program-wide pass, and the honest boundary is worth
more than a half-resolution that reads as coverage. A constant imported from another module is still
invisible, and --list output is where that gets audited, not this comment.
*/
/*
FNXC:LifecycleColumnCensus 2026-07-30-23:05:
ONLY BARE LANE IDS ARE RESOLVED, and this restriction is load-bearing rather than cautious.

The first version resolved any string-valued const. Several analytics files build their queries as
`const completedClauses = [`t."column" = 'done'`, ...]` and then interpolate `clauses.join(" AND ")`
— those elements are SQL FRAGMENTS that the scanner already counts where they are written, so
resolving them re-injected each one into the outer template and counted it a second time. The three
analytics files jumped from 3/3/1 to 6/5/2 with no new defect anywhere: pure double counting, and it
read exactly like a real find.

A hoisted lane id is a bare token — `done`, `in-progress`. Anything carrying quotes, spaces or SQL
punctuation is a fragment, already covered at its own site, and must not be resolved here.
*/
const BARE_LANE_ID = /^[A-Za-z0-9_-]+$/;

export function collectStringConsts(sf) {
  const consts = new Map();
  const unwrap = (n) => (n && (ts.isAsExpression(n) || ts.isParenthesizedExpression(n)) ? unwrap(n.expression) : n);
  const isStr = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      if (isStr(init) && BARE_LANE_ID.test(init.text)) consts.set(node.name.text, [init.text]);
      else if (ts.isArrayLiteralExpression(init)) {
        const elements = init.elements.map(unwrap);
        if (elements.length > 0 && elements.every((e) => isStr(e) && BARE_LANE_ID.test(e.text))) {
          consts.set(node.name.text, elements.map((e) => e.text));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return consts;
}

/**
 * The SQL text an interpolation stands in for, when it resolves to a known constant.
 * Any identifier in the expression is a candidate, so sql.join(LANES) and inArray(x, LANES) resolve
 * the same way a bare ${LANES} does — the wrapper call does not change the vocabulary.
 */
function resolvedSpanText(expression, consts) {
  for (const identifier of expression.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    const values = consts.get(identifier);
    if (values) return values.map((value) => `'${value}'`).join(",");
  }
  return null;
}

export function literalText(node, consts = new Map()) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    const parts = [node.head.text];
    for (const span of node.templateSpans) {
      const expression = span.expression.getText().trim();
      if (COLUMN_PROPERTY.test(expression)) parts.push('"column"');
      else parts.push(resolvedSpanText(expression, consts) ?? "\u0000");
      parts.push(span.literal.text);
    }
    return parts.join("");
  }
  return null;
}

/** Per-file counts of SQL literals comparing a task column to a legacy id. */
/*
FNXC:LifecycleColumnCensus 2026-07-30-15:10:
`--list` prints every match, because a baseline number cannot be reviewed.

This gate reported "14 sites" for days and the real population was 31 — the gap was five classes of
false negative, and the one that mattered was found by asking "why is the merge-queue query, the
reason this check exists, not in the output?". That question is unanswerable against a count. A tool
that freezes a population has to be able to show it, or its own number is the only evidence anyone
has for what it covers.
*/
const LIST = process.argv.includes("--list");
const matches = [];

function scan() {
  const counts = {};
  for (const file of [...walk(PACKAGES), ...walk(SCRIPTS)]) {
    const source = readFileSync(file, "utf8");
    /* The correct kind for the file. Defensive rather than a proven fix — see the header. */
    const kind = file.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TSX;
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
    const consts = collectStringConsts(sf);
    let hits = 0;
    const visit = (node) => {
      const text = literalText(node, consts);
      if (text !== null) {
        COMPARISON.lastIndex = 0;                         // a /g regex carries state between calls
        for (const match of text.match(COMPARISON) ?? []) {
          hits += comparisonWeight(match);
          if (LIST) {
            const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
            const rel = relative(REPO, file).split("\\").join("/");
            matches.push(`  ${rel}:${line}  ${match.replace(/\s+/g, " ").trim()}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    if (hits > 0) counts[relative(REPO, file).split("\\").join("/")] = hits;
  }
  return counts;
}

/*
FNXC:LifecycleColumnCensus 2026-07-30-21:00 (#2841 review, second round):
GUARDED ENTRY POINT, so importing this module does not RUN the gate.

`check-sql-column-literals.test.mjs` imports `COMPARISON` and `literalText` to test the matcher
directly. Without this guard the import executed the whole scan, printed the gate's report, and called
`process.exit(1)` — so the test file failed for the gate's reasons rather than its own, and while the
gate happened to be green it passed for reasons unrelated to what it asserts. A test that can be made
to pass or fail by unrelated repo state is not a test.
*/
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = scan();

  if (LIST) {
  for (const line of matches.sort()) console.log(line);
  console.log(`\n[check-sql-column-literals] ${matches.length} match(es) in ${Object.keys(found).length} file(s).`);
  process.exit(0);
}

if (process.argv.includes("--update-baseline")) {
    writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
    const total = Object.values(found).reduce((a, b) => a + b, 0);
    console.log(`[check-sql-column-literals] baseline written: ${total} site(s) in ${Object.keys(found).length} file(s)`);
    process.exit(0);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch {
    console.error("[check-sql-column-literals] missing baseline; run with --update-baseline");
    process.exit(1);
  }

  const problems = [];
  for (const [file, count] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      problems.push(`  ${file}: ${count} SQL column literal(s), baseline allows ${allowed}`);
    }
  }
  /*
  FNXC:SqlColumnLiteralRatchet 2026-07-31-06:40 (a DROP now tightens instead of failing the merge gate):
  A stale allowance is still rot — a migrated site that leaves its entry behind is a slot the surface
  can regrow into. But hard-failing on it put THIS CHECK, which runs inside `pnpm test:gate`, into a
  state where one converting PR blocked every other worker's PR until someone re-recorded by hand.
  Observed twice: `team-analytics.ts` 6 -> 3 took the gate down, and the lifecycle census hit the same
  shape earlier from a merge wave that dropped eleven files at once.

  The census already resolved this exact trade-off and its reasoning applies here with MORE force,
  because that ratchet is not in the blocking lane and this one is (docs/testing.md):

    "the drop is almost never the failing author's to fix ... A permanently-red gate is a bigger hole
     than a stale allowance, because it gets ignored and then nothing is guarded at all."

  So a drop now rewrites the baseline downward, says what it lowered, and exits 0. The RISE check —
  the actual purpose, "no new SQL column literals" — is untouched and still fails hard.

  The rewritten file must be COMMITTED; in CI the write is discarded with the runner, which is why the
  gate goes green rather than silently passing a stale allowance.
  */
  const tightened = [];
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = found[file] ?? 0;
    if (count < allowed) tightened.push({ file, allowed, count });
  }

  if (problems.length > 0) {
    console.error("\n[check-sql-column-literals] SQL column-literal population changed:\n");
    for (const line of problems.sort()) console.error(line);
    console.error(
      "\nA legacy column id inside a query string is invisible to the lifecycle census and to the\n"
      + "inert-seam gate. Resolve the lane instead — `resolveProjectColumnsForRoles(store, roles)` in\n"
      + "core/src/project-lane-vocabulary.ts returns the column set for a role across all workflows.\n"
      + "If a count went DOWN, re-record the baseline in the same commit.\n",
    );
    process.exit(1);
  }

  if (tightened.length > 0) {
    /*
    FNXC:SqlColumnLiterals 2026-08-01-01:45 (u12 — last of three gates that wrote to the tree they check):
    This rewrote the baseline during a plain CHECK. The tightening is right — an allowance nobody spends
    is a hole a literal can be regrown into — but performing it as a side effect handed every worker a
    byte-identical uncommitted diff they had not authored, which they then reasonably committed.

    Measured cost across the family: nine PRs chased three defects on 2026-07-31/08-01, and two of them
    (#3283/#3285, five minutes apart, `+0/-1` each) deleted the SAME baseline line — neither author wrote
    it. As #3289 put it: a check that writes turns every reader into an author. Two of us separately
    mis-attributed a gate-written baseline to our own work while debugging something else.

    Fixed in #3287 (fnxc) and #3289 (census); this is the third and last. Still computed, still reported
    loudly, written only under --update-baseline. A plain run stays GREEN rather than failing: counts drop
    when someone ELSE's merge removes a literal, so failing would redden main on a change the author never
    made. Report, do not enforce — the rise path above still exits 1 and is untouched.
    */
    console.log("\n[check-sql-column-literals] baseline CAN BE TIGHTENED — fewer literals than it allowed\n");
    for (const { file, allowed, count } of tightened.sort((a, b) => a.file.localeCompare(b.file))) {
      console.log(`  ${file}: allowed ${allowed}, now ${count}`);
    }
    console.log(
      "\nNot written. Record it deliberately, so the diff has one author:\n"
      + "\n  node scripts/check-sql-column-literals.mjs --update-baseline\n",
    );
    process.exit(0);
  }

  const total = Object.values(found).reduce((a, b) => a + b, 0);
  console.log(`[check-sql-column-literals] ${total} known SQL column literal(s), none added.`);
}
