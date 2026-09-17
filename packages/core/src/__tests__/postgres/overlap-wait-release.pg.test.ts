import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../../__test-utils__/pg-test-harness.js";
import { OVERLAP_DELIVERY_UNAVAILABLE_ERROR } from "../../tasks/overlap-wait-release.js";
import { __setResetPublicationFailureForTesting } from "../../task-store/reset-lifecycle.js";
import { reconcileReleasedOverlapWaits } from "../../../../engine/src/self-healing/released-overlap-waits.js";
import { dispatchUnpauseResume, type UnpauseResumeDeps } from "../../../../engine/src/executor/unpause-resume.js";
import { synchronizeOverlapWaitBeforeExecution } from "../../../../engine/src/executor/overlap-resume-gate.js";
import type { Task } from "../../types.js";
import type { WorkflowIrV2 } from "../../workflows/workflow-ir-types.js";
import { BUILTIN_STEPWISE_CODING_WORKFLOW_IR } from "../../workflows/builtin-stepwise-coding-workflow-ir.js";

/*
FNXC:OverlapWaitRelease 2026-09-17-06:38:
Symptom verification: observe a predecessor, discard its unlanded execution, clear the visible marker,
then persist the old synchronization failure. A fresh recovery invocation must cancel only that wait
and enter the ordinary executor resume path. All IDs come from fixtures, never the operator's board.
Surface enumeration: reset/delete/complete/missing; real deliveries and workspace repositories; new
wait generations; retained progress; repeated sweeps; pauses, human review, live work, foreign projects,
failed publication and racing owners. No live daemon or application database participates.
*/
const h = createSharedPgTaskStoreTestHarness({ prefix: "fusion_overlap_release", projectId: "overlap-release-project" });
const queue = (id: string) => ({ signature: `file-scope:${id}`, blockedBy: null, overlapBlockedBy: id, action: `queued behind ${id}` });

async function fixture() {
  const blocker = await h.store().createTask({ description: "Predecessor" });
  const waiting = await h.store().createTask({ description: "Waiting implementation" });
  await h.store().transitionQueuedEpisode(waiting.id, queue(blocker.id));
  // Seed a genuine failed WIP shape without invoking execution or lifecycle orchestration.
  await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='in-progress', status='failed', error=${OVERLAP_DELIVERY_UNAVAILABLE_ERROR},
    steps=${JSON.stringify([{ name: "Delivered step", status: "done" }, { name: "Next step", status: "pending" }])}::jsonb,
    worktree='/checkout/retained', branch='fusion/retained' WHERE id=${waiting.id}`);
  return { blocker, waiting };
}

async function finish(blocker: Task, disposition: "reset" | "deleted" | "complete" | "missing") {
  if (disposition === "reset") await h.store().resetTaskPublication(blocker.id, "todo");
  else if (disposition === "deleted") await h.store().deleteTask(blocker.id);
  else if (disposition === "missing") await h.layer().db.execute(sql`DELETE FROM project.tasks WHERE id=${blocker.id}`);
  else await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='done' WHERE id=${blocker.id}`);
}

