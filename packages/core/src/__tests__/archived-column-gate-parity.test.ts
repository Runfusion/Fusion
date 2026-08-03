/*
FNXC:WorkflowResolvedColumns 2026-07-31-00:40 (fleet phase — why `async-comments-attachments.ts` was NOT converted):
THE ARCHIVED GATE IS ENFORCED IN THREE ENCODINGS, AND CONVERTING ONE OF THEM IS A SPLIT BRAIN.

Every other file in the column-literal backlog can be converted on its own: resolve the task's
lifecycle columns, compare against the role. `archived` is different, and the difference is not a
matter of degree.

MEASURED on this tree — THREE encodings, 50 sites, all in packages/core:
  - 35 TypeScript comparisons against the literal `"archived"` across 23 files.

  (Was 37 when this guard landed. Two dropped as conversions merged — `agent-store.ts`'s claim guard in
  #2746 and one in `update-task-deps.ts` — and the guard FAILED until this inventory was updated to match,
  which is the ratchet working: it notices the TypeScript half moving in either direction, not only up.)
  - 7 Drizzle predicates pushing the same rule into SQL as `ne(tasks.column, 'archived')`, in 6 files.
  - 8 RAW `sql` template comparisons (`sql`${tasks.column} != 'archived'`` and one hand-written
    `SELECT ... "column" = 'archived'`), in 5 files.

I expected two halves and asserted the third was empty. It was not: the raw-template scan came back
with five files on the first run. That is the strongest argument in this file — a partial conversion
does not have to miss one encoding, it can miss two, and nothing in the codebase is counting them.

The SQL halves decide which rows a query RETURNS. The TypeScript half decides what the code does with
a row it already has. All three are encodings of one sentence: "an archived task is not live."

Convert only the TypeScript half and a board whose archived lane is renamed splits:
`getLiveTaskColumn` correctly reports the task archived (it resolved the role), while
`readLiveTaskRows` still hands that task back as live (its SQL still compares the string). A document
write is then rejected by one gate and its parent listed by the other — a state neither gate alone can
produce today, and one that no test would catch, because every builtin workflow spells the column
`archived` so the two halves agree by accident on every board we ship.

WHY THE SQL HALVES CANNOT JUST BE CONVERTED TOO. `ne(tasks.column, ...)` needs the resolved id as a
VALUE at query-build time, so the workflow IR must be resolved BEFORE the query — including inside
`for update` transactions in the document/artifact paths, which currently take no store and no
workflow reader (they receive a `db`/`tx` handle and a task id). Threading a resolver into the
persistence layer, or declaring `archived` a non-renameable system column and marking all 52 sites
deliberate, are both real decisions with real blast radius. Neither is a fleet conversion. The raw
templates are worse again: one of them is a hand-written `SELECT` string, so its comparison is not even
a Drizzle expression that could take a bound value without rewriting the query.

FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (THE TS REMAINDER IS EMPTY — enumerated, not sampled):
The note below sampled the TS inventory and said the conversion is "the six LANE Drizzle sites plus
whatever small TS remainder is neither a fallback arm nor a sentinel". That remainder is ZERO. I left
three sites unchecked when I wrote it; all three are fallback arms:

  live-agent-count.ts:164          `task.columnTerminalKind ?? (task.column === "done" ? ... )`
                                   — the resolved value wins via `??`; the literal chain is the
                                   fallback.
  store.ts:1972                    `if (!lanes) return dep.column !== "done" && ...`
                                   — an explicit no-metadata branch.
  branch-and-pr-entities.ts:525    `lanes === undefined ? task.column === "archived" : task.column === lanes.archived`

Added to the previously classified ones, every entry in AUDITED_TS_SITES is now accounted for as a
fallback arm, a STATE/sentinel comparison, or a converted guard's retained literal. None is an
unconverted LANE guard.

WHAT THAT MEANS: the "52 sites across three encodings" is fully triaged and the convertible work is
DONE — six Drizzle LANE sites plus the log-entry gate, all additive so the inventories never moved.
What the gate now protects is a population of fallback arms and STATE markers, which is exactly what
it should be protecting: those are the entries that must NOT drift, because each one is the documented
answer for a caller that supplies no resolved set.

The inventories therefore stay where they are. A future drop in any of the three counts means someone
removed a fallback or converted a STATE site — both regressions — which is the check this file was
built to make and is now the only check it needs to make.

FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (THE TS HALF — mostly already converted; the inventory
counts FALLBACK ARMS, which is why 20 reads as 20 outstanding guards and is not):
Sampled the TS inventory the same way. It does not decompose into LANE/STATE the way the SQL half
does, because most entries are not pending conversions at all:

  FALLBACK ARM of an already-converted guard — the literal is reached only when a caller supplies no
  resolved set, and it is the documented degraded answer:
    async-comments-attachments.ts   `archivedColumns ? has(row.column) : row.column === "archived"`
                                    — already marked DELIBERATE-LITERAL / FALLBACK ARM in place.
    update-task-deps.ts:406-408     resolved arm first (`lifecycle?.archived ?? "archived"`), literal
                                    last.
    task-merge.ts:478,489           `if (!columns) return dependency.column === "done" || ...` — the
                                    whole branch is the no-metadata fallback.

  STATE / SENTINEL, not a lane:
    task-id-integrity.ts:444        compares `getLiveTaskColumn`'s MANUFACTURED "archived", which that
                                    function returns for archived OR SOFT-DELETED rows. A normalized
                                    sentinel; resolving it would compare a lane id against a value no
                                    lane produces.
    archive-lifecycle-2.ts:47       `column: "archived"` is a WRITE — it SETS the archive state.

So the TS count overstates outstanding work in the OPPOSITE direction from the SQL count: the SQL half
had two sites that must never be converted, and the TS half has several that are already correct.

WHAT THIS MEANS FOR THE DECISION. "52 sites across three encodings" is the number the gate must keep
in LOCKSTEP, not the number a conversion has to CHANGE. After triage the conversion is the six LANE
Drizzle sites plus whatever small TS remainder is neither a fallback arm nor a sentinel — with the
inventories updated in the same commit so the three encodings stay in step.

That is a materially smaller and better-understood change than the headline implies, and it is now
specified rather than estimated. Still not done here: the gate requires one coordinated commit, and
the remaining judgement is per-site verification of the TS remainder, which wants the owner making the
conversion rather than a third pass of sampling.

FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (THE TRIAGE, DONE — 8 SQL sites classified with evidence):
The scoping note below says the first question is "which of these are LANE questions and which are
STATE markers?" and that nobody had answered it. Answered here for the Drizzle half, per site, by
reading what each query is FOR. Nothing is converted; this is the input the conversion needs.

LANE (6) — these select or exclude LIVE work, so a renamed archive lane must be resolved:
  store.ts                    revert lookup: ne(archived) + ne(done) picking live revert candidates.
  branch-group-ops.ts:82      near-duplicate marker cleanup over live rows: ne(archived) + ne(done).
  branch-and-pr-entities:438  content-fingerprint duplicate guard, gated on `!includeArchived`.
  branch-and-pr-entities:470  recent sibling lookup: ne(archived) + ne(done).
  async-lifecycle.ts:68       `liveLineageChildFilter` — the name is the classification.
  async-search.ts:82          `liveSearchPredicate(includeArchived)` — same.
  Four of these already hold `store`/`this.asyncLayer`; the two predicate builders need one
  optional parameter each, the shape used throughout this program.

STATE (2) — these are ABOUT the marker `archiveTask` writes, and converting them would be a BUG:
  task-mutation-ops.ts:1072   `cleanupArchivedTasksImpl` selects eq(column,"archived") and then `rm`s
                              each row's files. Widening to the resolved archived set would feed cards
                              merely RESTING in a board's archive lane into a filesystem delete. This
                              is the most destructive site in the family and it looks identical to the
                              LANE ones at a glance — same column, same operator.
  async-self-healing.ts:61    soft-deleted rows whose column DRIFTED from the archive marker
                              (`isNotNull(deletedAt) && ne(column,"archived")`). Resolving it would
                              classify a soft-deleted row sitting in a renamed archive lane as drift
                              and "repair" it.

The raw-SQL half is already partly triaged in place: `async-maintenance.ts` is marked
DELIBERATE-LITERAL as a STATE marker, and `async-archive-lineage.ts`'s soft-delete path writes
`column = 'archived', deleted_at IS NOT NULL` as the storage state it has just set — STATE by
construction.

SO THE SHAPE OF THE WORK: roughly three quarters LANE, one quarter STATE, and the STATE sites are the
ones that destroy data if converted. That is why "convert all three encodings" cannot be done as a
sweep, and why the count alone made it look bigger than it is — the number to convert is smaller than
52, and the number that must NOT be touched is the part worth being careful about.

NOT CONVERTED HERE, and deliberately: the gate requires all three encodings to move together, so a
conversion is one coordinated change with its inventories updated in the same commit. This supplies
the classification that change needs; it does not pre-empt it.

FNXC:WorkflowResolvedColumns 2026-07-31-23:55 (SCOPING — the choice is not 52-or-nothing):
"Convert all three encodings" and "declare `archived` non-renameable" are the two options offered, and
both sound enormous because 52 sites are counted as one lump. They are not one lump: the sites answer
TWO DIFFERENT QUESTIONS, and only one of them is a lane question.

  LANE:  "is this row resting in the board's archive lane?" — renameable, must resolve.
  STATE: "did Fusion archive this row?" — the marker `archiveTask` writes, NOT renameable.

`async-maintenance.ts` already draws that line and marks its site DELIBERATE-LITERAL: "the STATE
marker here, not a lane... a card merely sitting in a workflow's archived-TRAIT lane is live work and
must not be collected." Converting that site would be a BUG, not progress.

MEASURED, on the SQL half this file calls the hard part — 8 Drizzle sites across 7 files:
  FOUR already have a `store` in scope and could take a resolved set with no signature change:
      branch-group-ops.ts        clearNearDuplicateReferencesToImpl(store, ...)
      branch-and-pr-entities.ts  findRecentTasksByContentFingerprintImpl(store, ...)   [2 sites]
      task-mutation-ops.ts       cleanupArchivedTasksImpl(store)
  FOUR need one parameter each, the optional-lane-set shape used throughout this program:
      async-lifecycle.ts    liveLineageChildFilter(parentId, projectId?)
      async-search.ts       liveSearchPredicate(includeArchived, projectId?)
      async-self-healing.ts listSoftDeletedColumnDriftCandidates(db, ...)
      store.ts              the revert-lookup conditions (already holds `this.asyncLayer`)

That is not "threading a resolver into the persistence layer". It is four call sites that already have
what they need plus four one-parameter widenings — before the triage above removes the STATE sites
from the count. (Two of the four "already have a store" sites turned out to be STATE on inspection;
the triage note above is the authority, this is the reachability survey that preceded it.)

FNXC:WorkflowResolvedColumns 2026-07-31-23:50 (one wrong reason for picking the cheap option, removed):
The second option looks like it has already been taken — `trait-types.ts` annotates the flag
"RESTRICTED (built-in only)", which reads as "a custom board cannot have its own archive lane". It does
not mean that. The restriction is over trait REGISTRATION: `trait-registry.ts` rejects a NON-BUILTIN
(plugin-defined) trait that declares `archived` or `complete` (R22). A custom WORKFLOW may put the
built-in `archived` trait on a column with any id, and the trait system resolves it — proved in
`archived-lane-is-renameable-today.test.ts`. So option two is a capability REMOVAL that would silently
break any board that has already renamed its archive lane, not the documentation of a constraint that
already exists. That does not decide between the options; it removes a wrong reason for the cheap one.

SO THIS FILE IS THE GUARD, NOT THE FIX. It fails when any of the three encodings stops matching its
audited inventory below — which is exactly what a well-intentioned partial conversion does.

REVERT CHECK, measured. Converting the `archived` comparisons in `async-comments-attachments.ts` (the
shape a conversion PR would produce) drops its audited count from 8 and fails the lockstep case with the
split-brain message. Removing one Drizzle predicate and removing one raw template each fail it from
their own side. All three were run.
*/
import { describe, expect, it } from "vitest";

