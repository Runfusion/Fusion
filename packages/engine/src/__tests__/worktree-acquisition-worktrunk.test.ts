import { describe, it, expect, vi, beforeEach } from "vitest";

const { execMock, existsSyncMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock, existsSyncMock: vi.fn() };
});

vi.mock("node:child_process", () => ({ exec: execMock }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock }));
vi.mock("../worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});
vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1 }),
}));

const task = {
  id: "FN-1",
  title: "Task",
  description: "Desc",
  branch: null,
  worktree: null,
} as any;

const makeStore = () => ({
  updateTask: vi.fn().mockResolvedValue(undefined),
  pauseTask: vi.fn().mockResolvedValue(undefined),
  logEntry: vi.fn().mockResolvedValue(undefined),
});

const makeAudit = () => {
  const events: Array<{ type: string; target: string; metadata?: Record<string, unknown> }> = [];
  return {
    events,
    audit: {
      git: vi.fn(async (event) => {
        events.push(event);
      }),
    },
  };
};

beforeEach(() => {
  execMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(true);
});

describe("acquireTaskWorktree worktrunk wiring", () => {
  it("uses native by default when worktrunk settings absent", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");

    const result = await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store: makeStore() as any,
      settings: {},
    });

    expect(result).toMatchObject({ source: "fresh", branch: "fusion/fn-1" });
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]?.[0]).toContain("git worktree add -b");
  });

  it("prefers explicit createWorktree override", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");

    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store: makeStore() as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt" } } as any,
      createWorktree,
    });

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch"'))).toBe(false);
  });

  it("emits worktrunk + native create audits when worktrunk succeeds", async () => {
    execMock.mockImplementation((command: string) => {
      if (command.includes('"config" "show"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command.includes('"switch" "--create"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "git worktree list --porcelain") {
        return Promise.resolve({
          stdout: "worktree /repo/.worktrees/fusion/fn-1\nbranch refs/heads/fusion/fn-1\n",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const { audit, events } = makeAudit();

    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store: makeStore() as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt", onFailure: "fail" } } as any,
      audit: audit as any,
    });

    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch" "--create" "fusion/fn-1" "--no-hooks" "--no-cd"'))).toBe(true);
    expect(events.filter((event) => event.type === "worktree:worktrunk-create")).toHaveLength(1);
    expect(events.filter((event) => event.type === "worktree:create")).toHaveLength(1);
  });

  it("propagates resolved worktrunk path into result and task store", async () => {
    const store = makeStore();
    execMock.mockImplementation((command: string) => {
      if (command.includes('"config" "show"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command.includes('"switch" "--create"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "git worktree list --porcelain") {
        return Promise.resolve({
          stdout: "worktree /repo/.worktrees/custom/fusion-fn-1\nbranch refs/heads/fusion/fn-1\n",
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    existsSyncMock.mockImplementation((path: string) => path === "/repo/.worktrees/custom/fusion-fn-1");
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");

    const result = await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store: store as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt", onFailure: "fail" } } as any,
    });

    expect(result.worktreePath).toBe("/repo/.worktrees/custom/fusion-fn-1");
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", {
      worktree: "/repo/.worktrees/custom/fusion-fn-1",
      branch: "fusion/fn-1",
      executionStartBranch: "fusion/fn-1",
    });
  });

  it("fails hard without fallback when onFailure=fail", async () => {
    execMock.mockRejectedValue({ stderr: "nope", status: 9 });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const { audit, events } = makeAudit();

    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store: makeStore() as any,
        settings: { worktrunk: { enabled: true, binaryPath: "wt", onFailure: "fail" } } as any,
        audit: audit as any,
      }),
    ).rejects.toMatchObject({ code: "worktrunk_operation_failed", operation: "create" });

    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch" "--create" "fusion/fn-1"'))).toBe(true);
    expect(events.some((event) => event.type === "worktree:worktrunk-fallback-native")).toBe(false);
  });

  it("falls back to native when onFailure=fallback-native", async () => {
    execMock.mockImplementation((command: string) => {
      if (command.includes('"config" "show"')) {
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command.includes('"switch" "--create"')) {
        return Promise.reject({ stderr: "broken", status: 3 });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const { audit, events } = makeAudit();

    await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store: makeStore() as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt", onFailure: "fallback-native" } } as any,
      audit: audit as any,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch" "--create" "fusion/fn-1"'))).toBe(true);
    expect(execMock.mock.calls.some((call) => String(call[0]).includes("git worktree add -b"))).toBe(true);
    expect(events.filter((event) => event.type === "worktree:worktrunk-fallback-native")).toHaveLength(1);
  });

  it("fails with binary missing when enabled and binaryPath absent", async () => {
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");

    await expect(
      acquireTaskWorktree({
        task,
        rootDir: "/repo",
        store: makeStore() as any,
        settings: { worktrunk: { enabled: true, onFailure: "fail" } } as any,
      }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "create" });
  });

  it("uses custom backend when provided", async () => {
    const create = vi.fn().mockResolvedValue({ path: "/tmp/custom", branch: "fusion/fn-1-custom" });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");

    const result = await acquireTaskWorktree({
      task,
      rootDir: "/repo",
      store: makeStore() as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt" } } as any,
      backend: {
        kind: "native",
        create,
        remove: vi.fn(),
        sync: vi.fn().mockResolvedValue({ skipped: true as const }),
        prune: vi.fn(),
        resolveWorktreePath: vi.fn().mockResolvedValue("/tmp/custom-path"),
      },
    });

    expect(result.branch).toBe("fusion/fn-1-custom");
    expect(create).toHaveBeenCalledTimes(1);
    expect(execMock).not.toHaveBeenCalled();
  });
});
