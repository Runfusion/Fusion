/*
FNXC:WorkflowLifecycle 2026-07-09-00:00 (FN-7717 regression):
Archiving a task must release every activeSessionRegistry entry it holds. Plan Review and
other workflow-step / step-session sessions run while a task is in triage/planning/todo (not
in-progress), so the executor's task:moved handler previously only disposed session surfaces
via the `from === "in-progress"` branch — a task archived from any OTHER column leaked its
registry entry and blocked a successor task from registering the same session path with
ActiveSessionPathHeldByForeignTaskError (NEXT-508 -> NEXT-433). This suite proves the fix
across all three registration surfaces (executor / step-session / workflow-step), the
leaked-entry sweep path (no in-memory session) including when archiving DIRECTLY from
in-progress in a single task:moved hop (a branch-ordering gap the fix also closes), the
done/in-review merge-lease exclusion, and the no-op case (task with no held paths).
*/
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { TaskStore } from "@fusion/core";
import { TaskExecutor } from "../executor.js";
import { activeSessionRegistry, ActiveSessionPathHeldByForeignTaskError } from "../agents/active-session-registry.js";

const SHARED_ROOT = "/tmp/fusion-test-archive-shared-root";

function createStore(): TaskStore & EventEmitter {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    logEntry: vi.fn().mockResolvedValue(undefined),
    getRunContextFor: vi.fn(),
    getSettings: vi.fn().mockResolvedValue({}),
  }) as unknown as TaskStore & EventEmitter;
}

function makeExecutor(): { executor: TaskExecutor; store: TaskStore & EventEmitter } {
  const store = createStore();
  const executor = new TaskExecutor(store, SHARED_ROOT);
  return { executor, store };
}

function makeTask(id: string): any {
  return { id, column: "archived" };
}

