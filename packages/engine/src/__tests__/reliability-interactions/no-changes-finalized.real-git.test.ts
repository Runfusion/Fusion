// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { describe, it, expect, vi } from "vitest";
import { classifyOwnedLandedEvidence } from "../../merger.js";
// FNXC:SqliteRemoval 2026-07-14: hasPg guard added — makeReliabilityFixture requires PG after SQLite removal (VAL-REMOVAL-005).
import { makeReliabilityFixture, hasGit, hasPg } from "./_helpers.js";

describe("no-changes-finalized reliability interactions (real git)", () => {
  it.skipIf(!hasGit || !hasPg)("reconciles verification-only done task without unproven warning", async () => {
    const fixture = await makeReliabilityFixture({
      taskId: "FN-4701-RI",
      task: {
        column: "done",
        branch: undefined,
        baseCommitSha: undefined,
        mergeDetails: {},
        modifiedFiles: ["docs/some-note.md"],
      },
    });

    const { rootDir, task, store } = fixture;
    await store.moveTask(task.id, "done");
    await store.updateTask(task.id, {
      branch: undefined,
      baseCommitSha: undefined,
      mergeDetails: {},
      modifiedFiles: ["docs/some-note.md"],
    });
    const seededTask = (await store.getTask(task.id))!;

    const logSpy = vi.spyOn(store, "logEntry");
    const updateSpy = vi.spyOn(store, "updateTask");
    const auditSpy = vi.spyOn(store, "recordRunAuditEvent");

    try {
      const classification = await classifyOwnedLandedEvidence(rootDir, seededTask, { mergeTargetBranch: "main" });
      expect(classification.kind).toBe("no-changes-finalized");
      expect(classification).toMatchObject({
        baseRef: "main",
        details: {
          branchExists: false,
          aheadCount: null,
          baseReachableFromTarget: false,
        },
      });

      const reconciled = await fixture.selfHeal.reconcileDoneTaskIntegrity();
      expect(reconciled).toBeGreaterThanOrEqual(1);

      const taskLogCalls = logSpy.mock.calls.filter((call) => call[0] === seededTask.id);
      expect(taskLogCalls.some((call) => /done-task finalize evidence is unproven/.test(String(call[1] ?? "")))).toBe(false);

      expect(updateSpy).toHaveBeenCalledWith(seededTask.id, expect.objectContaining({
        modifiedFiles: [],
        mergeDetails: expect.objectContaining({
          mergeConfirmed: true,
          noOpMerge: true,
          noOpReason: "verification-only finalize: no branch and no owned commits",
          landedFiles: [],
        }),
      }));

      expect(
        auditSpy.mock.calls.some(([event]) =>
          (event as any)?.mutationType === "task:integrity-reconcile-modified-files" &&
          (event as any)?.metadata?.reason === "verification-only-finalize"
        ),
      ).toBe(true);

      const finalizeWarned = (fixture.manager as unknown as { finalizeUnprovenWarned: Set<string> }).finalizeUnprovenWarned;
      expect(finalizeWarned.has(seededTask.id)).toBe(false);

      await fixture.selfHeal.reconcileDoneTaskIntegrity();
      const taskLogCallsAfterSecondRun = logSpy.mock.calls.filter((call) => call[0] === seededTask.id);
      expect(
        taskLogCallsAfterSecondRun.some((call) => /done-task finalize evidence is unproven/.test(String(call[1] ?? ""))),
      ).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
