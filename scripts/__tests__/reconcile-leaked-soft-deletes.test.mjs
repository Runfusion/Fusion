/*
FNXC:PostgresCutover 2026-07-05-13:00:
The script now targets the PostgreSQL backend; its planning logic is pure
(planReconcileLeakedSoftDeletes), so this test drives it with plain row arrays
instead of seeding a SQLite fixture. The thin PG apply step is exercised by
running the script against a live backend, not here.
*/
import test from "node:test";
import assert from "node:assert/strict";

import { planReconcileLeakedSoftDeletes, formatSummary } from "../reconcile-leaked-soft-deletes.mjs";

const ROWS = [
  {
    id: "FN-5130",
    column: "in-review",
    status: "failed",
    deletedAt: "2026-05-19T00:00:00.000Z",
  },
  {
    id: "FN-5133",
    column: "todo",
    status: null,
    deletedAt: "2026-05-19T01:00:00.000Z",
  },
  {
    id: "FN-5167",
    column: "archived",
    status: null,
    deletedAt: "2026-05-19T02:00:00.000Z",
  },
  { id: "FN-5200", column: "todo", status: null, deletedAt: null },
];

test("plans reconcile for leaked soft-deletes only", () => {
  const summary = planReconcileLeakedSoftDeletes(ROWS, { runId: "synthetic-reconcile-fn-5175-test" });

  assert.equal(summary.rowsScanned, 4);
  assert.equal(summary.runId, "synthetic-reconcile-fn-5175-test");
  assert.deepEqual(
    summary.findings.map((row) => row.id),
    ["FN-5130", "FN-5133"],
  );
  assert.deepEqual(summary.findings[0], {
    id: "FN-5130",
    column: "in-review",
    status: "failed",
    deletedAt: "2026-05-19T00:00:00.000Z",
  });
  assert.deepEqual(summary.findings[1], {
    id: "FN-5133",
    column: "todo",
    status: null,
    deletedAt: "2026-05-19T01:00:00.000Z",
  });
});

test("is idempotent once rows land in archived", () => {
  const repaired = ROWS.map((row) =>
    row.deletedAt != null ? { ...row, column: "archived" } : row,
  );
  const summary = planReconcileLeakedSoftDeletes(repaired, { runId: "synthetic-reconcile-fn-5175-test-2" });
  assert.equal(summary.findings.length, 0);
  assert.equal(summary.rowsUpdated, 0);
  assert.equal(summary.auditRowsInserted, 0);
});

test("formatSummary renders dry-run and apply headers", () => {
  const summary = planReconcileLeakedSoftDeletes(ROWS, { runId: "r" });
  assert.match(formatSummary(summary, true), /^Mode: DRY RUN/);
  assert.match(formatSummary(summary, false), /^Mode: APPLY/);
  assert.match(formatSummary(summary, true), /FN-5130\tin-review\tfailed/);
});

/*
FNXC:OperatorScriptLaneAssumptions 2026-07-30-23:50:
THE INVARIANT: "leaked" is measured against the board's OWN archived lanes, not the string "archived".

Keyed on the literal, a soft-deleted row resting correctly in a renamed archived lane (`binned`) is
reported as leaked — and under `--apply` the repair then rewrites it, which is the damage rather than
the fix. The mirror case matters just as much: a genuinely leaked row must still be caught on that
same board.

Reverted, the first case reports `FN-A` as leaked and the third stops seeing the legacy board's leak.
*/
test("a soft-deleted row already in the board's RENAMED archived lane is not leaked", () => {
  const rows = [{ id: "FN-A", column: "binned", status: null, deletedAt: "2026-01-01T00:00:00.000Z" }];

  const summary = planReconcileLeakedSoftDeletes(rows, { runId: "r", archivedLanes: new Set(["binned"]) });

  assert.deepEqual(summary.findings, []);
});

test("a soft-deleted row loose in a working lane IS leaked on that same renamed board", () => {
  const rows = [{ id: "FN-B", column: "building", status: null, deletedAt: "2026-01-01T00:00:00.000Z" }];

  const summary = planReconcileLeakedSoftDeletes(rows, { runId: "r", archivedLanes: new Set(["binned"]) });

  assert.deepEqual(summary.findings.map((row) => row.id), ["FN-B"]);
});

test("unresolved lanes keep exactly the legacy meaning of leaked", () => {
  const rows = [
    { id: "FN-C", column: "archived", status: null, deletedAt: "2026-01-01T00:00:00.000Z" },
    { id: "FN-D", column: "todo", status: null, deletedAt: "2026-01-01T00:00:00.000Z" },
  ];

  const summary = planReconcileLeakedSoftDeletes(rows, { runId: "r" });

  assert.deepEqual(summary.findings.map((row) => row.id), ["FN-D"]);
});

test("a board with several archived lanes treats all of them as resting places", () => {
  const rows = [
    { id: "FN-E", column: "binned", status: null, deletedAt: "2026-01-01T00:00:00.000Z" },
    { id: "FN-F", column: "archived", status: null, deletedAt: "2026-01-01T00:00:00.000Z" },
    { id: "FN-G", column: "building", status: null, deletedAt: "2026-01-01T00:00:00.000Z" },
  ];

  const summary = planReconcileLeakedSoftDeletes(rows, {
    runId: "r",
    archivedLanes: new Set(["binned", "archived"]),
  });

  assert.deepEqual(summary.findings.map((row) => row.id), ["FN-G"]);
});
