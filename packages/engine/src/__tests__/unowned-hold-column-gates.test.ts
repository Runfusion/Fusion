/*
FNXC:UnownedHoldColumnGates 2026-07-29-13:20 (U7 / R3, R12 — workflow-owned lifecycle):

Two lifecycle-column literals nobody's unit claimed, both asking "is this card in
the hold column?" by the id `"todo"`.

Picked up because the drift review's convergence count is what gates U11: the
merged Planning column KEEPS the id `todo` and DELETES `triage`, so a `=== "todo"`
comparison is not itself the breakage — but a workflow that renamed its hold column
is broken TODAY by both of these, and neither file appears in any unit's file list.

  gridlock-detector.ts  — `column !== "todo"` decides which cards count as
    SCHEDULABLE. On a renamed workflow nothing is ever schedulable, so the detector
    concludes there is no gridlock to report at exactly the moment a real one would
    be visible: it returns early on an empty schedulable set. A detector that goes
    quiet on the boards it cannot parse is worse than one that is absent, because
    its silence reads as health.

  mission-autopilot.ts  — `column !== "todo"` decides whether a retried mission task
    still needs moving. On a renamed workflow the answer is always "yes, move it",
    and the move TARGET is the literal `"todo"` too — so autopilot relocates the
    card into a column the workflow may not declare (R7) on every retry.

Both resolve the hold role from the task's own workflow. Both are async with store
access, so they resolve directly rather than needing the injected-lane pattern the
synchronous predicates required (#2551).
*/
import { describe, expect, it, vi } from "vitest";
import type { Task, TaskStore, WorkflowIr } from "@fusion/core";

import { GridlockDetector } from "../gridlock-detector.js";
import { MissionAutopilot } from "../mission-autopilot.js";

const WF = "custom:hold-vocab";

const DEFAULT_NAMES = { hold: "todo", wip: "in-progress" };
const RENAMED = { hold: "drafting", wip: "building" };

function ir(names: { hold: string; wip: string }): WorkflowIr {
  return {
    version: "v2",
    id: WF,
    name: WF,
    columns: [
      { id: "intake", name: "Intake", traits: [{ trait: "intake" }] },
      { id: names.hold, name: "Hold", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: names.wip, name: "Wip", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "done", name: "Done", traits: [{ trait: "complete" }] },
    ],
    nodes: [],
    edges: [],
  } as unknown as WorkflowIr;
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as Task;
}

function storeWith(tasks: Task[], workflowIr: WorkflowIr, settings: Record<string, unknown> = {}): TaskStore {
  const selection = { workflowId: WF, stepIds: [] };
  return {
    listTasks: vi.fn(async () => tasks),
    getTask: vi.fn(async (id: string) => tasks.find((t) => t.id === id)),
    getSettings: vi.fn(async () => ({ maxConcurrent: 2, ...settings })),
    getTaskWorkflowSelection: vi.fn(() => selection),
    getTaskWorkflowSelectionAsync: vi.fn(async () => selection),
    getWorkflowDefinition: vi.fn(async () => ({ ir: workflowIr })),
  } as unknown as TaskStore;
}

describe("gridlock detection counts schedulable cards by the hold ROLE", () => {
  /**
   * A board that IS gridlocked: cards waiting in the hold column, nothing active.
   * The detector must see the waiting cards to have anything to report.
   */
  async function schedulableSeen(names: { hold: string; wip: string }): Promise<boolean> {
    /*
    A genuinely gridlocked board, which needs all three of the detector's
    preconditions — my first fixture had only the first and failed on BOTH
    vocabularies, proving nothing:
      1. a schedulable card waiting in the hold column,
      2. at least one ACTIVE card (else the detector clears and returns early),
      3. a reason the waiting card cannot run — here an unmet dependency on the
         active card.
    */
    const blocker = task({ id: "FN-ACTIVE", column: names.wip });
    const waiting = task({ id: "FN-WAIT", column: names.hold, dependencies: ["FN-ACTIVE"] });
    const store = storeWith([waiting, blocker], ir(names));
    const detector = new GridlockDetector(store);

    // Two passes: the detector reports only once the condition has persisted.
    await detector.detectGridlock();
    const event = await detector.detectGridlock();
    return event !== null;
  }

  it("sees a waiting card under the DEFAULT vocabulary (no-regression half)", async () => {
    expect(await schedulableSeen(DEFAULT_NAMES)).toBe(true);
  });

  it("sees a waiting card under a RENAMED vocabulary", async () => {
    // Pre-conversion the filter matched nothing, the schedulable set was empty, and
    // the detector returned early — reporting "no gridlock" on a board where every
    // card was stuck. Silence that reads as health.
    expect(await schedulableSeen(RENAMED)).toBe(true);
  });
});

