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
  "packages/core/src/async-mission-store-queries.ts": 2,
  "packages/core/src/async-mission-store.ts": 2,
  "packages/core/src/eval-signal-collector.ts": 1,
  "packages/core/src/live-agent-count.ts": 1,
  "packages/core/src/mission-store.ts": 1,
  "packages/core/src/store.ts": 1,
  "packages/core/src/task-merge.ts": 2,
  "packages/core/src/task-store/archive-lifecycle-2.ts": 2,
  "packages/core/src/task-store/async-comments-attachments.ts": 8,
  "packages/core/src/task-store/audit-ops.ts": 1,
  "packages/core/src/task-store/branch-and-pr-entities.ts": 1,
  "packages/core/src/task-store/lifecycle-ops.ts": 1,
  "packages/core/src/task-store/moves.ts": 1,
  "packages/core/src/task-store/symbol-locks.ts": 1,
  "packages/core/src/task-store/task-id-integrity.ts": 1,
  "packages/core/src/task-store/update-task-deps.ts": 1,
};

/**
 * Raw `sql` template comparisons — THE THIRD ENCODING, and the one this file was written expecting not
 * to exist. Invisible to the column census (not a comparison) and invisible to the Drizzle scan below
 * (not an `eq`/`ne` call), so before this inventory nothing in the repo counted them at all.
 */
const AUDITED_RAW_SQL_SITES: Readonly<Record<string, number>> = {
  "packages/core/src/async-mission-store-queries.ts": 1,
  "packages/core/src/async-mission-store.ts": 2,
  "packages/core/src/task-store/async-archive-lineage.ts": 3,
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
    expect(Object.values(AUDITED_RAW_SQL_SITES).reduce((a, b) => a + b, 0)).toBe(8);
  });
});