pgDescribe("released predecessor overlap recovery", () => {
  beforeAll(h.beforeAll);
  afterEach(async () => { vi.restoreAllMocks(); await h.afterEach(); });
  afterAll(h.afterAll);

  it.each(["reset", "deleted", "complete", "missing"] as const)("recovers a persisted %s wait through the normal execution entry, once", async (disposition) => {
    const { blocker, waiting } = await fixture();
    await finish(blocker, disposition);
    await h.store().updateTask(waiting.id, { overlapBlockedBy: null });
    await h.store().updateSettings({ autoMerge: true, globalPause: false, enginePaused: false });
    const before = await h.store().getTask(waiting.id);
    const emitted: Task[] = [];
    const listener = (task: Task) => { if (task.id === waiting.id) emitted.push(task); };
    h.store().on("task:updated", listener);
    try {
      expect(await reconcileReleasedOverlapWaits(h.store(), () => false)).toBe(1);
      const after = await h.store().getTask(waiting.id);
      expect(after.status).toBeFalsy();
      expect(after.error).toBeFalsy();
      expect(after).toMatchObject({ column: before.column, steps: before.steps, worktree: before.worktree, branch: before.branch });
      expect((await h.store().listTaskOverlapWaits(waiting.id))[0]).toMatchObject({ phase: "cancelled", observation: { releaseReason: disposition } });
      expect(emitted).toHaveLength(1);
      expect(await reconcileReleasedOverlapWaits(h.store(), () => false)).toBe(0);
      // The executor's task:updated listener uses this real admission function. Exercise it rather
      // than declaring a cleared error equivalent to an actual restart of execution.
      const execute = vi.fn(async () => undefined);
      const deps: UnpauseResumeDeps = {
        store: h.store(), getRunContextFor: () => undefined, executing: new Set(), resumingUnpaused: new Set(), recoveringCompleted: new Set(),
        activeSessions: new Set(), activeStepExecutors: new Set(), activeWorkflowStepSessions: new Set(), graphRouting: new Set(), approvalSuspended: new Set(),
        getExecutionPauseLabel: async () => null, clearResumeFailureState: async () => undefined,
        recoverApprovedStepsOnResume: async () => undefined, recoverCompletedTask: vi.fn(), execute,
      };
      expect(await dispatchUnpauseResume(deps, emitted[0]!)).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      // No git/worktree operation may be necessary for a cancelled unlanded predecessor.
      await expect(synchronizeOverlapWaitBeforeExecution({ task: after, store: h.store(), owner: "new-process", worktreePath: "/must-not-be-accessed" }))
        .resolves.toEqual({ episodeIds: [] });
    } finally { h.store().off("task:updated", listener); }
  });

  it("repairs the pre-upgrade shape using a successful Reset log newer than observation", async () => {
    const { blocker, waiting } = await fixture();
    const episode = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='todo', log=${JSON.stringify([
      { action: "Reset replaced the original description (20 characters)", timestamp: new Date(Date.parse(episode.observedAt) + 1).toISOString() },
    ])}::jsonb WHERE id=${blocker.id}`);
    await h.store().updateTask(waiting.id, { overlapBlockedBy: null });
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ cancelledCount: 1, resumed: true });
  });

  it("does not equate a planning predecessor or an incomplete Reset cleanup with abandonment", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().logEntry(blocker.id, "Reset deleted task branches: fusion/old");
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toEqual({ cancelledCount: 0, clearedBlockerIds: [], resumed: false });
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.phase).toBe("observed");
  });

  it("Reset stamps incoming waits atomically and fences an already claimed owner", async () => {
    const { blocker, waiting } = await fixture();
    const episode = (await h.store().listTaskOverlapWaits(waiting.id))[0]!;
    const claim = await h.store().claimTaskOverlapWait({ taskId: waiting.id, episodeId: episode.episodeId, expectedRevision: episode.revision, owner: "old-process" });
    await h.store().resetTaskPublication(blocker.id, "todo");
    await expect(h.store().completeTaskOverlapWait({ taskId: waiting.id, episodeId: episode.episodeId, expectedRevision: claim!.revision, owner: "old-process",
      receipt: { decision: "resume", freshness: "proven", commonFiles: [], deliveryProofs: [], decisionFingerprint: "old", decidedAt: new Date().toISOString() },
    })).resolves.toBeNull();
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id)).toMatchObject({ cancelledCount: 1 });
  });

  it("a failed Reset does not release anyone waiting on it", async () => {
    const { blocker, waiting } = await fixture();
    const restore = __setResetPublicationFailureForTesting(() => { throw new Error("publication refused"); });
    try { await expect(h.store().resetTaskPublication(blocker.id, "todo")).rejects.toThrow("publication refused"); }
    finally { restore(); }
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id)).toMatchObject({ cancelledCount: 0 });
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.observation?.blockerResetAt).toBeUndefined();
  });

  it.each(["reset", "deleted", "complete", "missing"] as const)("preserves a captured delivery after %s, but removes the stale card indicator", async (disposition) => {
    const { blocker, waiting } = await fixture();
    await h.store().publishTaskOverlapDeliveries(blocker.id, [{ blockerTaskId: blocker.id, repository: ".", landedSha: "actual-delivery", paths: [{ repository: ".", path: "shared.ts", status: "modified" }], evidence: "merge-details" }]);
    await finish(blocker, disposition);
    const result = await h.store().reconcileTaskOverlapWaits(waiting.id);
    expect(result).toMatchObject({ cancelledCount: 0, clearedBlockerIds: [blocker.id] });
    expect((await h.store().getTask(waiting.id)).overlapBlockedBy).toBeFalsy();
    expect((await h.store().listTaskOverlapWaits(waiting.id, { pendingOnly: true }))[0]?.observation?.deliveries).toEqual([
      expect.objectContaining({ landedSha: "actual-delivery" }),
    ]);
  });

  it("snapshots predecessor delivery metadata before Reset discards it", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().updateTask(blocker.id, { mergeDetails: { workspaceLandedShas: { "repo-a": "sha-a" }, workspaceLandedFiles: { "repo-a": ["shared.ts"], "repo-b": [] } } });
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().reconcileTaskOverlapWaits(waiting.id);
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.observation?.deliveries).toEqual([
      expect.objectContaining({ repository: "repo-a", landedSha: "sha-a" }),
      expect.objectContaining({ repository: "repo-b", paths: [], noOp: true }),
    ]);
  });

  it("does not substitute a later completed execution for an abandoned predecessor", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().updateTask(blocker.id, { mergeDetails: { commitSha: "new-execution", landedFiles: ["different.ts"] } });
    await finish(blocker, "complete");
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id)).toMatchObject({ cancelledCount: 1 });
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]).toMatchObject({ phase: "cancelled", observation: { releaseReason: "reset" } });
  });

  it("does not overwrite a captured commit with a later no-op snapshot at Reset", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().publishTaskOverlapDeliveries(blocker.id, [{ blockerTaskId: blocker.id, repository: ".", landedSha: "retained-sha", evidence: "merge-details" }]);
    await h.store().updateTask(blocker.id, { mergeDetails: { noOpMerge: true, landedFiles: [] } });
    await h.store().resetTaskPublication(blocker.id, "todo");
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.observation?.deliveries).toEqual([expect.objectContaining({ landedSha: "retained-sha" })]);
  });

  it("retains legacy receipt-only delivery proof instead of cancelling or inventing attribution", async () => {
    const { blocker, waiting } = await fixture();
    const receipt = { decision: "briefing", freshness: "pending", commonFiles: ["shared.ts"], deliveryProofs: [{ repository: ".", landedSha: "retained-sha", landedFiles: ["shared.ts"] }], decisionFingerprint: "legacy", decidedAt: new Date().toISOString() };
    await h.layer().db.execute(sql`UPDATE project.task_overlap_waits SET phase='freshness-pending', receipt=${JSON.stringify(receipt)}::jsonb WHERE task_id=${waiting.id}`);
    await h.store().resetTaskPublication(blocker.id, "todo");
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ cancelledCount: 0, resumed: false });
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]).toMatchObject({ phase: "freshness-pending", receipt });
  });

  it("does not erase a new active wait behind the same task after a previous Reset", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().reconcileTaskOverlapWaits(waiting.id);
    await h.store().transitionQueuedEpisode(waiting.id, queue(blocker.id));
    const pending = await h.store().listTaskOverlapWaits(waiting.id, { pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.observation?.blockerResetAt).toBeUndefined();
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id)).toMatchObject({ cancelledCount: 0, clearedBlockerIds: [] });
    expect((await h.store().getTask(waiting.id)).overlapBlockedBy).toBe(blocker.id);
  });

  it("re-arms an actual new lease before recovery consumes the predecessor's Reset stamp", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().updateTask(waiting.id, { error: OVERLAP_DELIVERY_UNAVAILABLE_ERROR });
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.observation?.blockerResetAt).toBeTruthy();
    await h.store().transitionQueuedEpisode(waiting.id, queue(blocker.id));
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.observation?.blockerResetAt).toBeUndefined();
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id)).toMatchObject({ cancelledCount: 0, clearedBlockerIds: [] });
    expect((await h.store().getTask(waiting.id)).overlapBlockedBy).toBe(blocker.id);
  });

  it("reconciles Reset at execution entry without depending on a maintenance pass", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await expect(synchronizeOverlapWaitBeforeExecution({ task: await h.store().getTask(waiting.id), store: h.store(), owner: "new-execution", worktreePath: "/not-a-worktree" }))
      .resolves.toEqual({ episodeIds: [] });
    expect((await h.store().listTaskOverlapWaits(waiting.id))[0]?.phase).toBe("cancelled");
  });

  it("one retired predecessor does not authorize resuming behind another live, unlanded predecessor", async () => {
    const { blocker, waiting } = await fixture();
    const live = await h.store().createTask({ description: "Still working" });
    await h.store().transitionQueuedEpisode(waiting.id, queue(live.id));
    await h.store().updateTask(waiting.id, { status: "failed", error: OVERLAP_DELIVERY_UNAVAILABLE_ERROR });
    await h.store().resetTaskPublication(blocker.id, "todo");
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ cancelledCount: 1, resumed: false, clearedBlockerIds: [] });
    expect((await h.store().getTask(waiting.id)).overlapBlockedBy).toBe(live.id);
  });

  it("preserves an explicit dependency on a Reset predecessor", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().updateTask(waiting.id, { dependencies: [blocker.id], blockedBy: blocker.id });
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().reconcileTaskOverlapWaits(waiting.id);
    expect(await h.store().getTask(waiting.id)).toMatchObject({ dependencies: [blocker.id], blockedBy: blocker.id });
  });

  it.each([{ paused: true }, { userPaused: true }, { error: "unrelated failure" }])("does not resume a protected or unrelated failure: %j", async (patch) => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    if ("userPaused" in patch) await h.layer().db.execute(sql`UPDATE project.tasks SET user_paused=1 WHERE id=${waiting.id}`);
    else await h.store().updateTask(waiting.id, patch);
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ resumed: false });
    expect((await h.store().getTask(waiting.id)).status).toBe("failed");
  });

  it.each(["globalPause", "enginePaused", "autoMergeOff", "taskAutoMergeOff", "live", "checkout"] as const)("recovery honors %s", async (guard) => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().updateSettings({ globalPause: guard === "globalPause", enginePaused: guard === "enginePaused", autoMerge: guard !== "autoMergeOff" });
    if (guard === "taskAutoMergeOff") await h.store().updateTask(waiting.id, { autoMerge: false });
    if (guard === "checkout") await h.layer().db.execute(sql`UPDATE project.tasks SET checked_out_by='foreign-owner' WHERE id=${waiting.id}`);
    await reconcileReleasedOverlapWaits(h.store(), () => guard === "live");
    expect((await h.store().getTask(waiting.id)).status).toBe("failed");
  });

  it("uses each task's own renamed lifecycle columns, not the default workflow's", async () => {
    const ir = structuredClone(BUILTIN_STEPWISE_CODING_WORKFLOW_IR) as WorkflowIrV2;
    const rename: Record<string, string> = { "in-progress": "building", done: "shipped" };
    for (const column of ir.columns) column.id = rename[column.id] ?? column.id;
    for (const node of ir.nodes) if (node.column) node.column = rename[node.column] ?? node.column;
    const workflow = await h.store().createWorkflowDefinition({ name: "Renamed overlap recovery", ir });
    const { blocker, waiting } = await fixture();
    await h.store().writeTaskWorkflowSelection(blocker.id, workflow.id, []);
    await h.store().writeTaskWorkflowSelection(waiting.id, workflow.id, []);
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='shipped' WHERE id=${blocker.id}`);
    await h.layer().db.execute(sql`UPDATE project.tasks SET "column"='building' WHERE id=${waiting.id}`);
    await h.store().updateSettings({ autoMerge: true });
    expect(await reconcileReleasedOverlapWaits(h.store(), () => false)).toBe(1);
    expect(await h.store().getTask(waiting.id)).toMatchObject({ column: "building" });
    expect((await h.store().getTask(waiting.id)).error).toBeFalsy();
  });

  it("does not read or mutate a foreign project's same-ID tasks or wait episodes", async () => {
    const { blocker, waiting } = await fixture();
    await h.layer().db.execute(sql`INSERT INTO project.tasks (project_id,id,description,"column",created_at,updated_at) VALUES
      ('foreign-overlap-project',${blocker.id},'Foreign predecessor','done',now(),now()),
      ('foreign-overlap-project',${waiting.id},'Foreign waiter','in-progress',now(),now())`);
    await h.layer().db.execute(sql`INSERT INTO project.task_overlap_waits (project_id,task_id,blocker_task_id,observed_at,updated_at)
      VALUES ('foreign-overlap-project',${waiting.id},${blocker.id},now(),now())`);
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ cancelledCount: 0, resumed: false });
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().reconcileTaskOverlapWaits(waiting.id);
    const foreign = await h.layer().db.execute(sql`SELECT phase,observation,revision FROM project.task_overlap_waits WHERE project_id='foreign-overlap-project'`);
    expect(foreign).toEqual([expect.objectContaining({ phase: "observed", observation: {}, revision: 1 })]);
  });

  it("does not loop on unavailable attributed files without a recapturable commit", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().publishTaskOverlapDeliveries(blocker.id, [{ blockerTaskId: blocker.id, repository: ".", paths: [], evidence: "unavailable" }]);
    await finish(blocker, "complete");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ cancelledCount: 0, resumed: false });
    }
  });

  it("also recovers a synchronization owner superseded by a concurrent Reset", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().updateTask(waiting.id, { error: "Overlap synchronization episode old-episode changed before publication" });
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ resumed: true });
  });

  it("preserves a live continuation, even when the task row still says failed", async () => {
    const { blocker, waiting } = await fixture();
    await h.store().resetTaskPublication(blocker.id, "todo");
    await h.store().replaceActiveTaskWorkflowContinuation({ taskId: waiting.id, runId: "live", nodeId: "execute", kind: "task", state: "running" });
    expect(await h.store().reconcileTaskOverlapWaits(waiting.id, { resumeIf: () => true })).toMatchObject({ resumed: false });
  });
});
