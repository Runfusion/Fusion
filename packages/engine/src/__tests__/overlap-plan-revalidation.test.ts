import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverlapWaitDeliverySnapshot, Task, TaskOverlapWait, TaskStore } from "@fusion/core";

const releaseFileScopeWaitingContinuations = vi.fn(async () => [] as string[]);
vi.mock("../runtimes/in-process-runtime.js", () => ({
  releaseFileScopeWaitingContinuations: (...args: unknown[]) => releaseFileScopeWaitingContinuations(...(args as [never, never])),
}));

const { resolvePendingOverlapWaits, hasPendingOverlapWaits } = await import("../workflows/overlap-plan-revalidation.js");

function episode(patch: Partial<TaskOverlapWait> & { deliveries?: OverlapWaitDeliverySnapshot[] } = {}): TaskOverlapWait {
  const { deliveries, ...rest } = patch;
  return {
    projectId: "p",
    taskId: "FN-WAITING",
    episodeId: "episode-1",
    blockerTaskId: "FN-A",
    observedAt: "2026-09-01T00:00:00.000Z",
    phase: "observed",
    revision: 1,
    attempt: 0,
    observation: deliveries ? { deliveries } : {},
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...rest,
  };
}

function fakeStore(overrides: Partial<TaskStore> = {}): TaskStore {
  return {
    listTaskOverlapWaits: vi.fn(async () => []),
    claimTaskOverlapWait: vi.fn(async () => null),
    completeTaskOverlapWait: vi.fn(async () => null),
    ...overrides,
  } as unknown as TaskStore;
}

const task = { id: "FN-WAITING", lineageId: "lineage-1", worktree: "/work", branch: "fusion/fn-waiting" };

describe("resolvePendingOverlapWaits", () => {
  afterEach(() => {
    releaseFileScopeWaitingContinuations.mockClear();
  });

  it("returns empty when the store lacks overlap-wait methods", async () => {
    const store = {} as TaskStore;
    expect(await resolvePendingOverlapWaits({ store, task, owner: "graph:FN-WAITING" })).toEqual([]);
    expect(await hasPendingOverlapWaits(store, task.id)).toBe(false);
  });

  it("decides resume when the claimed episode has no delivered files at all", async () => {
    const pending = episode();
    const claimed = { ...pending, phase: "analyzing" as const, revision: 2 };
    const store = fakeStore({
      listTaskOverlapWaits: vi.fn(async () => [pending]),
      claimTaskOverlapWait: vi.fn(async () => claimed),
      completeTaskOverlapWait: vi.fn(async (input) => ({ ...claimed, ...input, phase: "delivered" as const })),
    });

    const resolved = await resolvePendingOverlapWaits({ store, task, owner: "graph:FN-WAITING" });

    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decision: "resume", episodeId: "episode-1" });
    expect(store.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ phase: "delivered", receipt: expect.objectContaining({ decision: "resume", commonFiles: [] }) }));
    expect(releaseFileScopeWaitingContinuations).toHaveBeenCalledWith(store, [{ taskId: "FN-WAITING", blockerId: "FN-A" }]);
  });

  it("decides briefing when overlapping files were delivered with a proven landed sha", async () => {
    const deliveries: OverlapWaitDeliverySnapshot[] = [{
      blockerTaskId: "FN-A", repository: ".", landedSha: "sha-1", evidence: "merge-details",
      paths: [{ repository: ".", path: "src/shared.ts", status: "modified" }],
    }];
    const pending = episode({ observation: { deliveries } });
    const claimed = { ...pending, phase: "analyzing" as const, revision: 2 };
    const store = fakeStore({
      listTaskOverlapWaits: vi.fn(async () => [pending]),
      claimTaskOverlapWait: vi.fn(async () => claimed),
      completeTaskOverlapWait: vi.fn(async (input) => ({ ...claimed, ...input, phase: "delivered" as const })),
    });

    const resolved = await resolvePendingOverlapWaits({ store, task, owner: "graph:FN-WAITING" });

    expect(resolved[0]?.decision).toBe("briefing");
    expect(resolved[0]?.receipt.briefing).toContain("FN-A delivered src/shared.ts");
    expect(resolved[0]?.receipt.freshness).toBe("proven");
  });

  it("decides revalidate when overlapping files were delivered without provable freshness, and does not release continuations", async () => {
    const deliveries: OverlapWaitDeliverySnapshot[] = [{
      blockerTaskId: "FN-A", repository: ".", evidence: "unavailable",
      paths: [{ repository: ".", path: "src/shared.ts", status: "modified" }],
    }];
    const pending = episode({ observation: { deliveries } });
    const claimed = { ...pending, phase: "analyzing" as const, revision: 2 };
    const store = fakeStore({
      listTaskOverlapWaits: vi.fn(async () => [pending]),
      claimTaskOverlapWait: vi.fn(async () => claimed),
      completeTaskOverlapWait: vi.fn(async (input) => ({ ...claimed, ...input })),
    });

    const resolved = await resolvePendingOverlapWaits({ store, task, owner: "graph:FN-WAITING" });

    expect(resolved[0]?.decision).toBe("revalidate");
    expect(store.completeTaskOverlapWait).toHaveBeenCalledWith(expect.objectContaining({ phase: "revalidation-pending" }));
    expect(releaseFileScopeWaitingContinuations).not.toHaveBeenCalled();
  });

  it("skips an episode whose claim loses the ownership race", async () => {
    const pending = episode();
    const store = fakeStore({
      listTaskOverlapWaits: vi.fn(async () => [pending]),
      claimTaskOverlapWait: vi.fn(async () => null),
    });

    const resolved = await resolvePendingOverlapWaits({ store, task, owner: "graph:FN-WAITING" });

    expect(resolved).toEqual([]);
    expect(store.completeTaskOverlapWait).not.toHaveBeenCalled();
  });
});
