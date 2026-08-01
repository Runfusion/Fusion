/*
FNXC:WorkflowLifecycle 2026-07-26-11:20:
KB-PROV regression suite. Original symptom (FN-8596, production): the graph's `code-review-remediation`
node moved a card in-review -> in-progress, `performWorkflowRerunBounce` then bounced it
in-progress -> todo -> in-progress to re-dispatch, and the operator saw
`Pause abort marked: provenance=hard-cancel source=abort-in-flight:parent moved from in-progress to todo`
even though the move source was "engine" and `userCanceled` was correctly false. `hard-cancel` is the
provenance AGENTS.md reserves for the operator Move-Task hard cancel, so the log (and any future consumer
branching on the label) read an engine bounce as an operator withdrawal.

Surface enumeration — every `awaitAbortInFlightTaskWork` entry point, asserted below, not just the one
reported bounce:
  ENGINE (must be `engine-abort`): engine-sourced `from === "in-progress"` move (the FN-8596 repro),
  engine-sourced move out of a planning lane, archive disposal, workspace-archive disposal, task pause,
  approval-gate suspension, `abortAllInFlight` (shutdown/global stop), stuck-kill force-requeue.
  OPERATOR (must stay `hard-cancel`): the registered move disposer (user in-progress -> todo),
  user-sourced move out of a planning lane, task soft-delete.
And the invariant that motivated the split must not cost behaviour: the benign-abort classifiers in
`handleGraphFailure` exist FOR the engine case, so they must accept `engine-abort` exactly as they
accepted the old catch-all `hard-cancel`.
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";
import type { TaskDetail } from "@fusion/core";

const now = "2026-07-26T00:00:00.000Z";

function makeTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "FN-8596",
    title: "abort provenance repro",
    description: "KB-PROV: engine bounce must not be labeled hard-cancel",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }],
    currentStep: 0,
    log: [],
    branch: null,
    baseBranch: "main",
    worktree: "/tmp/fusion-kb-prov",
    status: null,
    error: null,
    paused: false,
    userPaused: false,
    autoMerge: true,
    mergeRetries: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as TaskDetail;
}

function makeExecutor(taskOverrides: Partial<TaskDetail> = {}) {
  const store = createMockStore();
  const task = makeTask(taskOverrides);
  store.getTask.mockResolvedValue(task);
  store.getSettings.mockResolvedValue({
    maxConcurrent: 2,
    maxWorktrees: 4,
    pollIntervalMs: 15000,
    autoMerge: true,
    maxAutoMergeRetries: 3,
  });
  store.recordRunAuditEvent = vi.fn();
  const executor = new TaskExecutor(store, "/tmp/test", {});
  return { store, task, executor };
}

function provenanceOf(executor: TaskExecutor, taskId: string): string | undefined {
  return (executor as any).pausedAbortProvenance.get(taskId);
}

function logText(store: ReturnType<typeof createMockStore>): string {
  return store.logEntry.mock.calls.map((call: unknown[]) => call[1]).join("\n");
}

/** Every write the executor made to the row, so `userPaused` can be asserted negatively. */
function updatePatches(store: ReturnType<typeof createMockStore>): Record<string, unknown>[] {
  return store.updateTask.mock.calls.map((call: unknown[]) => (call[1] ?? {}) as Record<string, unknown>);
}