describe("archiving a task releases its active-session registry entries (FN-7717)", () => {
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => activeSessionRegistry.clear());

  it("releases a workflow-step session held by a task archived from triage, letting a successor acquire the same path", async () => {
    const { executor, store } = makeExecutor();

    /*
    FNXC:PlanReviewWorktree 2026-07-25-20:40:
    A root-rooted session is now registered under a TASK-SCOPED synthetic key (sessionRegistryPath),
    so assert release through `pathsForTask` — the bare-root key never exists. What archive must still
    guarantee is unchanged: the task holds exactly one live entry before, and none after.
    */
    (executor as any).setActiveWorkflowStepSession("TASK-A", {}, SHARED_ROOT);
    const [heldPath] = activeSessionRegistry.pathsForTask("TASK-A");
    expect(heldPath).toBeDefined();
    expect(activeSessionRegistry.isPathActive(heldPath)).toBe(true);

    // Drive the archive transition: to === "archived", from a NON-in-progress column
    // (Plan Review runs in triage), exactly like archiveTask emits.
    store.emit("task:moved", { task: makeTask("TASK-A"), from: "triage", to: "archived", source: "user" });

    // Await the disposal chain the handler kicked off via trackTaskDisposal.
    await (executor as any).pendingTaskDisposals.get("TASK-A");

    expect(activeSessionRegistry.isPathActive(heldPath)).toBe(false);
    expect(activeSessionRegistry.pathsForTask("TASK-A")).toHaveLength(0);

    // Successor task B can now register the same path without throwing.
    expect(() =>
      activeSessionRegistry.registerPath(heldPath, { taskId: "TASK-B", kind: "workflow-step", ownerKey: "TASK-B#workflow-step" }),
    ).not.toThrow();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-21:30 (fleet):
  The archive branch keyed on `to === "archived"`. On a board whose terminal lane is renamed it matched
  nothing, so archiving never released the task's active-session entry — and the registry entry is what
  blocks a SUCCESSOR task from acquiring the same path. The leak is therefore not cosmetic: the next
  task to want that path fails to register.

  Lanes come from the emitter, so this drives the listener exactly as `moves.ts` now emits. The literal
  is deliberately absent from the payload's lane: `shipped` matches no legacy id, so the branch fires
  only if the payload is actually consulted.
  */
  it("releases the session when archiving into a RENAMED terminal lane", async () => {
    const { executor, store } = makeExecutor();
    (executor as any).setActiveWorkflowStepSession("TASK-R", {}, SHARED_ROOT);
    const [heldPath] = activeSessionRegistry.pathsForTask("TASK-R");
    expect(heldPath).toBeDefined();

    store.emit("task:moved", {
      task: makeTask("TASK-R"),
      from: "signoff",
      to: "shipped",
      source: "user",
      lanes: { hold: "backlog", wip: "building", archived: "shipped" },
    });

    await (executor as any).pendingTaskDisposals.get("TASK-R");
    expect(activeSessionRegistry.pathsForTask("TASK-R")).toHaveLength(0);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:55 (fleet):
  THE OTHER TWO CONVERTED READS, which the archive case above does NOT cover.

  Mutation-testing the three converted reads together produced only ONE failure — the archive case.
  `wipLane` and `holdLane` were converted with nothing that fails when they regress, so on this
  program's own standard they shipped unproven. These two cases close that.

  They target the LAST branch of the if/else-if chain (`from === wipLane`), which is only reached when
  the archive and backward-out-of-planning branches both decline. `isBackwardMoveOutOfPlanning` is
  stubbed false so the test pins the lane comparison rather than that predicate's own logic — without
  the stub a change in planner-lane tracking could silently route these moves elsewhere and leave the
  assertions passing for the wrong reason.
  */
  it("aborts in-flight work when a card leaves a RENAMED wip lane", async () => {
    const { executor, store } = makeExecutor();
    vi.spyOn(executor as any, "isBackwardMoveOutOfPlanning").mockReturnValue(false);
    const abort = vi
      .spyOn(executor as any, "awaitAbortInFlightTaskWork")
      .mockResolvedValue(undefined);

    /* `building` matches no legacy id, so the branch fires only if the payload's wip lane is read. */
    store.emit("task:moved", {
      task: makeTask("TASK-W"),
      from: "building",
      to: "checking",
      source: "engine",
      lanes: { hold: "backlog", wip: "building", archived: "shipped" },
    });

    await (executor as any).pendingTaskDisposals.get("TASK-W");
    expect(abort).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:59 (the LISTENER must forward the payload lanes):
  THIS IS THE PRODUCER HALF, and it was missing.

  `isBackwardMoveOutOfPlanning` now receives its lanes instead of resolving them, and its own suite
  (`executor-planner-lanes-resolved`) covers the predicate thoroughly. But that suite calls the
  predicate DIRECTLY, so it says nothing about whether the `task:moved` listener actually hands the
  payload down. Measured: replacing the listener's `lanes` argument with `undefined` left
  `planning-evacuation` at 20/20 green — the exact producer/consumer split this program's learnings
  record as its fifth failure shape, where a converted consumer with an unconverted producer passes
  every instrument.

  So this drives the real listener. The board is renamed with NO legacy id anywhere near the planner
  lanes (`queued` holds, `drafting` intakes), and the move withdraws a card from the hold lane to a
  non-lifecycle column — the reported symptom, `todo -> Ideas`, in this board's vocabulary. The
  evacuation must fire, which it can only do if the payload lanes reached the predicate: with
  `undefined` the legacy pair answers, `from` is not `todo`/`triage`, and the branch declines.
  */
  it("evacuates a card withdrawn from a RENAMED planner lane — the listener forwards payload lanes", async () => {
    const { executor, store } = makeExecutor();
    const abort = vi
      .spyOn(executor as any, "awaitAbortInFlightTaskWork")
      .mockResolvedValue(undefined);
    vi.spyOn(executor as any, "releasePreExecutionWorktree").mockResolvedValue(undefined);

    store.emit("task:moved", {
      task: makeTask("TASK-E2"),
      from: "queued",
      to: "ideas",
      source: "user",
      lanes: { intake: "drafting", hold: "queued", wip: "building", review: "checking", complete: "shipped", archived: "filed" },
    });

    await (executor as any).pendingTaskDisposals.get("TASK-E2");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(String(abort.mock.calls[0]?.[1] ?? "")).toContain("out of planning");
  });

  /*
  `userCanceled` is the one place `holdLane` changes an OUTCOME rather than just a branch: a user
  dragging a card from the wip lane back to the board's hold lane is a cancel, and anything else is
  not. Keyed on the literal `"todo"`, a renamed hold lane made every such drag read as NOT
  user-canceled — the executor then treats the abort as an engine rebound and the task is eligible to
  be picked straight back up, which is the opposite of what the operator just asked for.
  */
  it("marks a user drag into a RENAMED hold lane as user-canceled", async () => {
    const { executor, store } = makeExecutor();
    vi.spyOn(executor as any, "isBackwardMoveOutOfPlanning").mockReturnValue(false);
    const abort = vi
      .spyOn(executor as any, "awaitAbortInFlightTaskWork")
      .mockResolvedValue(undefined);

    store.emit("task:moved", {
      task: makeTask("TASK-H"),
      from: "building",
      to: "backlog",
      source: "user",
      lanes: { hold: "backlog", wip: "building", archived: "shipped" },
    });

    await (executor as any).pendingTaskDisposals.get("TASK-H");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(abort.mock.calls[0]?.[2]).toMatchObject({ userCanceled: true });
  });

  it("releases executor and step-session surfaces archived from planning/todo columns", async () => {
    const { executor, store } = makeExecutor();

    (executor as any).setActiveSession("TASK-C", { session: { dispose: vi.fn() } }, `${SHARED_ROOT}-c`);
    (executor as any).setActiveStepExecutor("TASK-D", { terminateAllSessions: vi.fn().mockResolvedValue(undefined) }, `${SHARED_ROOT}-d`);

    store.emit("task:moved", { task: makeTask("TASK-C"), from: "planning", to: "archived", source: "user" });
    store.emit("task:moved", { task: makeTask("TASK-D"), from: "todo", to: "archived", source: "user" });

    await Promise.all([
      (executor as any).pendingTaskDisposals.get("TASK-C"),
      (executor as any).pendingTaskDisposals.get("TASK-D"),
    ]);

    expect(activeSessionRegistry.pathsForTask("TASK-C")).toHaveLength(0);
    expect(activeSessionRegistry.pathsForTask("TASK-D")).toHaveLength(0);
  });

  it("sweeps a leaked registry entry with no in-memory session on archive", async () => {
    const { executor, store } = makeExecutor();

    // Simulate a LEAKED entry: registered directly in the registry with no corresponding
    // in-memory activeSessions/activeStepExecutors/activeWorkflowStepSessions entry, so the
    // abort call itself finds nothing to dispose — only the sweep clears it.
    activeSessionRegistry.registerPath(`${SHARED_ROOT}-leak`, { taskId: "TASK-E", kind: "workflow-step", ownerKey: "TASK-E#workflow-step" });
    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-leak`)).toBe(true);

    store.emit("task:moved", { task: makeTask("TASK-E"), from: "in-review", to: "archived", source: "user" });
    await (executor as any).pendingTaskDisposals.get("TASK-E");

    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-leak`)).toBe(false);
    expect(activeSessionRegistry.pathsForTask("TASK-E")).toHaveLength(0);
  });

  it("sweeps a leaked registry entry when a task is archived DIRECTLY from in-progress (single task:moved hop, no todo stop)", async () => {
    const { executor, store } = makeExecutor();

    // fn_task_archive can move a live in-progress task straight to archived in one
    // `task:moved` event (from: "in-progress", to: "archived") with no intermediate
    // stop in "todo". Before the branch-ordering fix, this hit the narrower
    // `from === "in-progress"` branch first and skipped the archive-only leaked-entry
    // sweep, so a registry entry with no matching in-memory session would survive.
    activeSessionRegistry.registerPath(`${SHARED_ROOT}-inprogress-leak`, { taskId: "TASK-I", kind: "workflow-step", ownerKey: "TASK-I#workflow-step" });
    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-inprogress-leak`)).toBe(true);

    store.emit("task:moved", { task: makeTask("TASK-I"), from: "in-progress", to: "archived", source: "user" });
    await (executor as any).pendingTaskDisposals.get("TASK-I");

    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-inprogress-leak`)).toBe(false);
    expect(activeSessionRegistry.pathsForTask("TASK-I")).toHaveLength(0);
  });

  it("does NOT clear a held merge lease when a task moves to done or in-review", async () => {
    const { executor, store } = makeExecutor();

    activeSessionRegistry.registerPath(`${SHARED_ROOT}-merge-done`, { taskId: "TASK-F", kind: "ai-merge", ownerKey: "TASK-F#ai-merge" });
    activeSessionRegistry.registerPath(`${SHARED_ROOT}-merge-review`, { taskId: "TASK-G", kind: "workspace-repo-land", ownerKey: "TASK-G#workspace-repo-land" });

    store.emit("task:moved", { task: makeTask("TASK-F"), from: "in-progress", to: "done", source: "engine" });
    store.emit("task:moved", { task: makeTask("TASK-G"), from: "in-progress", to: "in-review", source: "engine" });

    // These moves go through the existing `from === "in-progress"` branch, which is
    // unrelated to and does not fire the new archive-only sweep — the merge lease survives.
    await Promise.resolve();

    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-merge-done`)).toBe(true);
    expect(activeSessionRegistry.isPathActive(`${SHARED_ROOT}-merge-review`)).toBe(true);
  });

  it("is a no-op that does not throw when archiving a task with no held registry paths", async () => {
    const { executor, store } = makeExecutor();

    expect(() =>
      store.emit("task:moved", { task: makeTask("TASK-H"), from: "triage", to: "archived", source: "user" }),
    ).not.toThrow();

    await (executor as any).pendingTaskDisposals.get("TASK-H");
    expect(activeSessionRegistry.pathsForTask("TASK-H")).toHaveLength(0);
  });

  it("reproduces the original ActiveSessionPathHeldByForeignTaskError before archive, and confirms it is gone after", async () => {
    const { executor, store } = makeExecutor();

    /*
    FNXC:PlanReviewWorktree 2026-07-25-20:40:
    The original NEXT-508 symptom was reproduced on the shared ROOT. That path can no longer collide at
    all (root keys are task-scoped), so the leak symptom is now reproduced on a per-task WORKTREE path,
    where the foreign-task guard still applies and only archive can release the holder.
    */
    const heldWorktree = `${SHARED_ROOT}-next508-worktree`;
    (executor as any).setActiveWorkflowStepSession("NEXT-508", {}, heldWorktree);

    // Before archive: a second task trying to register the same path is rejected.
    expect(() =>
      activeSessionRegistry.registerPath(heldWorktree, { taskId: "NEXT-433", kind: "workflow-step", ownerKey: "NEXT-433#workflow-step" }),
    ).toThrow(ActiveSessionPathHeldByForeignTaskError);

    store.emit("task:moved", { task: makeTask("NEXT-508"), from: "triage", to: "archived", source: "user" });
    await (executor as any).pendingTaskDisposals.get("NEXT-508");

    // After archive: the successor can now acquire the path.
    expect(() =>
      activeSessionRegistry.registerPath(heldWorktree, { taskId: "NEXT-433", kind: "workflow-step", ownerKey: "NEXT-433#workflow-step" }),
    ).not.toThrow();
  });
});

describe("workflow graph column boundaries do not abort their own run", () => {
  it.each(["triage", "in-review"] as const)(
    "keeps the graph runner alive across in-progress → %s",
    async (to) => {
      const { executor, store } = makeExecutor();
      const task = { id: `TASK-GRAPH-${to}`, column: to } as any;
      const abortSpy = vi
        .spyOn(executor as any, "awaitAbortInFlightTaskWork")
        .mockResolvedValue(undefined);
      (store as any).moveTask = vi.fn(async (_taskId: string, column: string) => {
        store.emit("task:moved", {
          task: { ...task, column },
          from: "in-progress",
          to: column,
          source: "engine",
        });
      });

      (executor as any).graphRouting.add(task.id);
      try {
        await (executor as any).buildColumnBoundaryHooks(task).moveTask(to, {
          fromColumn: "in-progress",
          nodeId: to === "triage" ? "plan-replan" : "review",
        });
        await Promise.resolve();

        expect(abortSpy).not.toHaveBeenCalled();
      } finally {
        (executor as any).graphRouting.delete(task.id);
      }
    },
  );

  it("still aborts an external engine move away from in-progress", async () => {
    const { executor, store } = makeExecutor();
    const abortSpy = vi
      .spyOn(executor as any, "awaitAbortInFlightTaskWork")
      .mockResolvedValue(undefined);

    store.emit("task:moved", {
      task: { id: "TASK-EXTERNAL", column: "todo" },
      from: "in-progress",
      to: "todo",
      source: "engine",
    });
    await Promise.resolve();

    expect(abortSpy).toHaveBeenCalledOnce();
  });
});

/*
FNXC:WorkflowResolvedColumns 2026-07-31-23:20:
THE SAME RELEASE, ON A BOARD THAT DOES NOT CALL ITS ARCHIVE LANE `archived`.

The branch above was keyed on the `archived` literal, so on a renamed board the archive transition
fell through to the narrower `from === wip` arm — or to no arm at all — and the registry entry leaked
exactly as it did before FN-7717, for the same downstream cost: a successor task cannot acquire the
same session path.

#3109 made `task:moved` carry the emitter-resolved lanes, so the guard reads the answer off the
payload with NO await. That matters here specifically: this listener's disposal bookkeeping is written
in the handler's own tick and read by the NEXT event's prologue (the FN-5256 fast-bounce path), so a
guard that had to await could not be used without reopening that race.

The paired negative is the load-bearing half. `done`/`in-review` deliberately keep their merge leases
across the transition (FN-6736 / Phase C-D), so a resolved-lane guard must not start releasing them —
a conversion that released on every terminal-ish lane would satisfy the positive and break the
guarantee this file already protects.
*/
describe("archive release follows the board's own archive lane", () => {
  beforeEach(() => activeSessionRegistry.clear());
  afterEach(() => activeSessionRegistry.clear());

  /** Archive lane `filed`, wip `building` — the shape `moves.ts` now puts on the payload. */
  const RENAMED_LANES = { hold: "drafting", intake: "inbox", wip: "building", review: "checking", complete: "shipped", archived: "filed" };

  it("releases a held session when the card moves into a RENAMED archive lane", async () => {
    const { executor, store } = makeExecutor();

    (executor as any).setActiveWorkflowStepSession("TASK-RENAMED", {}, SHARED_ROOT);
    expect(activeSessionRegistry.pathsForTask("TASK-RENAMED").length).toBe(1);

    store.emit("task:moved", {
      task: { id: "TASK-RENAMED", column: "filed" } as never,
      from: "drafting", to: "filed", source: "user", lanes: RENAMED_LANES,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(activeSessionRegistry.pathsForTask("TASK-RENAMED")).toEqual([]);
  });

  it("does NOT release a session when the card moves into the board's own COMPLETE lane", async () => {
    const { executor, store } = makeExecutor();

    (executor as any).setActiveWorkflowStepSession("TASK-KEEP", {}, SHARED_ROOT);
    expect(activeSessionRegistry.pathsForTask("TASK-KEEP").length).toBe(1);

    /* `shipped` is complete, not archived: the merge lease must survive, exactly as `done` does. */
    store.emit("task:moved", {
      task: { id: "TASK-KEEP", column: "shipped" } as never,
      from: "checking", to: "shipped", source: "engine", lanes: RENAMED_LANES,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(activeSessionRegistry.pathsForTask("TASK-KEEP").length).toBe(1);
  });

  /*
  The fail-soft case. `lanes` is optional — an emit path that cannot resolve sends none — and the
  guard must then behave exactly as it did before #3109 rather than matching nothing.
  */
  it("falls back to the legacy id when the emitter sent no lanes", async () => {
    const { executor, store } = makeExecutor();

    (executor as any).setActiveWorkflowStepSession("TASK-LEGACY", {}, SHARED_ROOT);
    store.emit("task:moved", { task: makeTask("TASK-LEGACY"), from: "todo", to: "archived", source: "user" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(activeSessionRegistry.pathsForTask("TASK-LEGACY")).toEqual([]);
  });
});
