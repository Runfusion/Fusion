import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CentralCore, RegisteredProject } from "@fusion/core";
import { HybridExecutor } from "../concurrency/hybrid-executor.js";
import { shouldUseHybridExecutor } from "../concurrency/hybrid-executor-gate.js";

const projectManagerState = vi.hoisted(() => ({
  projectIds: [] as string[],
  stopAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../project/project-manager.js", () => ({
  ProjectManager: vi.fn().mockImplementation(function () {
    return {
    on: vi.fn(),
    addProject: vi.fn().mockImplementation(async (config: { projectId: string }) => {
      projectManagerState.projectIds.push(config.projectId);
    }),
    getProjectIds: vi.fn().mockImplementation(() => [...projectManagerState.projectIds]),
    stopAll: projectManagerState.stopAll,
    };
  }),
}));

vi.mock("../project/node-health-monitor.js", () => ({
  NodeHealthMonitor: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

function createCentralCore(overrides?: {
  listNodes?: () => Promise<Array<{ id: string; type: "local" | "remote" }>>;
  listProjects?: () => Promise<RegisteredProject[]>;
}): CentralCore {
  const now = new Date().toISOString();
  const baseProject = {
    id: "proj-1",
    name: "Project 1",
    path: "/tmp/proj-1",
    status: "active",
    isolationMode: "in-process",
    createdAt: now,
    updatedAt: now,
  } as RegisteredProject;

  return {
    listNodes: overrides?.listNodes ?? (async () => [{ id: "local", type: "local" }]),
    listProjects: overrides?.listProjects ?? (async () => [baseProject]),
    getProject: vi.fn().mockResolvedValue(baseProject),
    resolveLocalProjectWorkingDirectory: vi.fn().mockResolvedValue("/tmp/proj-1"),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  } as unknown as CentralCore;
}

describe("hybrid executor startup integration", () => {
  const originalEnv = process.env.FUSION_HYBRID_EXECUTOR;

  beforeEach(() => {
    projectManagerState.projectIds.length = 0;
    projectManagerState.stopAll.mockClear();
    delete process.env.FUSION_HYBRID_EXECUTOR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.FUSION_HYBRID_EXECUTOR;
    else process.env.FUSION_HYBRID_EXECUTOR = originalEnv;
  });

  it("disables gate for local-only single-node setup", async () => {
    const central = createCentralCore();
    await expect(shouldUseHybridExecutor(central)).resolves.toEqual({
      enabled: false,
      reason: "single-node-local-only",
    });
  });

  it("enables and initializes via env override", async () => {
    process.env.FUSION_HYBRID_EXECUTOR = "1";
    const central = createCentralCore();
    await expect(shouldUseHybridExecutor(central)).resolves.toEqual({ enabled: true, reason: "env-override" });

    const executor = new HybridExecutor(central);
    await executor.initialize();

    expect(executor.getProjectIds()).toContain("proj-1");
    expect(executor.getNodeHealthMonitor()).not.toBeNull();
  });

  it("enables gate for multi-node", async () => {
    const central = createCentralCore({
      listNodes: async () => [
        { id: "local", type: "local" },
        { id: "remote", type: "remote" },
      ],
    });

    await expect(shouldUseHybridExecutor(central)).resolves.toEqual({ enabled: true, reason: "multi-node" });
  });

  it("shutdown clears initialized state", async () => {
    const central = createCentralCore();
    const executor = new HybridExecutor(central);
    await executor.initialize();
    expect(executor.isInitialized()).toBe(true);

    await executor.shutdown();
    expect(executor.isInitialized()).toBe(false);
  });
});