/**
 * Files that compare a task column against the literal `"archived"` in TypeScript, with the number
 * of comparisons in each. Counts, not line numbers: line numbers churn on every unrelated edit and a
 * ratchet that cries wolf gets deleted.
 */
const AUDITED_TS_SITES: Readonly<Record<string, number>> = {
  "packages/core/src/agent-store.ts": 1,
  /*
  FNXC:WorkflowResolvedColumns 2026-07-30-23:00: 2 -> 1. #2925 converted one of the two comparisons
  in this file to resolve through `terminalColumns?.archived`, falling back to the literal only when
  no set is supplied. The remaining 1 is that fallback, which is why the count drops rather than
  going to zero. Behaviour unchanged for an unconverted caller; this is the inventory following a
  real conversion, not a silenced assertion.
  */
  "packages/core/src/async-mission-store-queries.ts": 1,
  "packages/core/src/eval-signal-collector.ts": 1,
  "packages/core/src/live-agent-count.ts": 1,
  "packages/core/src/mission-store.ts": 1,
  "packages/core/src/store.ts": 1,
  "packages/core/src/task-merge.ts": 2,
  "packages/core/src/task-store/archive-lifecycle-2.ts": 1,
  /*
  FNXC:ArchivedGateParity 2026-07-31-22:10:
  8 -> 5 after #2886, AND THE COUNT MOVED WITHOUT THE BEHAVIOUR MOVING. Read this before trusting it.

  #2886 fixed a real bug (the archived-document guards failed in OPPOSITE directions on a renamed
  lane) by replacing three `column === "archived"` comparisons with `isArchivedLane(column,
  archivedColumns)`. The AST scan counts raw comparisons, so the tally dropped and this file went red
  on main — the ratchet noticing the TypeScript half move, which is what it is for.

  What it is NOT is three sites converted. `archivedColumns` is an OPTIONAL parameter defaulting to
  `LEGACY_ARCHIVED_LANES = new Set(["archived"])`, and MEASURED: no caller anywhere in packages/core
  or packages/engine passes it. Every call therefore resolves to the same literal it replaced, so the
  behaviour is byte-identical and the resolved path is dead code today.

  That matters for the header's split-brain argument above. The danger it describes — the TypeScript
  half resolving the role while the SQL halves still compare the string — is NOT live here, precisely
  because the resolved half is unwired. It becomes live the moment a caller threads real lanes in
  without the SQL sides moving too. The Drizzle and raw-sql inventories are unchanged and still pass.

  So this number now means "5 raw comparisons remain" and NOT "3 sites are done". Wiring
  `archivedColumns` is the unfinished half, and doing it in isolation is the split brain this file
  exists to catch. Flagged on #2886.
  */
  "packages/core/src/task-store/async-comments-attachments.ts": 5,
  "packages/core/src/task-store/audit-ops.ts": 1,
  "packages/core/src/task-store/branch-and-pr-entities.ts": 1,
  "packages/core/src/task-store/moves.ts": 1,
  "packages/core/src/task-store/task-id-integrity.ts": 1,
  "packages/core/src/task-store/update-task-deps.ts": 1,
};

