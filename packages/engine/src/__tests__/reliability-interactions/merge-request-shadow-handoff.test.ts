import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { SelfHealingManager } from "../../self-healing.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-5741-T",
    title: "t",
    description: "d",
    column: "in-progress",
    dependencies: [],
    steps: [{ id: "1", title: "s", status: "done" as const }],
    log: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe("FN-5741 reliability interactions: shadow handoff writes", () => {
  it("flag OFF performs no shadow writes", async () => {
    const task = makeTask({ autoMerge: true });
    const store: any = {
      handoffToReview: vi.fn(async () => ({ ...task, column: "in-review" })),
      getSettings: vi.fn(async () => ({ mergeRequestContractShadowEnabled: false })),
      setCompletionHandoffAcceptedMarker: vi.fn(),
      upsertMergeRequestRecord: vi.fn(),
    };

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    await (manager as any).handoffTaskToReview(task.id, "test");

    expect(store.setCompletionHandoffAcceptedMarker).not.toHaveBeenCalled();
    expect(store.upsertMergeRequestRecord).not.toHaveBeenCalled();
    manager.stop();
  });

  it("flag ON writes marker + queued record after handoff", async () => {
    const task = makeTask({ autoMerge: true });
    const store: any = {
      handoffToReview: vi.fn(async () => ({ ...task, column: "in-review" })),
      getSettings: vi.fn(async () => ({ mergeRequestContractShadowEnabled: true })),
      setCompletionHandoffAcceptedMarker: vi.fn(),
      upsertMergeRequestRecord: vi.fn(),
    };

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    await (manager as any).handoffTaskToReview(task.id, "test");

    expect(store.handoffToReview).toHaveBeenCalledOnce();
    expect(store.setCompletionHandoffAcceptedMarker).toHaveBeenCalledWith(task.id, { source: "self-healing:test" });
    expect(store.upsertMergeRequestRecord).toHaveBeenCalledWith(task.id, { state: "queued" });
    expect(store.handoffToReview.mock.invocationCallOrder[0]).toBeLessThan(store.setCompletionHandoffAcceptedMarker.mock.invocationCallOrder[0]);
    manager.stop();
  });

  it("autoMerge false writes manual-required and never running", async () => {
    const task = makeTask({ autoMerge: false });
    const store: any = {
      handoffToReview: vi.fn(async () => ({ ...task, column: "in-review" })),
      getSettings: vi.fn(async () => ({ mergeRequestContractShadowEnabled: true })),
      setCompletionHandoffAcceptedMarker: vi.fn(),
      upsertMergeRequestRecord: vi.fn(),
      transitionMergeRequestState: vi.fn(),
    };

    const manager = new SelfHealingManager(store, { rootDir: "/repo" });
    await (manager as any).handoffTaskToReview(task.id, "test");

    expect(store.upsertMergeRequestRecord).toHaveBeenCalledWith(task.id, { state: "manual-required" });
    expect(store.transitionMergeRequestState).not.toHaveBeenCalled();
    manager.stop();
  });
});
