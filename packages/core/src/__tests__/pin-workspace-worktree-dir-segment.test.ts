import { beforeEach, describe, expect, it, vi } from "vitest";

const { readTaskRowInTransaction } = vi.hoisted(() => ({
  readTaskRowInTransaction: vi.fn(),
}));

vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-persistence.js")>()),
  readTaskRowInTransaction,
}));

import { pinWorkspaceWorktreeDirSegmentImpl } from "../task-store/task-mutation-ops.js";
import { projectOwnershipPartition } from "../postgres/data-layer.js";

/*
FNXC:WorkspaceWorktree 2026-09-04-04:59:
The pin writer must target the same (project_id, id) row that `readTaskRowInTransaction` locked.
`taskProjectScope` is a no-op on unbound layers, so this test drives the shipped function and
asserts the UPDATE predicate — not source text — for both unbound and bound stores.
*/

function collectSqlValues(node: unknown, into: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (node == null || seen.has(node)) return into;
  if (typeof node !== "object") {
    into.push(node);
    return into;
  }
  seen.add(node);
  const record = node as { value?: unknown; queryChunks?: unknown[] };
  if ("value" in record) into.push(record.value);
  for (const chunk of record.queryChunks ?? []) collectSqlValues(chunk, into, seen);
  return into;
}

function createPinStore(projectId: string | undefined) {
  const whereClauses: unknown[] = [];
  const updatedRow = {
    id: "FN-3520",
    projectId: projectOwnershipPartition(projectId),
    workspaceWorktreeDirSegment: "prd-1234-my-slug",
    deletedAt: null,
  };
  const tx = {
    execute: vi.fn().mockResolvedValue(undefined),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn((clause: unknown) => {
          whereClauses.push(clause);
          return { returning: vi.fn(async () => [updatedRow]) };
        }),
      })),
    })),
  };
  const store = {
    withTaskLock: async (_id: string, work: () => Promise<unknown>) => work(),
    asyncLayer: {
      projectId,
      transactionImmediate: async (work: (value: typeof tx) => Promise<unknown>) => work(tx),
    },
    rowToTask: (row: unknown) => row,
    pgRowToTaskRow: (row: unknown) => row,
    writeTaskJsonFile: vi.fn().mockResolvedValue(undefined),
    isWatching: false,
    taskCache: new Map(),
    emitTaskLifecycleEventSafely: vi.fn(),
    taskDir: () => "/tmp/fn-3520",
  };
  return { store, whereClauses, updatedRow };
}

describe("pinWorkspaceWorktreeDirSegmentImpl project scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readTaskRowInTransaction.mockResolvedValue({
      id: "FN-3520",
      deletedAt: null,
      workspaceWorktreeDirSegment: null,
    });
  });

  it("scopes an unbound pin to the legacy partition instead of every same-id row", async () => {
    const { store, whereClauses } = createPinStore(undefined);
    const result = await pinWorkspaceWorktreeDirSegmentImpl(store as never, "FN-3520", "prd-1234-my-slug");
    expect(result.minted).toBe(true);
    expect(result.claimed).toBe(true);
    expect(whereClauses).toHaveLength(1);
    expect(collectSqlValues(whereClauses[0])).toEqual(expect.arrayContaining([
      "FN-3520",
      "__legacy_unscoped__",
    ]));
    expect(collectSqlValues(whereClauses[0])).not.toContain("");
  });

  it("keeps a bound pin on the layer's project id", async () => {
    const { store, whereClauses } = createPinStore("proj-alpha");
    await pinWorkspaceWorktreeDirSegmentImpl(store as never, "FN-3520", "prd-1234-my-slug");
    expect(collectSqlValues(whereClauses[0])).toEqual(expect.arrayContaining([
      "FN-3520",
      "proj-alpha",
    ]));
    expect(collectSqlValues(whereClauses[0])).not.toContain("__legacy_unscoped__");
  });
});