/**
 * Raw `sql` template comparisons — THE THIRD ENCODING, and the one this file was written expecting not
 * to exist. Invisible to the column census (not a comparison) and invisible to the Drizzle scan below
 * (not an `eq`/`ne` call), so before this inventory nothing in the repo counted them at all.
 */
/*
FNXC:WorkflowResolvedColumns 2026-07-31-16:40 (inventory re-recorded — the ratchet caught real movement):
TWO ENTRIES DROPPED, AND BOTH WERE DELIBERATE CONVERSIONS THAT LANDED WITHOUT UPDATING THIS FILE.

  async-mission-store.ts        2 -> 0   #3046 resolved `archiveDefinedFeatureBootstrapDuplicate`'s
                                         two `<> 'archived'` guards AND the `column: "archived"` write
                                         they gate, together — the write is a move TARGET, invisible
                                         to the column census, so converting the guards alone would
                                         have been the split brain this file warns about one level in.
  async-archive-lineage.ts      3 -> 2   #3042 deleted `liveParentFilter`, an export with no callers
                                         anywhere, which carried one of the three.

Recorded rather than argued: this file's own header notes the guard "FAILED until this inventory was
updated to match, which is the ratchet working". It went red on `main` for exactly that reason and
stayed red because neither PR knew this inventory existed — the archived gate is enforced in three
encodings and only the census-visible one announces itself.
*/
const AUDITED_RAW_SQL_SITES: Readonly<Record<string, number>> = {
  "packages/core/src/async-mission-store-queries.ts": 1,
  "packages/core/src/task-store/async-archive-lineage.ts": 2,
  "packages/core/src/task-store/async-maintenance.ts": 1,
  "packages/core/src/task-store/reads.ts": 1,
};

