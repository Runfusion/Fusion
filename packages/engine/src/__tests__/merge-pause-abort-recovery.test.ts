import { describe, expect, it, vi } from "vitest";
import { MERGE_REGION_KINDS } from "../workflows/workflow-graph-executor.js";
import {
  graphFailureValue,
  isMergeGraphFailure,
  isStalePauseAbortParkFailure,
} from "../executor/graph-failure-pure.js";
import { isRetryableBenignMergePauseAbort } from "../executor/is-retryable-benign-merge-pause-abort.js";
import { isBenignManualMergeHoldPauseAbort } from "../executor/is-benign-manual-merge-hold-pause-abort.js";
import { routeImplementationIncompleteMergeGraphFailure } from "../executor/route-implementation-incomplete-merge-graph-failure.js";
import { routeGraphMergeFailureToRetry } from "../executor/route-graph-merge-failure-to-retry.js";
import { routeGraphFailureToExecutionResume } from "../executor/route-graph-failure-to-execution-resume.js";
import { handleGraphFailure } from "../executor/handle-graph-failure.js";

const lanes = { hold: "queued", wip: "building", review: "checking", wipDeclared: true };
const result = (node = "merge", value?: unknown) => ({
  visitedNodeIds: [node],
  context: value === undefined ? {} : { [`node:${node}:value`]: value },
}) as any;
const task = (overrides: Record<string, unknown> = {}) => ({
  id: "FN-6735",
  column: "checking",
  status: null,
  error: null,
  steps: [],
  dependencies: [],
  log: [],
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
  title: "merge recovery",
  description: "",
  prompt: "# merge recovery",
  ...overrides,
}) as any;
const classifierDeps = (settings: unknown = {}) => ({
  store: { getSettings: vi.fn().mockResolvedValue(settings) },
  resolveResumeLanes: vi.fn().mockResolvedValue(lanes),
  isLiveSharedBranchGroupMember: vi.fn().mockResolvedValue(false),
});

