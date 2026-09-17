/*
FNXC:TaskSearchPagination 2026-09-17-08:46:
FN-497 symptom proof without a database. The header task search must present the newest match first,
and that promise is only true when BOTH the ORDER BY and the keyset continuation predicate are
descending: inverting one alone silently skips or repeats rows. These cases render the SQL produced by
the two exported helpers and pin the pair, plus a construction guard proving board table pagination
(the no-query branch) stays ascending.
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { buildTaskSearchPageCursorPredicate, buildTaskSearchPageOrder } from "../reads.js";

const dialect = new PgDialect();
const render = (expression: SQL | unknown): string => dialect.sqlToQuery(expression as SQL).sql.toLowerCase();

const readsSource = readFileSync(
  fileURLToPath(new URL("../reads.ts", import.meta.url)),
  "utf8",
);

describe("task search page order", () => {
  it("orders the search page by creation then id, both descending", () => {
    const order = buildTaskSearchPageOrder();
    expect(order).toHaveLength(2);

    const [createdAtOrder, idOrder] = order.map((element) => render(element));
    expect(createdAtOrder).toContain("created_at");
    expect(createdAtOrder).toContain("desc");
    expect(createdAtOrder).not.toContain("asc");
    expect(idOrder).toContain("id");
    expect(idOrder).toContain("desc");
    expect(idOrder).not.toContain("asc");
  });

  it("continues the search page with an exclusive, strictly descending keyset predicate", () => {
    const sql = render(buildTaskSearchPageCursorPredicate({
      createdAt: "2026-09-10T00:00:00.000Z",
      id: "FN-10",
    }));

    // Exactly two exclusive comparisons: one on created_at, one on the id tie-break.
    expect(sql.split("<").length - 1).toBe(2);
    expect(sql).toMatch(/created_at"?\s*</);
    expect(sql).toMatch(/id"?\s*</);
    expect(sql).toMatch(/created_at"?\s*=/);
    // A single ">" anywhere would reopen the ascending pagination hole this task closes.
    expect(sql).not.toContain(">");
  });

  it("omits the continuation predicate entirely for the first search page", () => {
    expect(buildTaskSearchPageCursorPredicate(undefined)).toBeUndefined();
  });

  it("keeps board table pagination ascending and free of the search page order", () => {
    // Construction guard (call-site allowlist), not a prose assertion: the no-query branch must keep
    // its ascending listTasks contract and must never adopt the descending search helpers.
    const noQueryBranch = readsSource.slice(readsSource.indexOf("const completeColumns"));
    expect(noQueryBranch).toContain('sort: "created-asc"');
    expect(noQueryBranch).toContain("afterCreatedAt: cursor?.createdAt");
    expect(noQueryBranch).toContain("afterId: cursor?.id");
    expect(noQueryBranch).not.toContain("buildTaskSearchPageOrder");
    expect(noQueryBranch).not.toContain("buildTaskSearchPageCursorPredicate");
  });
});