/**
 * Drizzle predicates pushing the same rule into SQL. THE HALF A CONVERSION PR FORGETS — it is not a
 * column comparison in any grep the column census runs, so the census reports these files as clean.
 */
const AUDITED_SQL_SITES: Readonly<Record<string, number>> = {
  "packages/core/src/store.ts": 1,
  "packages/core/src/task-store/async-lifecycle.ts": 1,
  "packages/core/src/task-store/async-search.ts": 1,
  "packages/core/src/task-store/async-self-healing.ts": 1,
  /*
  FNXC:ArchivedGateParity 2026-07-30-16:20:
  Newly VISIBLE, not newly written. `branch-group-ops.ts:58` binds the table first
  (`const table = schema.project.tasks`) and the scan previously required a literal `<x>.tasks`
  receiver, so this predicate was never audited — the inventory claimed six files while seven
  existed. Its TypeScript half was converted by #2745; this SQL half still compares the raw string,
  which is precisely the split-brain this file exists to catch and could not see.
  */
  "packages/core/src/task-store/branch-group-ops.ts": 1,
  "packages/core/src/task-store/branch-and-pr-entities.ts": 2,
  "packages/core/src/task-store/task-mutation-ops.ts": 1,
};

const SPLIT_BRAIN_EXPLANATION = [
  "",
  "THE ARCHIVED GATE HAS THREE ENCODINGS AND THEY MUST MOVE TOGETHER.",
  "",
  "  1. TypeScript comparisons   (AUDITED_TS_SITES)      — what code does with a row it has",
  "  2. Drizzle eq/ne predicates (AUDITED_SQL_SITES)     — which rows a query returns",
  "  3. Raw sql templates        (AUDITED_RAW_SQL_SITES) — same, invisible to both scans above",
  "",
  "If you converted the TypeScript comparisons to a resolved `archived` role, encodings 2 and 3",
  "still compare the raw string. On a board whose archived lane is renamed, one says a task is",
  "archived while the others return it as live — a document write rejected by its gate while its",
  "parent is listed as live.",
  "",
  "Every builtin workflow names that column `archived`, so all three agree by accident on every",
  "board we ship and no existing test can see the divergence.",
  "",
  "If you are converting on purpose: convert ALL THREE (the SQL sides need the resolved id as a",
  "query-build value, including inside the `for update` document/artifact transactions that",
  "currently receive no store, and one raw site is a hand-written SELECT string), or declare",
  "`archived` a non-renameable system column and mark the sites deliberate. Then update the",
  "inventories in this file in the SAME commit.",
  "",
  "If you did not mean to touch the archived gate, you added or removed a raw `archived`",
  "comparison — route it through the resolved role or add it to the inventory with a reason.",
].join("\n");