describe("pause-abort provenance truthfulness (KB-PROV)", () => {
  beforeEach(() => {
    resetExecutorMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("awaitAbortInFlightTaskWork derives provenance from userCanceled", () => {
    it("labels an engine-initiated abort `engine-abort`, never `hard-cancel`", async () => {
      const { store, task, executor } = makeExecutor();

      await executor.awaitAbortInFlightTaskWork(task.id, "parent moved from in-progress to todo");

      expect(provenanceOf(executor, task.id)).toBe("engine-abort");
      expect(provenanceOf(executor, task.id)).not.toBe("hard-cancel");
      expect(logText(store)).toContain("provenance=engine-abort");
      expect(logText(store)).not.toContain("provenance=hard-cancel");
      // Engine rebounds must not claim operator withdrawal (AGENTS.md Move-Task contract).
      expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(false);
    });

    it("keeps `hard-cancel` for an operator-canceled abort", async () => {
      const { store, task, executor } = makeExecutor();

      await executor.awaitAbortInFlightTaskWork(task.id, "user moved task from in-progress to todo", {
        userCanceled: true,
      });

      expect(provenanceOf(executor, task.id)).toBe("hard-cancel");
      expect(logText(store)).toContain("provenance=hard-cancel");
      expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(true);
    });

    it("treats an explicit `userCanceled: false` as engine provenance", async () => {
      const { task, executor } = makeExecutor();

      await executor.awaitAbortInFlightTaskWork(task.id, "engine bounce", { userCanceled: false });

      expect(provenanceOf(executor, task.id)).toBe("engine-abort");
    });

    it("never sets userPaused on either path (engine rebounds and the abort itself are not pauses)", async () => {
      const engine = makeExecutor();
      await engine.executor.awaitAbortInFlightTaskWork(engine.task.id, "engine bounce");
      const user = makeExecutor();
      await user.executor.awaitAbortInFlightTaskWork(user.task.id, "user cancel", { userCanceled: true });

      for (const store of [engine.store, user.store]) {
        expect(updatePatches(store).some((patch) => "userPaused" in patch)).toBe(false);
      }
    });
  });

  describe("surface enumeration: each abort caller gets a truthful label", () => {
    it("FN-8596 repro — an ENGINE-sourced in-progress -> todo move labels the abort `engine-abort`", async () => {
      const { store, task, executor } = makeExecutor();

      await store._triggerAsync("task:moved", { task, from: "in-progress", to: "todo", source: "engine" });
      await (executor as any).pendingTaskDisposals.get(task.id);

      expect(provenanceOf(executor, task.id)).toBe("engine-abort");
      expect(logText(store)).toContain(
        "provenance=engine-abort source=abort-in-flight:parent moved from in-progress to todo",
      );
      expect(logText(store)).not.toContain("provenance=hard-cancel");
      expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(false);
    });

    it("a USER-sourced in-progress -> todo move still labels the abort `hard-cancel`", async () => {
      const { store, task, executor } = makeExecutor();

      await store._triggerAsync("task:moved", { task, from: "in-progress", to: "todo", source: "user" });
      await (executor as any).pendingTaskDisposals.get(task.id);

      expect(provenanceOf(executor, task.id)).toBe("hard-cancel");
      expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(true);
    });

    it("an ENGINE-sourced move out of a planning lane labels the abort `engine-abort`", async () => {
      const { store, task, executor } = makeExecutor({ column: "todo" });

      await store._triggerAsync("task:moved", { task, from: "todo", to: "ideas", source: "engine" });
      await (executor as any).pendingTaskDisposals.get(task.id);

      expect(provenanceOf(executor, task.id)).toBe("engine-abort");
    });

    it("a USER-sourced move out of a planning lane stays `hard-cancel`", async () => {
      const { store, task, executor } = makeExecutor({ column: "todo" });

      await store._triggerAsync("task:moved", { task, from: "todo", to: "ideas", source: "user" });
      await (executor as any).pendingTaskDisposals.get(task.id);

      expect(provenanceOf(executor, task.id)).toBe("hard-cancel");
    });

    it("soft-delete is an operator withdrawal and stays `hard-cancel`", async () => {
      const { store, task, executor } = makeExecutor();

      await store._triggerAsync("task:deleted", task);
      await (executor as any).pendingTaskDisposals.get(task.id);

      expect(provenanceOf(executor, task.id)).toBe("hard-cancel");
      expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(true);
    });

    it("archive disposal is engine lifecycle, not an operator cancel", async () => {
      const { store, task, executor } = makeExecutor();

      await store._triggerAsync("task:moved", { task, from: "in-progress", to: "archived", source: "engine" });
      await (executor as any).pendingTaskDisposals.get(task.id);

      expect(provenanceOf(executor, task.id)).toBe("engine-abort");
      expect((executor as any).userCanceledTaskIds.has(task.id)).toBe(false);
    });

    it("abortAllInFlight (shutdown / global stop) labels every task `engine-abort`", async () => {
      const { task, executor } = makeExecutor();
      (executor as any).activeSessions.set(task.id, { dispose: vi.fn() });

      await executor.abortAllInFlight("engine shutdown");

      expect(provenanceOf(executor, task.id)).toBe("engine-abort");
    });
  });

  describe("behaviour is unchanged: benign classifiers still accept the engine label", () => {
    /*
    The classifiers this split touches (isBenignInReviewPauseAbort, isBenignManualMergeHoldPauseAbort,
    isReentrantPausedAbortedInFlightNode, the stale plan/parse replays) were written against the old
    catch-all and exist FOR engine aborts. If the split had narrowed them to `hard-cancel`, every benign
    engine abort would have been re-parked as an operator-action failure — so assert the recovery path
    fires under both labels.
    */
    async function invokeGraphFailure(executor: TaskExecutor, task: TaskDetail) {
      await (executor as any).handleGraphFailure(task, {
        disposition: "failed",
        outcome: "failure",
        visitedNodeIds: ["plan", "execute"],
        context: {},
      });
    }

    it.each(["engine-abort", "hard-cancel"] as const)(
      "auto-continues a benign todo pause-abort under provenance '%s' (no failed park)",
      async (provenance) => {
        const { store, task, executor } = makeExecutor({ column: "todo", worktree: "/tmp/fusion-kb-prov" });
        (executor as any).markPausedAborted(task.id, provenance);
        (executor as any).addActiveWorktree(task.id, task.worktree);
        vi.spyOn(executor as any, "execute").mockResolvedValue(undefined);

        await invokeGraphFailure(executor, task);

        expect(updatePatches(store).some((patch) => patch.status === "failed")).toBe(false);
        expect(logText(store)).toContain("auto-continuing the agent session");
      },
    );

    it.each(["engine-abort", "hard-cancel"] as const)(
      "classifies a clean completed in-review row as a benign pause-abort under provenance '%s'",
      async (provenance) => {
        const { executor } = makeExecutor();
        const live = makeTask({
          column: "in-review",
          steps: [{ name: "Implement", status: "done" }],
        });
        const benign = (executor as any).isBenignInReviewPauseAbort(
          live,
          { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan", "execute"], context: {} },
          provenance,
          true,
          false,
          /*
          FNXC:WorkflowLifecycleColumns 2026-07-30-21:45:
          THE REVIEW LANE, which this call was silently omitting.

          #2703 added a seventh parameter so the lane is resolved by the caller instead of through the
          sync resolver (a no-op under the shipped backend). The call goes through `as any`, so the
          missing argument was not a type error — it arrived `undefined`, `live.column !== reviewLane`
          was true for every row, and the classifier returned false for BOTH provenances. That reads as
          "FN-6796 regressed and clean in-review rows are being stranded again" when the product is
          fine and the call is short one argument.

          Passed explicitly rather than defaulted inside the classifier: a default would restore the
          literal this parameter exists to remove.
          */
          "in-review",
        );

        expect(benign).toBe(true);
      },
    );

    /*
    FNXC:WorkflowLifecycleColumns 2026-07-30-21:45:
    The lane must be USED, not merely accepted. Without this, passing the argument could be reverted to
    a hardcoded "in-review" inside the classifier and every assertion above would still pass — the
    parameter would look converted while behaving like the literal, which is the exact failure the
    census counts as a win. A card resting in a RENAMED review lane is the differential.
    */
    it("honours the caller's review lane: a renamed lane classifies the same, a mismatched one does not", () => {
      const { executor } = makeExecutor();
      const result = { disposition: "failed", outcome: "failure", visitedNodeIds: ["plan", "execute"], context: {} };
      const classify = (column: string, reviewLane: string) =>
        (executor as any).isBenignInReviewPauseAbort(
          makeTask({ column, steps: [{ name: "Implement", status: "done" }] }),
          result,
          "engine-abort",
          true,
          false,
          reviewLane,
        );

      // Resting in the board's declared review lane, whatever it is called.
      expect(classify("validating", "validating")).toBe(true);
      // Resting somewhere else: not a benign in-review pause-abort.
      expect(classify("validating", "in-review")).toBe(false);
    });
  });
});
