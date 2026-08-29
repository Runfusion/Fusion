/*
FNXC:WorkflowRecoveryPolicy 2026-07-28-20:30 (U4 — pre-migration CHARACTERIZATION):

`surfaceStalePausedTodos` is about to become the first sweep retired onto the
recovery-policy reconciler. This file pins what it does TODAY, before the
migration, so the migration is judged against observed behavior rather than
against what the sweep looks like it should do.

Two questions, both of which the migration could silently get wrong:

  1. THRESHOLD SOURCE. The sweep reads `settings.stalePausedTodoThresholdMs`
     directly. Under the override layer an undeclared workflow must keep
     observing exactly that value — a migration that reaches for a declaration
     default instead would silently reset an operator who tuned it. This is the
     case the coordinator asked to see proven before anything else.

  2. USER-PAUSED CARDS. `getStalePausedTodoSignal` gates on `task.paused === true`
     and does NOT consult `userPaused`, so a user-paused card that has sat too
     long is surfaced today. The reconciler's ratified user-pause safeguard
     suppresses the `surface` action for `userPaused` cards, so routing this
     sweep through it as-is would STOP surfacing them. That is a behavior change,
     and this test is the evidence for it rather than an argument about it.

`paused` and `userPaused` are distinct fields that can diverge — see the comment
at `branch-group-ops.ts:128` about `userPaused` remaining true while legacy
`paused` is false — so the two cases below are genuinely separable states.

These are characterization tests: they pass against CURRENT main and must still
pass after the migration. If the migration changes either answer, that change is
deliberate and needs saying out loud.
*/
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { SelfHealingManager } from "../self-healing.js";

const WF = "custom:wf";
/** The legacy/built-in threshold an implementation might wrongly reach for. */
const BUILTIN_DEFAULT_MS = 24 * 60 * 60_000;
/** An operator who deliberately tightened it to 1h. */
const CUSTOMIZED_MS = 60 * 60_000;

function pausedTask(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    paused: true,
    pausedReason: "manual-hold",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as Task;
}

function ir(holdId: string): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    nodes: [],
    edges: [],
    columns: [
      { id: holdId, name: holdId, traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

function harness(tasks: Task[], settings: Record<string, unknown>) {
  const logEntry = vi.fn().mockResolvedValue(undefined);
  const selection = { workflowId: WF, stepIds: [] };
  const store = {
    getSettings: vi.fn().mockResolvedValue(settings),
    listTasks: vi.fn(async (opts?: { column?: string }) =>
      opts?.column ? tasks.filter((t) => t.column === opts.column) : tasks,
    ),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id) ?? null),
    logEntry,
    recordRunAuditEvent: vi.fn().mockResolvedValue(undefined),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: ir("todo") })),
  } as unknown as TaskStore;
  return { manager: new SelfHealingManager(store, { rootDir: "/tmp/test-project" }), logEntry };
}

describe("surfaceStalePausedTodos — behavior BEFORE the policy migration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2h after the card entered the column: stale at 1h, fresh at 24h.
    vi.setSystemTime(new Date("2026-01-01T02:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  describe("threshold source (the case that must survive the migration)", () => {
    it("observes a CUSTOMIZED operator threshold, not the built-in default", async () => {
      /*
      THE case. The workflow declares no policy, so after the migration this must
      still resolve through `stalePausedTodoThresholdMs`. An implementation that
      reaches for a declaration default finds the card fresh at 24h and silently
      stops surfacing it.
      */
      const h = harness([pausedTask({ id: "FN-C" })], { stalePausedTodoThresholdMs: CUSTOMIZED_MS });

      expect(await h.manager.surfaceStalePausedTodos()).toBe(1);
      expect(h.logEntry).toHaveBeenCalledWith("FN-C", expect.stringContaining("Stale paused todo surfaced"));
    });

    it("does NOT surface the same card under the built-in default threshold", async () => {
      /* The discriminator. Without this, "always surface" would pass the test
         above and prove nothing about which threshold was used. */
      const h = harness([pausedTask({ id: "FN-C" })], { stalePausedTodoThresholdMs: BUILTIN_DEFAULT_MS });

      expect(await h.manager.surfaceStalePausedTodos()).toBe(0);
      expect(h.logEntry).not.toHaveBeenCalled();
    });

    it("is disabled entirely when the operator sets a non-positive threshold", async () => {
      const h = harness([pausedTask({ id: "FN-C" })], { stalePausedTodoThresholdMs: 0 });
      expect(await h.manager.surfaceStalePausedTodos()).toBe(0);
    });
  });

  describe("user-paused cards (evidence for the safeguard question)", () => {
    it("SURFACES a user-paused card today — the reconciler safeguard would suppress it", async () => {
      /*
      The empirical answer. `getStalePausedTodoSignal` gates on `paused === true`
      and never consults `userPaused`, so an operator-paused card that has sat too
      long IS reported today. Routing this sweep through the reconciler unchanged
      would suppress exactly this case.
      */
      const h = harness([pausedTask({ id: "FN-U", userPaused: true } as Partial<Task>)], {
        stalePausedTodoThresholdMs: CUSTOMIZED_MS,
      });

      expect(await h.manager.surfaceStalePausedTodos()).toBe(1);
      expect(h.logEntry).toHaveBeenCalledWith("FN-U", expect.stringContaining("Stale paused todo surfaced"));
    });

    it("surfaces an automation-paused card too, so the two are not distinguished today", async () => {
      const h = harness([pausedTask({ id: "FN-A", pausedReason: "dispatch-storm" })], {
        stalePausedTodoThresholdMs: CUSTOMIZED_MS,
      });

      expect(await h.manager.surfaceStalePausedTodos()).toBe(1);
    });

    it("does not surface an UNPAUSED card, so `paused` is genuinely the gate", async () => {
      const h = harness([pausedTask({ id: "FN-N", paused: false })], {
        stalePausedTodoThresholdMs: CUSTOMIZED_MS,
      });

      expect(await h.manager.surfaceStalePausedTodos()).toBe(0);
    });
  });

  describe("global gates that must survive the migration", () => {
    it.each(["globalPause", "enginePaused"] as const)("is inert while %s is set", async (gate) => {
      const h = harness([pausedTask({ id: "FN-G" })], {
        stalePausedTodoThresholdMs: CUSTOMIZED_MS,
        [gate]: true,
      });

      expect(await h.manager.surfaceStalePausedTodos()).toBe(0);
      expect(h.logEntry).not.toHaveBeenCalled();
    });
  });
});
