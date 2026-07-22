import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Task } from "@fusion/core";

const mocked = vi.hoisted(() => ({
  classifyForeignOnlyContamination: vi.fn(),
  recoverForeignOnlyContamination: vi.fn(),
}));

vi.mock("../execution/branch-conflicts.js", async () => {
  const actual = await vi.importActual<typeof import("../execution/branch-conflicts.js")>("../branch-conflicts.js");
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
