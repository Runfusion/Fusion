import { describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import {
  handleWorktrunkOperationFailure,
  type WorktrunkOperationFailure,
  type WorktreeOperationResult,
} from "../worktree/worktrunk-failure-handler.js";
import {
  WorktrunkBinaryUnavailableError,
  WorktrunkInstallDeniedError,
  WorktrunkInstallFailedError,
} from "../worktree/worktrunk-installer.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-4625",
    description: "task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

function makeFailure(cause: Error, stderr = "boom", exitCode: number | null = 1): WorktrunkOperationFailure {
  return { op: "create", cause, stderr, exitCode };
}

describe("handleWorktrunkOperationFailure", () => {
  it("fail mode pauses, persists details, audits, and rethrows", async () => {
    const pauseTask = vi.fn().mockResolvedValue(undefined);
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const git = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const cause = new Error("create failed");

    await expect(handleWorktrunkOperationFailure({
      failure: makeFailure(cause),
      task: makeTask(),
      settings: { enabled: true, onFailure: "fail" },
      store: { pauseTask, updateTask } as any,
      runContext: { runId: "run-1", agentId: "agent-1" },
      runAudit: { git },
      notify,
    })).rejects.toThrow("create failed");

    expect(pauseTask).toHaveBeenCalledWith("FN-4625", true, expect.any(Object));
    expect(updateTask).toHaveBeenCalledWith(
      "FN-4625",
      expect.objectContaining({
        pausedReason: "worktrunk_operation_failed",
        worktrunkFailure: expect.objectContaining({ op: "create", stderr: "boom", exitCode: 1 }),
      }),
      expect.any(Object),
    );
    expect(git).toHaveBeenCalledWith(expect.objectContaining({ type: "worktree:worktrunk-failure" }));
    expect(notify).not.toHaveBeenCalled();
  });

  it("fallback-native calls nativeFallback, notifies once, audits, and returns result", async () => {
    const pauseTask = vi.fn();
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const git = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn().mockResolvedValue(undefined);
    const result: WorktreeOperationResult = { path: "/tmp/wt", branch: "fusion/fn-4625" };
    const nativeFallback = vi.fn().mockResolvedValue(result);

    const disposition = await handleWorktrunkOperationFailure({
      failure: makeFailure(new Error("create failed")),
      task: makeTask(),
      settings: { enabled: true, onFailure: "fallback-native" },
      store: { pauseTask, updateTask } as any,
      runAudit: { git },
      notify,
      nativeFallback,
    });

    expect(disposition).toEqual({ kind: "fallback-native", result, alerted: true });
    expect(updateTask).toHaveBeenCalledWith("FN-4625", expect.objectContaining({ worktrunkFallbackAlertedAt: expect.any(String) }), undefined);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(git).toHaveBeenCalledWith(expect.objectContaining({ type: "worktree:worktrunk-fallback-native" }));
    expect(pauseTask).not.toHaveBeenCalled();
  });

  it("fallback-native does not re-alert when already alerted", async () => {
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const notify = vi.fn();
    const nativeFallback = vi.fn().mockResolvedValue(undefined);

    const disposition = await handleWorktrunkOperationFailure({
      failure: makeFailure(new Error("create failed")),
      task: makeTask({ worktrunkFallbackAlertedAt: "2026-05-15T00:00:00.000Z" }),
      settings: { enabled: true, onFailure: "fallback-native" },
      store: { pauseTask: vi.fn(), updateTask } as any,
      notify,
      nativeFallback,
    });

    expect(disposition).toEqual({ kind: "fallback-native", result: undefined, alerted: false });
    expect(notify).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalledWith("FN-4625", expect.objectContaining({ worktrunkFallbackAlertedAt: expect.any(String) }), undefined);
  });

  it("fallback-native without nativeFallback degrades to fail-hard", async () => {
    const pauseTask = vi.fn().mockResolvedValue(undefined);
    const updateTask = vi.fn().mockResolvedValue(undefined);
    const cause = new Error("create failed");

    await expect(handleWorktrunkOperationFailure({
      failure: makeFailure(cause),
      task: makeTask(),
      settings: { enabled: true, onFailure: "fallback-native" },
      store: { pauseTask, updateTask } as any,
      notify: vi.fn(),
    })).rejects.toThrow("create failed");

    expect(pauseTask).toHaveBeenCalledTimes(1);
    expect(updateTask).toHaveBeenCalledWith("FN-4625", expect.objectContaining({ pausedReason: "worktrunk_operation_failed" }), undefined);
  });

  it("native fallback errors are rethrown", async () => {
    const fallbackError = new Error("native failed");
    await expect(handleWorktrunkOperationFailure({
      failure: makeFailure(new Error("create failed")),
      task: makeTask(),
      settings: { enabled: true, onFailure: "fallback-native" },
      store: { pauseTask: vi.fn(), updateTask: vi.fn().mockResolvedValue(undefined) } as any,
      notify: vi.fn(),
      nativeFallback: vi.fn().mockRejectedValue(fallbackError),
    })).rejects.toThrow("native failed");
  });

  it("truncates stderr preview to 4KB in run-audit metadata", async () => {
    const git = vi.fn().mockResolvedValue(undefined);
    const longStderr = "x".repeat(5000);
    await expect(handleWorktrunkOperationFailure({
      failure: makeFailure(new Error("create failed"), longStderr),
      task: makeTask(),
      settings: { enabled: true, onFailure: "fail" },
      store: { pauseTask: vi.fn().mockResolvedValue(undefined), updateTask: vi.fn().mockResolvedValue(undefined) } as any,
      runAudit: { git },
      notify: vi.fn(),
    })).rejects.toThrow();

    const call = git.mock.calls.find((entry) => entry[0]?.type === "worktree:worktrunk-failure");
    expect(call?.[0]?.metadata?.stderrPreview.length).toBe(4097);
    expect(call?.[0]?.metadata?.stderrPreview.endsWith("…")).toBe(true);
  });

  it.each([
    new WorktrunkBinaryUnavailableError("missing"),
    new WorktrunkInstallFailedError("install failed", { stage: "release" }),
    new WorktrunkInstallDeniedError("denied"),
  ])("handles installer error class %s in fail-hard mode", async (cause) => {
    await expect(handleWorktrunkOperationFailure({
      failure: makeFailure(cause, cause.message),
      task: makeTask(),
      settings: { enabled: true, onFailure: "fail" },
      store: { pauseTask: vi.fn().mockResolvedValue(undefined), updateTask: vi.fn().mockResolvedValue(undefined) } as any,
      notify: vi.fn(),
    })).rejects.toBe(cause);
  });
});
