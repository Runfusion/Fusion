import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessRuntime } from "../../runtimes/in-process-runtime.js";

function makeExecutor(overrides: Record<string, unknown> = {}) {
  return {
    activeWorktrees: new Map(),
    abortAllSessionBash: vi.fn(),
    abortAllInFlight: vi.fn().mockResolvedValue(undefined),
    disposeEphemeralTimers: vi.fn(),
    ...overrides,
  };
}

describe("FN-5403 reliability interactions: engine stop aborts execution", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("FN-5403: engine stop aborts executor AI sessions before drain completes", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    let aborted = false;
    let disposed = false;
    runtime.status = "active";
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 1 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor({
      abortAllInFlight: vi.fn().mockImplementation(async () => {
        aborted = true;
        disposed = true;
      }),
    });

    await runtime.stop();
    expect(aborted).toBe(true);
    expect(disposed).toBe(true);
  });

  it("FN-5403: engine stop does not wait the legacy 30 s for natural completion", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 10 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor({ activeWorktrees: new Map([["FN-1", { taskId: "FN-1" }]]) });

    const stopPromise = runtime.stop();
    await vi.advanceTimersByTimeAsync(50);
    await expect(stopPromise).resolves.toBeUndefined();
  });

  it("FN-5403: engine stop interacts with TriageProcessor.stop", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    const triageSessions = new Map([["FN-T", {}]]);
    runtime.triageProcessor = { stop: vi.fn().mockImplementation(() => triageSessions.clear()) };
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 0 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor();

    await runtime.stop();
    expect(runtime.triageProcessor.stop).toHaveBeenCalledTimes(1);
    expect(runtime.executor.abortAllInFlight).toHaveBeenCalledWith("engine stop");
    expect(triageSessions.size).toBe(0);
  });

  it("FN-5403: engine stop preserves task:moved cleanup contract", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    const updateTask = vi.fn();
    const moveTask = vi.fn();
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 0 }), updateTask, moveTask };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor();

    await runtime.stop();
    expect(updateTask).not.toHaveBeenCalled();
    expect(moveTask).not.toHaveBeenCalled();
  });

  it("FN-5403: engine stop with runtimeStopDrainMs=0 still aborts before exiting", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    runtime.status = "active";
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    runtime.taskStore = { getSettings: vi.fn().mockResolvedValue({ runtimeStopDrainMs: 0 }) };
    runtime.pluginRunner = { shutdown: vi.fn().mockResolvedValue(undefined) };
    runtime.worktreePool = { drain: vi.fn().mockReturnValue([]) };
    runtime.executor = makeExecutor({ activeWorktrees: new Map([["FN-1", { taskId: "FN-1" }]]) });

    await runtime.stop();
    expect(runtime.executor.abortAllInFlight).toHaveBeenCalledWith("engine stop");
    expect(timeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 500);
  });

  it("releases the PostgreSQL backend exactly once when an earlier cleanup step fails", async () => {
    const runtime = new InProcessRuntime({ projectId: "p", workingDirectory: "/tmp", isolationMode: "in-process" } as any, {} as any) as any;
    const backendShutdown = vi.fn().mockResolvedValue(undefined);
    runtime.status = "active";
    runtime.backendShutdown = backendShutdown;
    runtime.taskStore = { getSettings: vi.fn().mockRejectedValue(new Error("settings unavailable")) };
    runtime.executor = makeExecutor();

    await expect(runtime.stop()).rejects.toThrow("settings unavailable");
    expect(backendShutdown).toHaveBeenCalledTimes(1);

    await runtime.stop().catch(() => undefined);
    expect(backendShutdown).toHaveBeenCalledTimes(1);
  });
});
