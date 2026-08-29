import { afterEach, describe, expect, it, vi } from "vitest";
import type { CentralCore } from "@fusion/core";
import { shouldUseHybridExecutor } from "../concurrency/hybrid-executor-gate.js";

function createMockCentralCore(overrides?: {
  listNodes?: () => Promise<Array<{ id: string; type: "local" | "remote" }>>;
  listProjects?: () => Promise<Array<{ status: "active" | "initializing" | "paused" | "errored" }>>;
}): CentralCore {
  return {
    listNodes: overrides?.listNodes ?? (async () => [{ id: "local", type: "local" }]),
    listProjects: overrides?.listProjects ?? (async () => [{ status: "active" }]),
  } as unknown as CentralCore;
}

describe("shouldUseHybridExecutor", () => {
  const originalEnv = process.env.FUSION_HYBRID_EXECUTOR;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.FUSION_HYBRID_EXECUTOR;
    } else {
      process.env.FUSION_HYBRID_EXECUTOR = originalEnv;
    }
  });

  it("enables via env override=1", async () => {
    process.env.FUSION_HYBRID_EXECUTOR = "1";
    const decision = await shouldUseHybridExecutor(createMockCentralCore());
    expect(decision).toEqual({ enabled: true, reason: "env-override" });
  });

  it("disables via env override=0", async () => {
    process.env.FUSION_HYBRID_EXECUTOR = "0";
    const decision = await shouldUseHybridExecutor(createMockCentralCore());
    expect(decision).toEqual({ enabled: false, reason: "env-override" });
  });

  it("enables for multi-node", async () => {
    delete process.env.FUSION_HYBRID_EXECUTOR;
    const decision = await shouldUseHybridExecutor(
      createMockCentralCore({
        listNodes: async () => [
          { id: "local", type: "local" },
          { id: "remote", type: "remote" },
        ],
      }),
    );
    expect(decision).toEqual({ enabled: true, reason: "multi-node" });
  });

  it("does NOT enable for local-only multi-project (ProjectEngineManager handles it)", async () => {
    delete process.env.FUSION_HYBRID_EXECUTOR;
    const decision = await shouldUseHybridExecutor(
      createMockCentralCore({
        listProjects: async () => [{ status: "active" }, { status: "initializing" }],
      }),
    );
    // HybridExecutor's value is cross-node routing. Local-only N-project
    // setups don't need it — running it duplicates InProcessRuntime creation.
    expect(decision).toEqual({ enabled: false, reason: "single-node-local-only" });
  });

  it("disables for local-only single-node setup", async () => {
    delete process.env.FUSION_HYBRID_EXECUTOR;
    const decision = await shouldUseHybridExecutor(createMockCentralCore());
    expect(decision).toEqual({ enabled: false, reason: "single-node-local-only" });
  });

  it("disables when central APIs throw", async () => {
    delete process.env.FUSION_HYBRID_EXECUTOR;
    const centralCore = createMockCentralCore({
      listNodes: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const decision = await shouldUseHybridExecutor(centralCore);
    expect(decision).toEqual({ enabled: false, reason: "central-unavailable" });
  });
});
