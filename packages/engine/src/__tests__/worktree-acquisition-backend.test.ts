import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../worktree/worktree-hooks.js", () => ({
  installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  IDENTITY_GUARD_BYPASS_ENV: "FUSION_MERGER_BYPASS_IDENTITY_GUARD",
}));
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import type { WorktreeBackend } from "../worktree/worktree-backend.js";

vi.mock("../worktree/worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return { ...actual, isUsableTaskWorktree: vi.fn().mockResolvedValue(true) };
});

vi.mock("../worktree/worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 1, documentsCopied: 1, artifactsCopied: 0 }),
}));

const { execMock, existsSyncMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return {
    execMock: mock,
    existsSyncMock: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({ exec: execMock, execFile: vi.fn() }));
/*
FNXC:EngineTests 2026-07-17-11:55:
Path reservation writes lock state under rootDir/.worktrees. Use real fs/promises
against a temp root; only stub existsSync for worktrunk path probes.
*/
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: existsSyncMock };
});

describe("acquireTaskWorktree backend wiring", () => {
  const task = { id: "FN-1", title: "Task", description: "Desc", branch: null, worktree: null } as any;
  const store = {
    updateTask: vi.fn().mockResolvedValue(undefined),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    logEntry: vi.fn().mockResolvedValue(undefined),
  } as any;
  const roots: string[] = [];

  async function makeRootDir(): Promise<string> {
    const rootDir = await mkdtemp(join(tmpdir(), "fusion-wt-backend-"));
    roots.push(rootDir);
    return rootDir;
  }

  beforeEach(() => {
    execMock.mockReset();
    existsSyncMock.mockReset();
    existsSyncMock.mockReturnValue(true);
    store.updateTask.mockClear();
    store.logEntry.mockClear();
    store.pauseTask.mockClear();
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("uses native backend by default and emits no worktrunk audit", async () => {
    const rootDir = await makeRootDir();
    execMock.mockResolvedValue({ stdout: "", stderr: "" });
    const audit = {
      git: vi.fn().mockResolvedValue(undefined),
      database: vi.fn().mockResolvedValue(undefined),
      filesystem: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn().mockResolvedValue(undefined),
    };

    const result = await acquireTaskWorktree({
      task,
      rootDir,
      store,
      settings: { worktreeNaming: "task-id" } as any,
      audit,
    });

    expect(result.branch).toBe("fusion/fn-1");
    expect(result.worktreePath).toBe(`${rootDir}/.worktrees/fn-1`);
    /*
     * FNXC:WorktreeIsolation 2026-07-02-07:40:
     * acquireTaskWorktree now resolves the integration branch via `git symbolic-ref` and pins fresh worktree creation to that start point so new task branches never inherit the root checkout's ambient HEAD. With an empty mock stdout the resolver falls back to "main", so the native create command appends "main" as the start point and there are two exec calls (symbolic-ref + worktree add).
     */
    expect(execMock).toHaveBeenCalledWith(
      "git symbolic-ref --short refs/remotes/origin/HEAD",
      expect.objectContaining({ cwd: rootDir }),
    );
    expect(execMock).toHaveBeenCalledWith(
      `git worktree add -b "fusion/fn-1" "${rootDir}/.worktrees/fn-1" "main"`,
      expect.objectContaining({ cwd: rootDir }),
    );
    expect(audit.git).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree:worktrunk-create" }),
    );
  });

  it("routes through worktrunk backend when enabled and emits audit once", async () => {
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
    const audit = {
      git: vi.fn().mockResolvedValue(undefined),
      database: vi.fn().mockResolvedValue(undefined),
      filesystem: vi.fn().mockResolvedValue(undefined),
      sandbox: vi.fn().mockResolvedValue(undefined),
    };

    await acquireTaskWorktree({
      task,
      rootDir,
      store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "wt" } } as any,
      audit,
    });

    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"wt" "switch" "--create" "fusion/fn-1"'))).toBe(true);
    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree:worktrunk-create",
        metadata: expect.objectContaining({ branch: "fusion/fn-1" }),
      }),
    );
    expect(
      audit.git.mock.calls.filter(([event]) => event?.type === "worktree:worktrunk-create"),
    ).toHaveLength(1);
    expect(audit.git).toHaveBeenCalledWith(
      expect.objectContaining({ type: "worktree:create" }),
    );
  });

  it("passes audit into worktrunk-to-native fallback collision recovery", async () => {
    const rootDir = await makeRootDir();
    let nativeAddAttempts = 0;
    execMock.mockImplementation((command: string) => {
      if (command.includes('"wt" "switch" "--create"')) {
        return Promise.reject({ stderr: "worktrunk create failed", status: 1 });
      }
      if (command.startsWith("git worktree add -b")) {
        nativeAddAttempts += 1;
        return nativeAddAttempts === 1
          ? Promise.reject({ message: "branch collision", stderr: "fatal: a branch named 'fusion/fn-1' already exists" })
          : Promise.resolve({ stdout: "", stderr: "" });
      }
      if (command === "git worktree list --porcelain") return Promise.resolve({ stdout: `worktree ${rootDir}\nbranch refs/heads/main\n`, stderr: "" });
      if (command.startsWith("git cherry")) return Promise.resolve({ stdout: "", stderr: "" });
      return Promise.resolve({ stdout: "deadbeef\n", stderr: "" });
    });
    const audit = { git: vi.fn().mockResolvedValue(undefined) };

    await acquireTaskWorktree({
      task: { ...task, executionStartBranch: "release" }, rootDir, store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: "wt", onFailure: "fallback-native" } } as any, audit: audit as any,
    });

    expect(nativeAddAttempts).toBe(2);
    expect(audit.git).toHaveBeenCalledWith(expect.objectContaining({
      type: "worktree:branch-collision-recovery",
      metadata: expect.objectContaining({ taskId: "FN-1", disposition: "recreate-from-startpoint" }),
    }));
  });

  it("throws worktrunk_binary_missing with no binaryPath", async () => {
    const rootDir = await makeRootDir();
    await expect(
      acquireTaskWorktree({
        task,
        rootDir,
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true } } as any,
      }),
    ).rejects.toMatchObject({ name: "WorktrunkOperationError", code: "worktrunk_binary_missing" });

    /*
     * FNXC:WorktreeIsolation 2026-07-02-07:40 (updated 2026-07-07-09:15 for FN-7438):
     * The integration-branch resolution runs before the worktrunk binary check. With an empty symbolic-ref result, FN-7438 (aa8f1f32e) adds a `git remote` discovery call before the "main" fallback, so two exec calls happen. No worktrunk `switch` command should be attempted when the binary is missing.
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
    expect(execMock.mock.calls.some((call) => String(call[0]).includes('"switch"'))).toBe(false);
  });

  it("throws worktrunk_operation_failed and preserves stderr", async () => {
    const rootDir = await makeRootDir();
    /*
    FNXC:EngineTests 2026-07-17-11:55:
    WorktrunkWorktreeBackend access()-checks the override path before exec. Use a real
    temp file so access succeeds; probe via --version must also succeed; only switch
    --create should surface operation_failed.
    */
    const explicitBinaryPath = join(rootDir, "fake-wt");
    await writeFile(explicitBinaryPath, "#!/bin/sh\n");
    execMock.mockImplementation((command: string) => {
      if (String(command).includes("--version") || String(command).includes("version")) {
        return Promise.resolve({ stdout: "wt 0.4.2\n", stderr: "" });
      }
      return Promise.reject({ stderr: "worktrunk exploded", status: 17 });
    });

    await expect(
      acquireTaskWorktree({
        task,
        rootDir,
        store,
        settings: { worktreeNaming: "task-id", worktrunk: { enabled: true, binaryPath: explicitBinaryPath } } as any,
      }),
    ).rejects.toMatchObject({
      name: "WorktrunkOperationError",
      code: "worktrunk_operation_failed",
      stderr: "worktrunk exploded",
      exitCode: 17,
    });
    expect(execMock.mock.calls.some((call) => String(call[0]).includes(`"${explicitBinaryPath}" "switch" "--create"`))).toBe(true);
  });

  it("forwards canonical branch and pinned execution start point to an injected backend", async () => {
    const rootDir = await makeRootDir();
    const create = vi.fn().mockResolvedValue({ path: "/tmp/backend", branch: "fusion/fn-1" });
    const backend: WorktreeBackend = {
      kind: "native", create, remove: vi.fn(), sync: vi.fn().mockResolvedValue({ skipped: true as const }), prune: vi.fn(),
      resolveWorktreePath: vi.fn().mockResolvedValue("/tmp/backend"),
    };

    await acquireTaskWorktree({
      task: { ...task, executionStartBranch: "release" }, rootDir, store,
      settings: { worktreeNaming: "task-id" } as any, backend,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      branch: "fusion/fn-1", startPoint: "release", taskId: "FN-1",
    }));
  });

  it("forwards canonical branch and pinned start point on pool fresh fallback", async () => {
    const rootDir = await makeRootDir();
    const create = vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" });
    const backend: WorktreeBackend = {
      kind: "native", create, remove: vi.fn(), sync: vi.fn().mockResolvedValue({ skipped: true as const }), prune: vi.fn(),
      resolveWorktreePath: vi.fn().mockResolvedValue("/tmp/fresh"),
    };
    const pool = {
      acquire: vi.fn().mockReturnValue("/tmp/pooled"),
      prepareForTask: vi.fn().mockRejectedValue(new Error("pool unavailable")),
      release: vi.fn(),
    };

    await acquireTaskWorktree({
      task: { ...task, executionStartBranch: "release" }, rootDir, store,
      settings: { worktreeNaming: "task-id", recycleWorktrees: true } as any, backend, pool: pool as any,
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      branch: "fusion/fn-1", startPoint: "release", taskId: "FN-1",
    }));
  });

  it("uses explicit backend override", async () => {
    const rootDir = await makeRootDir();
    const create = vi.fn().mockResolvedValue({ path: "/tmp/backend", branch: "fusion/fn-backend" });
    const backend: WorktreeBackend = {
      kind: "native",
      create,
      remove: vi.fn(),
      sync: vi.fn().mockResolvedValue({ skipped: true as const }),
      prune: vi.fn(),
      resolveWorktreePath: vi.fn().mockResolvedValue("/tmp/custom-path"),
    };

    const result = await acquireTaskWorktree({
      task,
      rootDir,
      store,
      settings: { worktreeNaming: "task-id", worktrunk: { enabled: true } } as any,
      backend,
    });

    expect(result.worktreePath).toBe("/tmp/backend");
    expect(result.branch).toBe("fusion/fn-backend");
    expect(create).toHaveBeenCalledTimes(1);
    /*
     * FNXC:WorktreeIsolation 2026-07-02-07:40 (updated 2026-07-07-09:15 for FN-7438):
     * The integration-branch resolution runs before the explicit backend's create. With an empty symbolic-ref result, FN-7438 (aa8f1f32e) adds a `git remote` discovery call before the "main" fallback, so two exec calls happen: symbolic-ref + git remote. The custom backend's create mock performs no exec.
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