/*
FNXC:MergePauseAbortRecovery 2026-09-13-10:35:
FN-9297 restores FN-6735's safety matrix as pure deterministic seams. These cases deliberately
assert only contained in-place recovery after FN-217, never the removed review-to-WIP move.
*/
describe("FN-6735 merge pause-abort recovery", () => {
  describe("merge seam identity and graph values", () => {
    it("classifies every merge seam alias and rejects unrelated nodes", () => {
      for (const id of ["merge", "requestMerge", "merge-manual-hold", "merge-retry", ...MERGE_REGION_KINDS]) {
        expect(isMergeGraphFailure(id)).toBe(true);
      }
      for (const id of ["plan", "step-execute", "completion-summary", undefined]) {
        expect(isMergeGraphFailure(id)).toBe(false);
      }
    });

    it("reads direct, foreach, and optional-group failure values without accepting malformed data", () => {
      expect(graphFailureValue({ visitedNodeIds: ["merge"], context: { "node:merge:value": "direct" } } as any)).toBe("direct");
      expect(graphFailureValue({ visitedNodeIds: ["merge-region#0:merge-attempt"], context: { "node:merge-region:value": "foreach" } } as any)).toBe("foreach");
      expect(graphFailureValue({ visitedNodeIds: ["merge-group::merge-attempt"], context: { "node:merge-group:value": "group", "node:merge-attempt:value": "template" } } as any)).toBe("group");
      expect(graphFailureValue({ visitedNodeIds: ["merge-group::merge-attempt"], context: { "node:merge-attempt:value": "template" } } as any)).toBe("template");
      expect(graphFailureValue({ visitedNodeIds: [], context: {} } as any)).toBeUndefined();
      expect(graphFailureValue({ visitedNodeIds: ["merge"], context: undefined } as any)).toBeUndefined();
      expect(graphFailureValue({ visitedNodeIds: ["merge"], context: { "node:merge:value": 1 } } as any)).toBeUndefined();
    });

    it("identifies only a failed pause-abort park for the matching node", () => {
      const error = "Workflow graph failure surfaced after paused engine abort during pause/resume at node 'merge'";
      expect(isStalePauseAbortParkFailure(task({ status: "failed", error }), "merge")).toBe(true);
      expect(isStalePauseAbortParkFailure(task({ status: "failed", error }), "plan")).toBe(false);
      expect(isStalePauseAbortParkFailure(task({ status: "reviewing", error }), "merge")).toBe(false);
      expect(isStalePauseAbortParkFailure(task({ status: "failed", error: null }), "merge")).toBe(false);
    });
  });

  describe("auto-merge pause-abort retry", () => {
    it.each(["merge", "requestMerge", "merge-attempt", "merge-gate", "merge-manual-hold", "merge-retry"])("accepts clean retryable status at %s", async (node) => {
      for (const status of [null, "reviewing", "merging", "merging-pr"]) {
        await expect(isRetryableBenignMergePauseAbort(classifierDeps() as any, task({ status }), result(node), "engine-abort", true, false)).resolves.toBe(true);
      }
    });

    it("refuses every independent auto-merge retry guard", async () => {
      const cases: Array<[string, any, any, any, boolean, boolean, any]> = [
        ["not aborted", task(), result(), "engine-abort", false, false, classifierDeps()],
        ["user cancellation", task(), result(), "engine-abort", true, true, classifierDeps()],
        ["global pause", task(), result(), "global-pause", true, false, classifierDeps()],
        ["completion finalization", task(), result(), "completion-finalize", true, false, classifierDeps()],
        ["user pause", task({ userPaused: true }), result(), "engine-abort", true, false, classifierDeps()],
        ["wrong lane", task({ column: "building" }), result(), "engine-abort", true, false, classifierDeps()],
        ["failed status", task({ status: "failed" }), result(), "engine-abort", true, false, classifierDeps()],
        ["existing error", task({ error: "existing" }), result(), "engine-abort", true, false, classifierDeps()],
        ["confirmed merge", task({ mergeDetails: { mergeConfirmed: true } }), result(), "engine-abort", true, false, classifierDeps()],
        ["merge conflict", task(), result("merge", "merge-conflict"), "engine-abort", true, false, classifierDeps()],
        ["contamination", task(), result("merge", "contamination-detected"), "engine-abort", true, false, classifierDeps()],
        ["retry exhaustion", task(), result("merge", "retry-exhausted"), "engine-abort", true, false, classifierDeps()],
        ["incomplete implementation", task(), result("merge", "implementation-incomplete"), "engine-abort", true, false, classifierDeps()],
        ["non merge node", task(), result("plan"), "engine-abort", true, false, classifierDeps()],
        ["auto merge off", task(), result(), "engine-abort", true, false, classifierDeps({ autoMerge: false })],
        ["retry budget spent", task({ mergeRetries: 3 }), result(), "engine-abort", true, false, classifierDeps({ maxAutoMergeRetries: 3 })],
      ];
      for (const [_name, live, graph, provenance, paused, canceled, deps] of cases) {
        await expect(isRetryableBenignMergePauseAbort(deps, live, graph, provenance, paused, canceled)).resolves.toBe(false);
      }
      const rejecting = classifierDeps();
      rejecting.store.getSettings.mockRejectedValue(new Error("settings unavailable"));
      await expect(isRetryableBenignMergePauseAbort(rejecting as any, task(), result(), "engine-abort", true, false)).resolves.toBe(false);
    });

    it("keeps shared-member integration eligible only without a project member hold", async () => {
      const liveMember = task({ branchContext: { assignmentMode: "shared" } });
      const held = classifierDeps({ autoMerge: false });
      held.isLiveSharedBranchGroupMember.mockResolvedValue(true);
      await expect(isRetryableBenignMergePauseAbort(held as any, liveMember, result(), "engine-abort", true, false)).resolves.toBe(false);
      const admitted = classifierDeps({ autoMerge: false });
      admitted.isLiveSharedBranchGroupMember.mockResolvedValue(true);
      await expect(isRetryableBenignMergePauseAbort(admitted as any, task({ autoMerge: true }), result(), "engine-abort", true, false)).resolves.toBe(true);
    });
  });

  describe("manual merge hold", () => {
    it("accepts clean and matching stale pause-abort rows only for auto-merge-off holds", async () => {
      for (const node of ["merge", "requestMerge", "merge-manual-hold", "merge-retry", ...MERGE_REGION_KINDS]) {
        await expect(isBenignManualMergeHoldPauseAbort(classifierDeps({ autoMerge: false }) as any, task(), result(node), "engine-abort", true)).resolves.toBe(true);
      }
      const stale = task({ status: "failed", error: "Workflow graph failure surfaced after paused engine abort during pause/resume at node 'merge'" });
      expect(isStalePauseAbortParkFailure(stale, "merge")).toBe(true);
      await expect(isBenignManualMergeHoldPauseAbort(classifierDeps({ autoMerge: false }) as any, stale, result(), "hard-cancel", true)).resolves.toBe(true);
    });

    it("refuses invalid provenance, lifecycle, terminal, node, and shared-member states", async () => {
      const cases: Array<[any, any, any, boolean, any]> = [
        [task(), result(), "global-pause", true, classifierDeps({ autoMerge: false })],
        [task(), result(), "engine-abort", false, classifierDeps({ autoMerge: false })],
        [task({ paused: true }), result(), "engine-abort", true, classifierDeps({ autoMerge: false })],
        [task({ userPaused: true }), result(), "engine-abort", true, classifierDeps({ autoMerge: false })],
        [task({ column: "building" }), result(), "engine-abort", true, classifierDeps({ autoMerge: false })],
        [task({ mergeDetails: { mergeConfirmed: true } }), result(), "engine-abort", true, classifierDeps({ autoMerge: false })],
        [task(), result("merge", "retry-exhausted"), "engine-abort", true, classifierDeps({ autoMerge: false })],
        [task(), result("plan"), "engine-abort", true, classifierDeps({ autoMerge: false })],
        [task({ status: "failed", error: "unrelated" }), result(), "engine-abort", true, classifierDeps({ autoMerge: false })],
      ];
      for (const [live, graph, provenance, paused, deps] of cases) {
        await expect(isBenignManualMergeHoldPauseAbort(deps as any, live, graph, provenance, paused)).resolves.toBe(false);
      }
      const member = classifierDeps({ autoMerge: false });
      member.isLiveSharedBranchGroupMember.mockResolvedValue(true);
      await expect(isBenignManualMergeHoldPauseAbort(member as any, task({ autoMerge: true }), result(), "engine-abort", true)).resolves.toBe(false);
      const rejecting = classifierDeps({ autoMerge: false });
      rejecting.store.getSettings.mockRejectedValue(new Error("settings unavailable"));
      await expect(isBenignManualMergeHoldPauseAbort(rejecting as any, task(), result(), "engine-abort", true)).resolves.toBe(false);
    });
  });

  describe("production graph-failure ordering", () => {
    const graphFailureDeps = (live: any) => {
      const updateTask = vi.fn();
      const routeImplementationIncompleteMergeGraphFailure = vi.fn().mockResolvedValue(true);
      const isRetryableBenignMergePauseAbort = vi.fn().mockResolvedValue(false);
      const isBenignManualMergeHoldPauseAbort = vi.fn().mockResolvedValue(false);
      const deps = {
        store: { getTask: vi.fn().mockResolvedValue(live), updateTask, logEntry: vi.fn() },
        rootDir: process.cwd(), options: {}, activeWorktrees: new Map([[live.id, new Set(["/worktree"])]]),
        completionFinalizedTaskIds: new Set(), graphExecuteSelfRequeued: new Set(), graphToolFailureRunCursors: new Map(),
        pausedAborted: new Set([live.id]), pausedAbortProvenance: new Map([[live.id, "engine-abort"]]), userCanceledTaskIds: new Set(),
        executing: new Set(), resumingUnpaused: new Set(), activeSessions: new Map(), activeStepExecutors: new Map(), activeWorkflowStepSessions: new Map(), activeCliTaskSessions: new Map(), activeWorkflowGraphAbortControllers: new Map(), processWideGraphRouting: new Set(), deferredTerminalParksInFlight: new Set(),
        getRunContextFor: vi.fn(), clearCompletedTaskWatchdog: vi.fn(), clearPausedAborted: vi.fn(), execute: vi.fn(), finalizeMergeConfirmedWorkflowGraphTask: vi.fn(), getTaskCompletionBlocker: vi.fn(), handleStaleInReviewParsePauseAbortReplay: vi.fn().mockResolvedValue(false), handleStaleInReviewPlanPauseAbortReplay: vi.fn().mockResolvedValue(false), handoffTaskToReview: vi.fn(), hasLiveTaskSessionSurface: vi.fn(), hasTrailingConsecutiveToolFailures: vi.fn(), holdForSessionContention: vi.fn(),
        isBenignManualMergeHoldPauseAbort, isReentrantPausedAbortedInFlightNode: vi.fn().mockResolvedValue(false), isRemediationGraphNode: vi.fn(), isRequiredArtifactRecoveryProtected: vi.fn(), isRetryableBenignMergePauseAbort, parkCompletedBlockedTask: vi.fn(), persistTokenUsage: vi.fn(), reenterPausedAbortedWorkflowNode: vi.fn(), resolveResumeLanes: vi.fn().mockResolvedValue(lanes), routeGraphFailureToExecutionResume: vi.fn(), routeGraphMergeFailureToRetry: vi.fn(), requestPreMergeOptionalStepFix: vi.fn(), routeImplementationIncompleteMergeGraphFailure, routeResetParsePinMismatchToRetry: vi.fn(), routeRetryableRemediationGraphFailureToPreMergeFix: vi.fn(), routeUnusableWorktreeGraphFailureToRecovery: vi.fn().mockResolvedValue(false), safeLogEntry: vi.fn(),
      };
      return { deps, updateTask, routeImplementationIncompleteMergeGraphFailure, isRetryableBenignMergePauseAbort, isBenignManualMergeHoldPauseAbort };
    };

    it("clears a real stale manual-hold pause-abort park through the caller without moving or re-enqueueing", async () => {
      const stale = task({ status: "failed", error: "Workflow graph failure surfaced after paused engine abort during pause/resume at node 'merge'" });
      const harness = graphFailureDeps(stale);
      harness.deps.store.getSettings = vi.fn().mockResolvedValue({ autoMerge: false });
      harness.isBenignManualMergeHoldPauseAbort.mockImplementation((live, graph, provenance, paused, memo) => isBenignManualMergeHoldPauseAbort({
        store: harness.deps.store,
        resolveResumeLanes: harness.deps.resolveResumeLanes,
        isLiveSharedBranchGroupMember: vi.fn().mockResolvedValue(false),
      } as any, live, graph, provenance, paused, memo));
      expect(isStalePauseAbortParkFailure(stale, "merge")).toBe(true);
      await handleGraphFailure(harness.deps as any, stale, result("merge"));
      expect(harness.isBenignManualMergeHoldPauseAbort).toHaveBeenCalledTimes(1);
      expect(harness.updateTask).toHaveBeenCalledWith(stale.id, { status: null, error: null }, undefined);
      expect(harness.deps.routeGraphMergeFailureToRetry).not.toHaveBeenCalled();
      expect(harness.deps.store.moveTask).toBeUndefined();

      const clean = task();
      const cleanHarness = graphFailureDeps(clean);
      cleanHarness.isBenignManualMergeHoldPauseAbort.mockResolvedValue(true);
      await handleGraphFailure(cleanHarness.deps as any, clean, result("merge"));
      expect(cleanHarness.updateTask).not.toHaveBeenCalled();
    });

    it("honors an auto-merge-on stale park instead of sending it to merge retry", async () => {
      const stale = task({ status: "failed", error: "Workflow graph failure surfaced after paused engine abort during pause/resume at node 'merge'" });
      const harness = graphFailureDeps(stale);
      harness.deps.store.getSettings = vi.fn().mockResolvedValue({ autoMerge: true });
      harness.isBenignManualMergeHoldPauseAbort.mockImplementation((live, graph, provenance, paused, memo) => isBenignManualMergeHoldPauseAbort({
        store: harness.deps.store,
        resolveResumeLanes: harness.deps.resolveResumeLanes,
        isLiveSharedBranchGroupMember: vi.fn().mockResolvedValue(false),
      } as any, live, graph, provenance, paused, memo));

      await handleGraphFailure(harness.deps as any, stale, result("merge"));

      expect(harness.isBenignManualMergeHoldPauseAbort).toHaveBeenCalledTimes(1);
      expect(harness.deps.routeGraphMergeFailureToRetry).not.toHaveBeenCalled();
      expect(harness.updateTask).not.toHaveBeenCalled();
      expect(harness.deps.persistTokenUsage).toHaveBeenCalledTimes(1);
    });

    it("routes a system pause but excludes a user pause before retry classifiers", async () => {
      const systemPaused = task({ paused: true, steps: [{ status: "pending" }] });
      const systemHarness = graphFailureDeps(systemPaused);
      await handleGraphFailure(systemHarness.deps as any, systemPaused, result("merge", "implementation-incomplete"));
      expect(systemHarness.routeImplementationIncompleteMergeGraphFailure).toHaveBeenCalledWith(systemPaused, "merge");
      expect(systemHarness.isRetryableBenignMergePauseAbort).not.toHaveBeenCalled();

      const userPaused = task({ paused: true, userPaused: true, steps: [{ status: "pending" }] });
      const userHarness = graphFailureDeps(userPaused);
      userHarness.isBenignManualMergeHoldPauseAbort.mockResolvedValue(false);
      await handleGraphFailure(userHarness.deps as any, userPaused, result("merge", "implementation-incomplete"));
      expect(userHarness.routeImplementationIncompleteMergeGraphFailure).not.toHaveBeenCalled();
      expect(userHarness.isRetryableBenignMergePauseAbort).toHaveBeenCalled();
    });
  });

  describe("implementation-incomplete routing", () => {
    const incomplete = (overrides: Record<string, unknown> = {}) => task({ steps: [{ status: "pending" }], worktree: "/worktree", ...overrides });
    const incompleteDeps = (resume: boolean) => {
      const updateTask = vi.fn();
      const logEntry = vi.fn();
      const activeWorktrees = new Map([["FN-6735", new Set(["/worktree"])]]);
      return {
        updateTask,
        logEntry,
        activeWorktrees,
        deps: {
          store: { updateTask, logEntry, getTaskWorkflowSelection: () => undefined },
          getRunContextFor: () => undefined,
          clearPausedAborted: vi.fn(),
          activeWorktrees,
          routeGraphFailureToExecutionResume: vi.fn().mockResolvedValue(resume),
          persistTokenUsage: vi.fn(),
        },
      };
    };

    it("retains active worktree registration on a resumable in-place route", async () => {
      const { deps, activeWorktrees, updateTask } = incompleteDeps(true);
      await expect(routeImplementationIncompleteMergeGraphFailure(deps as any, incomplete(), "merge")).resolves.toBe(true);
      expect(activeWorktrees.has("FN-6735")).toBe(true);
      expect(updateTask).not.toHaveBeenCalledWith("FN-6735", expect.objectContaining({ status: "failed" }), undefined);
    });

    it("clears only a system pause before routing and releases only fail-closed work", async () => {
      const resumable = incompleteDeps(true);
      const paused = incomplete({ paused: true });
      await routeImplementationIncompleteMergeGraphFailure(resumable.deps as any, paused, "merge");
      expect(resumable.updateTask).toHaveBeenCalledWith("FN-6735", { paused: false, pausedReason: null }, undefined);
      expect(resumable.deps.routeGraphFailureToExecutionResume).toHaveBeenCalledWith(expect.objectContaining({ paused: false }), "merge", "implementation-incomplete");

      const failed = incompleteDeps(false);
      await routeImplementationIncompleteMergeGraphFailure(failed.deps as any, incomplete(), "merge");
      expect(failed.activeWorktrees.has("FN-6735")).toBe(false);
      expect(failed.logEntry).toHaveBeenCalledWith("FN-6735", expect.stringContaining("implementation incomplete with no executable proof to resume"), undefined, undefined);
      expect(failed.updateTask).toHaveBeenCalledWith("FN-6735", expect.objectContaining({ status: "failed", error: expect.any(String) }), undefined);
    });

    it("does not overwrite an existing error or terminal-column row", async () => {
      for (const live of [incomplete({ error: "existing" }), incomplete({ column: "done" })]) {
        const { deps, updateTask } = incompleteDeps(false);
        await routeImplementationIncompleteMergeGraphFailure(deps as any, live, "merge");
        expect(updateTask).not.toHaveBeenCalledWith("FN-6735", expect.objectContaining({ status: "failed" }), undefined);
      }
    });

    it("never routes implementation-incomplete failure to a merge requester", async () => {
      const mergeRequester = vi.fn();
      await expect(routeGraphMergeFailureToRetry({
        store: { logEntry: vi.fn() }, getRunContextFor: () => undefined, mergeRequester,
        ensureWorkflowMergeBoundaryTask: vi.fn(), persistTokenUsage: vi.fn(),
      } as any, task(), result("merge", "implementation-incomplete"), undefined)).resolves.toBe(false);
      expect(mergeRequester).not.toHaveBeenCalled();
    });

    it("refuses a review-lane backward move but resumes a WIP lane in place", async () => {
      const base = () => ({
        store: { logEntry: vi.fn(), updateTask: vi.fn(), getTaskWorkflowSelection: () => undefined }, getRunContextFor: () => undefined,
        resolveResumeLanes: vi.fn().mockResolvedValue(lanes), clearTerminalStepFailuresForRetry: vi.fn(),
        persistTokenUsage: vi.fn(), isRemediationGraphNode: vi.fn(),
      });
      const review = base();
      await expect(routeGraphFailureToExecutionResume(review as any, task({ steps: [{ status: "pending" }] }), "merge", "implementation-incomplete")).resolves.toBe(false);
      expect(review.store.updateTask).not.toHaveBeenCalled();
      expect(review.store.logEntry).toHaveBeenCalledWith("FN-6735", expect.stringContaining("automatic recovery cannot move 'checking' backward"), undefined, undefined);

      const wip = base();
      await expect(routeGraphFailureToExecutionResume(wip as any, task({ column: "building", steps: [{ status: "pending" }] }), "merge", "implementation-incomplete")).resolves.toBe(true);
      expect(wip.store.updateTask).toHaveBeenCalledWith("FN-6735", { status: null, error: null }, undefined);
      expect(wip.clearTerminalStepFailuresForRetry).toHaveBeenCalledWith("FN-6735", "archive");

      const absentWip = base();
      absentWip.resolveResumeLanes.mockResolvedValue({ ...lanes, wipDeclared: false });
      await expect(routeGraphFailureToExecutionResume(absentWip as any, task({ column: "building", steps: [{ status: "pending" }] }), "merge", "implementation-incomplete")).resolves.toBe(false);
    });
  });
});
