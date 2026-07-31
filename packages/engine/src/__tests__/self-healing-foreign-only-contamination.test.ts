import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Task } from "@fusion/core";

const mocked = vi.hoisted(() => ({
  classifyForeignOnlyContamination: vi.fn(),
  recoverForeignOnlyContamination: vi.fn(),
}));

vi.mock("../branch-conflicts.js", async () => {
  const actual = await vi.importActual<typeof import("../branch-conflicts.js")>("../branch-conflicts.js");
  return {
    ...actual,
    classifyForeignOnlyContamination: mocked.classifyForeignOnlyContamination,
  };
});

vi.mock("../recovery/foreign-only-contamination.js", () => ({
  recoverForeignOnlyContamination: mocked.recoverForeignOnlyContamination,
}));

import { SelfHealingManager } from "../self-healing.js";

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    column: "in-review",
    branch: "fusion/fn-1",
    worktree: "/tmp/wt",
    baseCommitSha: "main",
    paused: false,
    userPaused: false,
    mergeDetails: null,
    steps: [],
    ...overrides,
  } as Task;
}

describe("SelfHealingManager.recoverForeignOnlyContaminatedInReviewTasks", () => {
  const store = {
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    listTasks: vi.fn(),
    logEntry: vi.fn(async () => {}),
    on: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-18:50:
  `contaminationWipColumns` was UNCOVERED on the #3115 map. Every case in this file seeds the
  candidate in `in-review`, so only the review bucket is exercised and blinding the WIP resolver back
  to `["in-progress"]` leaves the file green.

  The WIP bucket is a real source of candidates: a card sent back for a fix re-enters execution while
  its branch still carries the foreign commits, so contamination is discovered there as often as in
  review. Keyed on the id that bucket read nothing on a renamed board, and the card kept a branch
  built on someone else's work — which is what this sweep exists to re-anchor.
  */
  it("recovers a foreign-only candidate resting in a RENAMED wip lane", async () => {
    store.listTasks.mockImplementation(async ({ column }: { column: string }) => (
      column === "building"
        ? [mkTask({ id: "FN-WIP", column: "building", paused: true, pausedReason: "branch-cross-contamination" })]
        : []
    ));
    const RENAMED_IR = {
      version: "v2",
      id: "custom:renamed",
      nodes: [],
      edges: [],
      columns: [
        { id: "building", name: "building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
        { id: "checking", name: "checking", traits: [{ trait: "merge" }] },
      ],
    };
    /*
    The per-task readers are REQUIRED, not incidental. This sweep is an ACTION site: it deliberately
    SKIPS a card whose own board cannot be read rather than guessing from the project union, so a fake
    with only `listWorkflowDefinitions` resolves the default IR, the card is reported unresolvable, and
    the case would fail for a reason that has nothing to do with the resolver under test.
    */
    store.listWorkflowDefinitions = vi.fn(async () => [{ id: "custom:renamed", ir: RENAMED_IR }]);
    store.getTaskWorkflowSelection = vi.fn(() => ({ workflowId: "custom:renamed", stepIds: [] }));
    store.getTaskWorkflowSelectionAsync = vi.fn(async () => ({ workflowId: "custom:renamed", stepIds: [] }));
    store.getWorkflowDefinition = vi.fn(async () => ({ ir: RENAMED_IR }));
    mocked.classifyForeignOnlyContamination.mockResolvedValue({ kind: "foreign-only-no-own-work" });
    mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: true, subtype: "reanchor" });

    const manager = new SelfHealingManager(store, { rootDir: process.cwd() });

    expect(await manager.recoverForeignOnlyContaminatedInReviewTasks()).toBe(1);
    expect(mocked.recoverForeignOnlyContamination).toHaveBeenCalledOnce();
  });

  it("recovers foreign-only in-review candidates", async () => {
    store.listTasks.mockImplementation(async ({ column }: { column: string }) => column === "in-review" ? [mkTask()] : []);
    mocked.classifyForeignOnlyContamination.mockResolvedValue({ kind: "foreign-only-no-own-work" });
    mocked.recoverForeignOnlyContamination.mockResolvedValue({ recovered: true, subtype: "reanchor" });

    const manager = new SelfHealingManager(store, { rootDir: process.cwd() });
    const recovered = await manager.recoverForeignOnlyContaminatedInReviewTasks();

    expect(recovered).toBe(1);
    expect(mocked.recoverForeignOnlyContamination).toHaveBeenCalledOnce();
  });

  it("skips ambiguous and user-paused tasks", async () => {
    store.listTasks.mockImplementation(async ({ column }: { column: string }) => {
      if (column === "in-review") return [mkTask({ id: "FN-2", userPaused: true }), mkTask({ id: "FN-3" })];
      return [];
    });
    mocked.classifyForeignOnlyContamination.mockResolvedValue({ kind: "ambiguous" });

    const manager = new SelfHealingManager(store, { rootDir: process.cwd() });
    const recovered = await manager.recoverForeignOnlyContaminatedInReviewTasks();

    expect(recovered).toBe(0);
    expect(mocked.recoverForeignOnlyContamination).not.toHaveBeenCalled();
  });
});