/*
FNXC:UnownedHoldColumnGates 2026-07-29-14:05:
Drives the REAL `MissionAutopilot.handleTaskFailure`. My first version of this block
re-implemented the resolve-and-move decision inline and asserted on the copy — which
proves only that the copy works, and is precisely the anti-pattern flagged in
docs/solutions/store-fake-defects-that-masquerade-as-production-bugs.md and in the
#2527 ratchet review. The constructor is two stores and the method is public, so
there was no excuse for the shortcut.
*/
describe("mission autopilot retries into the workflow's own hold column", () => {
  /** Minimal mission graph so `handleTaskFailure` reaches its retry branch. */
  function missionStoreFor(taskId: string) {
    return {
      getFeatureByTaskId: vi.fn(async () => ({ id: "feat-1", sliceId: "slice-1", taskId })),
      getSlice: vi.fn(async () => ({ id: "slice-1", milestoneId: "ms-1" })),
      getMilestone: vi.fn(async () => ({ id: "ms-1", missionId: "mission-1" })),
      updateFeatureStatus: vi.fn(async () => undefined),
      recordEvent: vi.fn(async () => undefined),
    } as never;
  }

  /** The store after a real retry, for asserting what it did and did not do. */
  async function retryStoreFor(
    names: { hold: string; wip: string },
    opts: { declaresHold?: boolean } = { declaresHold: true },
  ): Promise<TaskStore> {
    const failed = task({ id: "FN-RETRY", column: names.wip, status: "failed" });
    const workflowIr = opts.declaresHold
      ? ir(names)
      : ({
        version: "v2", id: WF, name: WF, nodes: [], edges: [],
        columns: [
          { id: names.wip, name: "Wip", traits: [{ trait: "wip" }] },
          { id: "done", name: "Done", traits: [{ trait: "complete" }] },
        ],
      } as unknown as WorkflowIr);
    const store = storeWith([failed], workflowIr);
    (store as unknown as Record<string, unknown>).moveTask = vi.fn(async () => undefined);
    (store as unknown as Record<string, unknown>).updateTask = vi.fn(async () => undefined);
    const autopilot = new MissionAutopilot(store, missionStoreFor("FN-RETRY"));
    (autopilot as unknown as { watchedMissions: Map<string, unknown> })
      .watchedMissions.set("mission-1", {});
    await autopilot.handleTaskFailure("FN-RETRY");
    return store;
  }

  /** Where did a real retry move the card, if anywhere? */
  async function retryTarget(
    names: { hold: string; wip: string },
    opts: { declaresHold?: boolean } = { declaresHold: true },
  ): Promise<string | undefined> {
    const failed = task({ id: "FN-RETRY", column: names.wip, status: "failed" });
    const workflowIr = opts.declaresHold
      ? ir(names)
      : ({
        version: "v2", id: WF, name: WF, nodes: [], edges: [],
        columns: [
          { id: names.wip, name: "Wip", traits: [{ trait: "wip" }] },
          { id: "done", name: "Done", traits: [{ trait: "complete" }] },
        ],
      } as unknown as WorkflowIr);
    const store = storeWith([failed], workflowIr);
    const moved: string[] = [];
    (store as unknown as Record<string, unknown>).moveTask =
      vi.fn(async (_id: string, column: string) => { moved.push(column); });
    (store as unknown as Record<string, unknown>).updateTask = vi.fn(async () => undefined);

    const autopilot = new MissionAutopilot(store, missionStoreFor("FN-RETRY"));
    /*
    `handleTaskFailure` returns early unless the mission is watched, and
    `watchMission` is async + goes through `getMission`/event logging. Seeding the
    watched set directly keeps this test on the branch under test rather than on
    autopilot's subscription machinery.
    */
    (autopilot as unknown as { watchedMissions: Map<string, unknown> })
      .watchedMissions.set("mission-1", {});
    await autopilot.handleTaskFailure("FN-RETRY");

    return moved[0];
  }

  it("moves a retried card to the DEFAULT hold column (no-regression half)", async () => {
    expect(await retryTarget(DEFAULT_NAMES)).toBe("todo");
  });

  it("moves a retried card to a RENAMED hold column, not the literal", async () => {
    // Pre-conversion autopilot moved it to `todo` — a column this workflow does not
    // declare — on EVERY retry, which is the R7 violation by repetition.
    const target = await retryTarget(RENAMED);
    expect(target).toBe("drafting");
    expect(target).not.toBe("todo");
  });

  it("does NOT move the card, and leaves it visibly FAILED, when the workflow declares no hold column", async () => {
    /*
    FNXC:UnownedHoldColumnGates 2026-07-29-20:10 (PR #2561 review — greptile P1):
    My first version cleared the failure state and left the card in WIP, reasoning
    that "the retry is not lost". It is: the hold-release sweep only dispatches out
    of HOLD columns, so a card left in WIP is never picked up again — clearing its
    error turned a visible failure into a SILENT STALL, a row that is not failed,
    not running, and never will be. Strictly worse than the R7 move it replaced.

    Leaving the failure intact is the correct trade: an operator can act on a failed
    card, and nothing can act on a clean-looking abandoned one.
    */
    const store = await retryStoreFor({ hold: "unused", wip: "building" }, { declaresHold: false });

    expect(store.moveTask).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
