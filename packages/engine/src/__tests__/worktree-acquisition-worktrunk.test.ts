import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execMock, existsSyncMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock, existsSyncMock: vi.fn() };
});

vi.mock("node:child_process", () => ({ exec: execMock, execFile: vi.fn() }));
/*
FNXC:EngineTests 2026-07-17-11:55:
Path reservation now mkdirs lock state under rootDir/.worktrees before create.
Keep real node:fs/promises so reservation works against a temp root; only stub
existsSync for worktrunk path existence checks.
*/
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});
vi.mock("../worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));
vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});
vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1, artifactsCopied: 0 }),
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

describe("acquireTaskWorktree worktrunk wiring", () => {
  const roots: string[] = [];

  async function makeRootDir(): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-wt-"));
    roots.push(rootDir);
    return rootDir;
  }

  beforeEach(() => {
    execMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses native by default when worktrunk settings absent", async () => {
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const rootDir = await makeRootDir();

    const result = await acquireTaskWorktree({
      task,
      rootDir,
      store: makeStore() as any,
      settings: {},
    });

    expect(result).toMatchObject({ source: "fresh", branch: "fusion/fn-1" });
    /*
     * FNXC:WorktreeIsolation 2026-07-02-07:40 (updated 2026-07-07-09:15 for FN-7438):
     * acquireTaskWorktree resolves the integration branch via `git symbolic-ref`. When that returns empty (as the mock does here), FN-7438 (aa8f1f32e) added a `git remote` discovery call before falling back to "main". So three exec calls happen: symbolic-ref, git remote, then the native `git worktree add -b ... "main"` create.
     */
    expect(execMock).toHaveBeenCalledTimes(3);
    expect(execMock.mock.calls[0]?.[0]).toBe("git symbolic-ref --short refs/remotes/origin/HEAD");
    expect(execMock.mock.calls[1]?.[0]).toBe("git remote");
    expect(execMock.mock.calls[2]?.[0]).toContain('git worktree add -b "fusion/fn-1"');
    expect(execMock.mock.calls[2]?.[0]).toContain('"main"');
  });

  it("prefers explicit createWorktree override", async () => {
    const createWorktree = vi.fn().mockResolvedValue({ path: "/tmp/new", branch: "fusion/fn-1" });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const rootDir = await makeRootDir();

    await acquireTaskWorktree({
      task,
      rootDir,
      store: makeStore() as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt" } } as any,
      createWorktree,
    });

    expect(createWorktree).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch"'))).toBe(false);
  });

  it("emits worktrunk + native create audits when worktrunk succeeds", async () => {
    const rootDir = await makeRootDir();
    execMock.mockImplementation((command: string) => {
      if (command.includes('"config" "show"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command.includes('"switch" "--create"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "git worktree list --porcelain") {
        return Promise.resolve({
          stdout: `worktree ${rootDir}/.worktrees/fusion/fn-1\nbranch refs/heads/fusion/fn-1\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const { audit, events } = makeAudit();

    await acquireTaskWorktree({
      task,
      rootDir,
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
    const rootDir = await makeRootDir();
    const resolvedPath = join(rootDir, ".worktrees/custom/fusion-fn-1");
    execMock.mockImplementation((command: string) => {
      if (command.includes('"config" "show"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command.includes('"switch" "--create"')) return Promise.resolve({ stdout: "", stderr: "" });
      if (command === "git worktree list --porcelain") {
        return Promise.resolve({
          stdout: `worktree ${resolvedPath}\nbranch refs/heads/fusion/fn-1\n`,
          stderr: "",
        });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    });
    existsSyncMock.mockImplementation((path: string) => path === resolvedPath);
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");

    const result = await acquireTaskWorktree({
      task,
      rootDir,
      store: store as any,
      settings: { worktrunk: { enabled: true, binaryPath: "wt", onFailure: "fail" } } as any,
    });

    expect(result.worktreePath).toBe(resolvedPath);
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", {
      worktree: resolvedPath,
      branch: "fusion/fn-1",
    });
  });

  it("fails hard without fallback when onFailure=fail", async () => {
    execMock.mockRejectedValue({ stderr: "nope", status: 9 });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const { audit, events } = makeAudit();
    const rootDir = await makeRootDir();

    await expect(
      acquireTaskWorktree({
        task,
        rootDir,
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
    const rootDir = await makeRootDir();

    await acquireTaskWorktree({
      task,
      rootDir,
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
    const rootDir = await makeRootDir();

    await expect(
      acquireTaskWorktree({
        task,
        rootDir,
        store: makeStore() as any,
        settings: { worktrunk: { enabled: true, onFailure: "fail" } } as any,
      }),
    ).rejects.toMatchObject({ code: "worktrunk_binary_missing", operation: "create" });
  });

  it("uses custom backend when provided", async () => {
    const create = vi.fn().mockResolvedValue({ path: "/tmp/custom", branch: "fusion/fn-1-custom" });
    const { acquireTaskWorktree } = await import("../worktree-acquisition.js");
    const rootDir = await makeRootDir();

    const result = await acquireTaskWorktree({
      task,
      rootDir,
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
    /*
     * FNXC:WorktreeIsolation 2026-07-02-07:40 (updated 2026-07-07-09:15 for FN-7438):
     * The integration-branch resolution runs before the custom backend's create. With an empty symbolic-ref result, FN-7438 (aa8f1f32e) adds a `git remote` discovery call before the "main" fallback, so two exec calls happen: symbolic-ref + git remote. The backend's create mock performs no exec.
     */
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenCalledWith(
      "git symbolic-ref --short refs/remotes/origin/HEAD",
      expect.objectContaining({ cwd: rootDir }),
    );
    expect(execMock).toHaveBeenCalledWith(
      "git remote",
      expect.objectContaining({ cwd: rootDir }),
    );
  });
});
