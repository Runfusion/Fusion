/*
FNXC:ApprovalRedemption 2026-07-26-17:45:
Regression cover for the approval-reuse outage: `findLatestByDedupeKey` read
`targetContext` through a string-only JSON parse, so in PostgreSQL backend mode —
where Drizzle hands back an ALREADY-PARSED jsonb object — the dedupe scan never
matched. Every gate retry minted a duplicate approval request and an approved
grant could never be redeemed. The live database showed the signature clearly:
17 approved requests, 0 completed.

The invariant under test is shape-independence, not one reproduction: the SAME
stored dedupe key must resolve whether the row arrives as a JSON STRING (SQLite)
or as a PARSED OBJECT (Postgres jsonb). Both directions are asserted here, plus
the non-matching and absent-context cases, so a future change that silently
handles only one shape fails.

The store's constructor takes an injectable `Database`, so this drives the real
public `findLatestByDedupeKey` through a fake prepare/all seam — no database, no
network, no timers.
*/
import { describe, expect, it } from "vitest";
import { ApprovalRequestStore } from "../approval-request-store.js";

type Row = Record<string, unknown>;

function makeRow(targetContext: unknown): Row {
  return {
    id: "apr-1",
    status: "approved",
    requesterActorId: "agent-7",
    requesterActorType: "agent",
    requesterActorName: "Executor",
    targetActionCategory: "command_execution",
    targetActionOperation: "shell command",
    targetActionSummary: "run a command",
    targetResourceType: "shell",
    targetResourceId: "",
    targetContext,
    taskId: "FN-1",
    runId: "run-1",
    requestedAt: "2026-07-26T00:00:00.000Z",
    decidedAt: null,
    completedAt: null,
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
  };
}

/** Minimal sync-Database stand-in: every prepare().all() returns the given rows. */
function fakeDb(rows: Row[]) {
  return {
    prepare: () => ({ all: () => rows }),
  } as never;
}

function findKey(rows: Row[], dedupeKey: string) {
  const store = new ApprovalRequestStore(fakeDb(rows));
  return store.findLatestByDedupeKey({
    requesterActorId: "agent-7",
    taskId: "FN-1",
    dedupeKey,
  });
}

describe("findLatestByDedupeKey targetContext shape handling", () => {
  it("matches when the row stores context as a JSON string (SQLite shape)", async () => {
    const rows = [makeRow(JSON.stringify({ approvalDedupeKey: "key-abc" }))];
    await expect(findKey(rows, "key-abc")).resolves.toMatchObject({ id: "apr-1" });
  });

  it("matches when the row stores context as a parsed object (Postgres jsonb shape)", async () => {
    // The regression: this row previously fell through the string-only parse and never matched.
    const rows = [makeRow({ approvalDedupeKey: "key-abc" })];
    await expect(findKey(rows, "key-abc")).resolves.toMatchObject({ id: "apr-1" });
  });

  it("does not match a different dedupe key in either shape", async () => {
    await expect(findKey([makeRow(JSON.stringify({ approvalDedupeKey: "other" }))], "key-abc")).resolves.toBeNull();
    await expect(findKey([makeRow({ approvalDedupeKey: "other" })], "key-abc")).resolves.toBeNull();
  });

  it("does not match when the row has no context at all", async () => {
    await expect(findKey([makeRow(null)], "key-abc")).resolves.toBeNull();
  });
});
