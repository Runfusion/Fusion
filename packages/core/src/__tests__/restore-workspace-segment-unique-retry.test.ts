import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { readTaskRowInTransaction } = vi.hoisted(() => ({
  readTaskRowInTransaction: vi.fn(),
}));

vi.mock("../task-store/async/async-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../task-store/async/async-persistence.js")>()),
  readTaskRowInTransaction,
}));

import { restoreTaskFromArchive } from "../task-store/async/async-archive-lineage.js";
import type { ArchivedTaskEntry } from "../types.js";

/*
FNXC:WorkspaceWorktree 2026-09-04-06:15:
A successor can pin the released name after restore's live-claim lookup. Unique_violation must
not abort unarchive: retry the restore with the segment forced null.
*/

function uniqueFailure(): Error {
  return new Error("Failed query: update workspace_worktree_dir_segment", {
    cause: Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
  });
}

function createRestoreTx(onSet: (values: { workspaceWorktreeDirSegment: string | null }) => Promise<void>) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
        }),
      }),
    }),
    update: () => ({
      set: (values: { workspaceWorktreeDirSegment: string | null }) => ({
        where: async () => onSet(values),
      }),
    }),
    delete: () => ({
      where: async () => undefined,
    }),
  };
}

describe("restoreTaskFromArchive unique claim race", () => {
  let surviving = "";

  beforeAll(() => {
    surviving = mkdtempSync(join(tmpdir(), "fn-3520-restore-"));
  });
  afterAll(() => {
    rmSync(surviving, { recursive: true, force: true });
  });

  it("retries without the pin when the unique index races a successor", async () => {
    readTaskRowInTransaction.mockResolvedValue({
      id: "FN-1",
      workspaceWorktreeDirSegment: "foo",
      workspaceWorktrees: { "repo-a": { worktreePath: surviving, branch: "fusion/a" } },
      worktree: null,
    });
    const segments: Array<string | null> = [];
    let attempts = 0;
    const layer = {
      projectId: "proj-restore-race",
      transactionImmediate: async (work: (tx: ReturnType<typeof createRestoreTx>) => Promise<void>) => {
        attempts += 1;
        await work(createRestoreTx(async (values) => {
          segments.push(values.workspaceWorktreeDirSegment);
          if (attempts === 1) throw uniqueFailure();
        }));
      },
    };

    await restoreTaskFromArchive(layer as never, { id: "FN-1" } as ArchivedTaskEntry);

    expect(attempts).toBe(2);
    expect(segments).toEqual(["foo", null]);
  });
});