interface Site {
  readonly file: string;
  readonly line: number;
}

async function repoFiles(): Promise<{ root: string; files: string[] }> {
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const root = resolve(__dirname, "../../../..");
  const files = execFileSync("git", ["ls-files", "--", "packages/core/src"], { cwd: root, encoding: "utf-8" })
    .split("\n")
    .filter((f) => f && f.endsWith(".ts") && !f.includes("__tests__") && !f.includes("__test-utils__"));
  return { root, files };
}

function tally(sites: readonly Site[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return counts;
}

describe("the archived-state gate is enforced in TypeScript AND in SQL", () => {
  it("all three encodings of the archived gate stay in lockstep with the audited inventory", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { createRequire } = await import("node:module");
    const ts = createRequire(import.meta.url)("typescript") as typeof import("typescript");
    const { root, files } = await repoFiles();

    // Self-check: a resolution bug that yields no files would make every assertion below vacuous.
    expect(files.length).toBeGreaterThan(100);

    const { stripComments } = await import("../../../../scripts/lib/lifecycle-column-census.mjs") as {
      stripComments: (source: string) => string;
    };

    const tsSites: Site[] = [];
    const sqlSites: Site[] = [];
    const rawSqlCounts: Record<string, number> = {};

    /*
    The raw-template encoding, matched on comment-STRIPPED source. Reusing the census's `stripComments`
    rather than a second implementation: an earlier version of this scan counted three "sites" in
    async-archive-lineage.ts that were prose in a JSDoc block, which is how a guard ends up auditing
    documentation.
    */
    const RAW_SQL_ARCHIVED = /sql`[^`]*?(?:\.column|"column"|\bcolumn)[^`]*?'archived'/gs;

    for (const file of files) {
      const source = readFileSync(resolve(root, file), "utf-8");
      if (!source.includes("archived")) continue;

      const rawMatches = stripComments(source).match(RAW_SQL_ARCHIVED);
      if (rawMatches) rawSqlCounts[file] = rawMatches.length;

      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

      const lineOf = (node: import("typescript").Node): number =>
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

      /*
      FNXC:ArchivedGateParity 2026-07-30-16:20:
      Locals bound to the tasks table — `const table = schema.project.tasks` — so an aliased Drizzle
      predicate is not invisible to the SQL scan below. Collected in a first pass because the binding
      can appear after its uses inside nested closures.
      */
      const tasksAliases = new Set<string>();
      const collectAliases = (node: import("typescript").Node): void => {
        if (ts.isVariableDeclaration(node)
          && ts.isIdentifier(node.name)
          && node.initializer
          && ts.isPropertyAccessExpression(node.initializer)
          && node.initializer.name.text === "tasks") {
          tasksAliases.add(node.name.text);
        }
        ts.forEachChild(node, collectAliases);
      };
      collectAliases(sf);

      const visit = (node: import("typescript").Node): void => {
        /*
        TS half: `<something>.column === "archived"` (or `!==`). Keyed on the PROPERTY being named
        `column` rather than on the receiver, because the receiver is variously `task`, `row`,
        `currentTask`, `dep` and `t` — matching receiver names is how the earlier counts of this
        backlog disagreed with each other.
        */
        if (ts.isBinaryExpression(node)) {
          const isEquality = node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
            || node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken;
          if (isEquality) {
            for (const [a, b] of [[node.left, node.right], [node.right, node.left]] as const) {
              if (!ts.isStringLiteral(b) || b.text !== "archived") continue;
              /*
              A property named `column` OR a bare local named `column`. The bare form matters: the
              document/artifact list paths hold the value in a local (`if (column === null || column ===
              "archived") return []`), and a scan requiring a receiver misses four of the eight sites in
              async-comments-attachments.ts — measured, that is exactly what the first version did.
              */
              const inner = ts.isNonNullExpression(a) ? a.expression : a;
              /*
              FNXC:WorkflowResolvedColumns 2026-07-31-12:50 (#2724 review — greptile P2):
              ELEMENT ACCESS too. The first version accepted `x.column` and a bare `column`, so
              `row["column"] === "archived"` walked straight past the inventory — a guard defeated by
              changing syntax, which is precisely the failure I fixed in the maxWorktrees audit by moving
              from regex to AST and then re-introduced here in a narrower form.

              Optional chaining needs no special case: `a?.b` is still a PropertyAccessExpression in the
              TypeScript AST, so it was already covered.
              */
              const named = ts.isPropertyAccessExpression(inner)
                ? inner.name.text
                : ts.isElementAccessExpression(inner)
                    && inner.argumentExpression
                    && ts.isStringLiteral(inner.argumentExpression)
                  ? inner.argumentExpression.text
                  : ts.isIdentifier(inner) ? inner.text : undefined;
              if (named === "column") tsSites.push({ file, line: lineOf(node) });
            }
          }
        }

        /*
        SQL half: `eq(<...>.tasks.column, "archived")` / `ne(...)`. Drizzle builds the predicate as a
        call, so this is a CallExpression whose first argument is the tasks.column Column object and
        whose second is the literal.

        FNXC:ArchivedGateParity 2026-07-30-16:20:
        ALIASED TABLES COUNT TOO. This required the receiver to be literally `<x>.tasks`, so the very
        common Drizzle shape

            const table = schema.project.tasks;
            ne(table.column, "archived")

        was INVISIBLE to this scan — `branch-group-ops.ts:58` sat unaudited while the inventory
        claimed six files. A parity guard that cannot see one of the encodings reports agreement it
        never checked, which is the failure mode this whole file exists to prevent. Alias bindings are
        now collected per file and accepted as the receiver.
        */
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const fn = node.expression.text;
          if ((fn === "eq" || fn === "ne") && node.arguments.length === 2) {
            const [columnArg, valueArg] = node.arguments;
            const receiverIsTasks = (expr: ts.Expression): boolean =>
              (ts.isPropertyAccessExpression(expr) && expr.name.text === "tasks")
              || (ts.isIdentifier(expr) && tasksAliases.has(expr.text));
            const isTasksColumn = columnArg
              && ts.isPropertyAccessExpression(columnArg)
              && columnArg.name.text === "column"
              && receiverIsTasks(columnArg.expression);
            if (isTasksColumn && valueArg && ts.isStringLiteral(valueArg) && valueArg.text === "archived") {
              sqlSites.push({ file, line: lineOf(node) });
            }
          }
        }

        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    // Neither half may be empty: an empty side would let the lockstep assertion pass trivially.
    expect(sqlSites.length).toBeGreaterThan(0);
    expect(tsSites.length).toBeGreaterThan(0);

    expect(Object.keys(rawSqlCounts).length).toBeGreaterThan(0);

    expect(tally(tsSites), `TypeScript encoding changed.${SPLIT_BRAIN_EXPLANATION}`).toEqual(AUDITED_TS_SITES);
    expect(tally(sqlSites), `Drizzle encoding changed.${SPLIT_BRAIN_EXPLANATION}`).toEqual(AUDITED_SQL_SITES);
    expect(rawSqlCounts, `Raw-sql encoding changed.${SPLIT_BRAIN_EXPLANATION}`).toEqual(AUDITED_RAW_SQL_SITES);
  });

  it("the raw-sql encoding is audited by FILE INVENTORY, not assumed absent", () => {
    /*
    This case exists as a headstone. It was originally written the other way round — asserting that NO
    raw `sql` template compares a column to 'archived', on the assumption that the gate had only two
    encodings. It failed on the first run with five files.

    Kept as an assertion that the inventory is non-empty, because the useful invariant turned out to be
    the opposite of the one I set out to write: the third encoding EXISTS, is unavoidable for now, and
    must be counted. An assertion of absence here would have to be deleted by whoever added the next
    raw template, and deleting a red guard is how a class of sites stops being tracked.
    */
    expect(Object.keys(AUDITED_RAW_SQL_SITES).length).toBeGreaterThan(0);
    /*
    FNXC:WorkflowResolvedColumns 2026-07-31-16:45: 8 -> 5, tracking the two deliberate conversions
    recorded at the inventory above (#3046's mission-store pair, #3042's dead-export deletion). The
    number is re-recorded rather than loosened to `toBeLessThanOrEqual`: a fixed total is what makes
    a raw template ARRIVING as visible as one leaving, and this guard exists because arrivals are the
    ones nothing else counts.
    */
    expect(Object.values(AUDITED_RAW_SQL_SITES).reduce((a, b) => a + b, 0)).toBe(5);
  });
});
