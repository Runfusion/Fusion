import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { createMockStore, mockedExecSync, mockedExistsSync, resetExecutorMocks } from "./executor-test-helpers.js";

describe("FN-009: verifyWorktreeInvariants with missing worktree directory", () => {
  let executor: TaskExecutor;
  let store: ReturnType<typeof createMockStore>;

  beforeEach(() => {
    resetExecutorMocks();
    store = createMockStore();
    executor = new TaskExecutor(store as any, "/repo");
  });

  it("returns success when worktree directory does not exist", async () => {
    const task = {
      id: "FN-9001",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/repo/.worktrees/missing",
      branch: "fusion/fn-9001",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);

    // Mock existsSync to return false for the worktree path
    mockedExistsSync.mockImplementation((path: any) => {
      if (path === "/repo/.worktrees/missing") {
        return false;
      }
      return true;
    });

    // Access the private method using type assertion
    const result = await (executor as any).verifyWorktreeInvariants(task);

    expect(result.ok).toBe(true);
  });

  it("does not skip validation when worktree directory exists", async () => {
    const task = {
      id: "FN-9002",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/repo/.worktrees/existing",
      branch: "fusion/fn-9002",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    // Mock existsSync to return true for the worktree path
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      return Buffer.from("");
    });

    const result = await (executor as any).verifyWorktreeInvariants(task);

    // When worktree exists, validation proceeds normally.
    // The exact result depends on git command mocks, but we verify
    // that the function doesn't return early with { ok: true } due to missing directory.
    // We verify that existsSync was called by checking it was configured.
    expect(mockedExistsSync).toHaveBeenCalled();
    expect(mockedExecSync).toHaveBeenCalled();
    expect(result).not.toEqual({ ok: true });
    expect(result).toMatchObject({ ok: false, reason: "wrong_toplevel" });
  });

  it("re-anchors nested task worktree to registered root and passes invariants", async () => {
    const task = {
      id: "FN-9004",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/repo/.worktrees/gentle-flame/packages/core",
      branch: "fusion/fn-9004",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo/.worktrees/gentle-flame\n");
      if (cmd.includes("worktree list --porcelain")) {
        return Buffer.from("worktree /repo\nbranch refs/heads/main\n\nworktree /repo/.worktrees/gentle-flame\nbranch refs/heads/fusion/fn-9004\n");
      }
      if (cmd.includes("rev-parse --abbrev-ref HEAD")) return Buffer.from("fusion/fn-9004\n");
      if (cmd.includes("rev-list --count")) return Buffer.from("1\n");
      return Buffer.from("");
    });

    const result = await (executor as any).verifyWorktreeInvariants(task);

    expect(result).toEqual({ ok: true });
    expect(store.updateTask).toHaveBeenCalledWith("FN-9004", { worktree: "/repo/.worktrees/gentle-flame" });
  });

  it("preserves wrong_toplevel for non-reanchorable mismatch", async () => {
    const task = {
      id: "FN-9005",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/repo/.worktrees/gentle-flame/packages/core",
      branch: "fusion/fn-9005",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    mockedExistsSync.mockReturnValue(true);
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes("rev-parse --show-toplevel")) return Buffer.from("/repo\n");
      return Buffer.from("");
    });

    const result = await (executor as any).verifyWorktreeInvariants(task);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_toplevel");
    expect(store.updateTask).not.toHaveBeenCalledWith("FN-9005", expect.objectContaining({ worktree: expect.any(String) }));
  });

  /*
  FNXC:ExternalExecutionCheckout 2026-08-10-01:06:
  Verification must re-read persisted routing, fail closed when the live operator checkout is missing,
  and report that live path rather than a stale managed-worktree snapshot.
  */
  it("fails closed from the live external route when the verification snapshot is stale", async () => {
    const missingExternalCheckout = join(tmpdir(), `fusion-missing-operator-checkout-${randomUUID()}`);
    const staleTask = {
      id: "FN-9006",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: "/repo/.worktrees/stale",
      branch: "fusion/fn-9006",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.getTask.mockResolvedValue({
      ...staleTask,
      sourceMetadata: {
        externalExecutionCheckout: missingExternalCheckout,
        externalExecutionBranch: "operator/runtime-fixes",
      },
    });
    mockedExistsSync.mockImplementation((path: any) => path !== missingExternalCheckout);

    const result = await (executor as any).verifyWorktreeInvariants(staleTask);

    expect(result).toMatchObject({
      ok: false,
      reason: "wrong_toplevel",
      observed: `checkoutPath is not a directory: ${missingExternalCheckout}`,
      expected: "valid persisted external execution checkout",
    });
  });

  it("preserves validation failure when worktree path is null", async () => {
    const task = {
      id: "FN-9003",
      title: "Test",
      description: "Test",
      column: "in-progress",
      worktree: null,
      branch: "fusion/fn-9003",
      dependencies: [],
      steps: [],
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    store.getTask.mockResolvedValue(task as any);
    const result = await (executor as any).verifyWorktreeInvariants(task);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("wrong_toplevel");
    expect(result.observed).toContain("missing task.worktree");
  });
});
