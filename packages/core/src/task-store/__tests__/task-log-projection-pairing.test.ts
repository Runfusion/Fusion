/*
FNXC:TaskLogProjections 2026-10-10-20:01 (RUFU-615):
THE WRITE PAIRING GUARD.

`tasks.timing_total_ms` and `tasks.log_recent` answer for `tasks.log` on every read that does not load
it — that is what lets a board refresh drop a 31 MB column. The columns are only trustworthy if NO SQL
statement can write `log` without writing its two projections in the same statement: a half-written
pair is a card whose badge silently disagrees with the history it came from, and nothing at runtime
would notice, because the reader cannot tell a fresh envelope from a stale one.

The full-row path gets this for free from the column descriptors in `persistence.ts`. The targeted
`UPDATE`s that bypass the descriptors must call `withTaskLogProjections(...)`, and this scan is what
keeps a future `tx.update(tasks).set({ log })` from being merged.

This asserts a CODE CONSTRUCT, not prose: it names the call site and refuses a statement shape, which
is what makes it a guard rather than a documentation test.
*/

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/core/src` — the file lives at `src/task-store/__tests__/`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** The packages that can author SQL against `project.tasks`. */
const SCAN_ROOTS = [".", "../../engine/src"].map((p) => join(PACKAGE_ROOT, p));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "__tests__" || name.endsWith(".test.ts") || name.endsWith(".pg.test.ts")) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...sourceFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * The statement text of every `... .update(tasks) ... .set(<object>)` call — the balanced-bracket slice
 * after `.set(`, which is the only place a column can be named. Comments are stripped so an FNXC note
 * that MENTIONS `set({ log })` cannot be mistaken for one.
 */
function taskUpdateStatements(src: string): string[] {
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const statements: Array<{ text: string; before: string }> = [];
  /*
  The table binding is reached as `tasks`, `tasksTable`, or `schema.project.tasks`, so the qualifier is
  optional. Requiring the final segment to BE `tasks*` keeps a `.update(otherTable)` out of the scan.
  */
  const re = /\.update\(\s*(?:[A-Za-z_$][\w$]*\.)*tasks[a-zA-Z_$]*\s*\)([\s\S]{0,4000}?)\.set\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < stripped.length && depth > 0) {
      const ch = stripped[i]!;
      if (ch === "(" || ch === "{" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
      i += 1;
    }
    /*
    `before` is the text that precedes THIS call, bounded to the record-building window a caller would
    plausibly write in. The bare-`values` shape below needs it: a file-scoped search would blame every
    `.set(values)` in the module for the one record that carries a log.
    */
    statements.push({ text: stripped.slice(start, i - 1), before: stripped.slice(Math.max(0, m.index - 3_000), m.index) });
  }
  return statements;
}

describe("the log write seam always writes its projections", () => {
  const offenders: string[] = [];
  const covered: string[] = [];

  for (const root of SCAN_ROOTS) {
    for (const file of sourceFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes(".update(")) continue;
      for (const { text: statement, before } of taskUpdateStatements(src)) {
        // `log` is written when it appears as an object key or a shorthand property, and only there —
        // `stallLog:` or `task.log` inside an expression is not the column.
        let writesLog = /(^|[{,\s])log\s*[:,]/.test(statement);
        /*
        A `.set(values)` that passes a locally-built record is the shape a literal scan cannot see, and
        `updateTaskAtomic` builds exactly one — `values.log = log` under an `if`. So a bare-identifier
        argument counts as a log write when the record is given a `log` AFTER its own declaration and
        before this call. Bounding at the declaration matters: three sibling functions in this module
        each build their own `const values`, and a file- or window-scoped search blames all of them for
        the one that carries a log — a guard with that false-positive rate gets switched off.
        */
        const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(statement);
        if (bare && !writesLog) {
          const name = bare[1]!;
          const declarations = [...before.matchAll(new RegExp(`\\b(?:const|let)\\s+${name}\\b`, "g"))];
          const ownRecord = declarations.length
            ? before.slice(declarations[declarations.length - 1]!.index)
            : before;
          writesLog = new RegExp(`\\b${name}\\.\\s*log\\s*=`).test(ownRecord);
        }
        if (!writesLog) continue;
        // Name the line, not just the file: three of these sites in one module are indistinguishable
        // otherwise, and the last time this guard fired the fix went to the wrong `.set(values)`.
        const at = src.indexOf(statement.slice(0, 40));
        const line = at >= 0 ? src.slice(0, at).split("\n").length : 0;
        const rel = `${relative(join(PACKAGE_ROOT, ".."), file)}:${line}`;
        if (statement.includes("withTaskLogProjections(")) covered.push(rel);
        else offenders.push(rel);
      }
    }
  }

  it("finds the raw task-log UPDATEs and every one of them derives the pair", () => {
    expect(
      offenders,
      `These statements write project.tasks.log without withTaskLogProjections(...), so ` +
      `timing_total_ms/log_recent go stale and a log-free read answers from the old envelope: ${offenders.join(", ")}`,
    ).toEqual([]);
    // The guard is only worth something if it still has subjects: a refactor that renamed the table
    // binding would silently empty the scan and report a clean board.
    expect(covered.length, "the scan found no wrapped task-log UPDATE at all — it has stopped matching").toBeGreaterThan(0);
  });

  it("keeps the two derived columns on the descriptor path that writes the full row", () => {
    const persistence = readFileSync(join(PACKAGE_ROOT, "task-store/persistence.ts"), "utf8");
    // Structural, not prose: the descriptors are the ONLY place a full-row write names these columns,
    // so a missing descriptor means an INSERT writes `log` with no projection at all.
    expect(persistence).toMatch(/defineTaskColumn\(\s*"timingTotalMs"/);
    expect(persistence).toMatch(/defineTaskColumn\(\s*"logRecent"/);
    expect(persistence).toMatch(/logRecent/);
  });

  it("ships the SQL counterpart the backfill and the equivalence proof both depend on", () => {
    const migration = readFileSync(
      join(PACKAGE_ROOT, "postgres/migrations/0092_rufu_615_task_log_projections.sql"),
      "utf8",
    );
    expect(migration).toContain("project.fusion_task_log_projections");
    expect(migration).toContain("timing_total_ms double precision");
    expect(migration).toContain("log_recent jsonb");
    /*
    `timing_total_ms` is `double precision`, never `bigint`: `computeTimedExecutionMs` sums fractional
    milliseconds, and an integer column would round the figure the board chip displays.
    */
    expect(migration).not.toMatch(/timing_total_ms\s+bigint/);
  });
});
