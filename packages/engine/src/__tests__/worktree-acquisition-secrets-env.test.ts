import { dirname } from "node:path";

import { describe, it, expect, vi, beforeEach } from "vitest";

const { writeSecretsEnvFile } = vi.hoisted(() => ({ writeSecretsEnvFile: vi.fn() }));

vi.mock("../secrets-env-writer.js", () => ({
  writeSecretsEnvFile,
}));

vi.mock("../worktree-pool.js", async () => {
  const actual = await vi.importActual<any>("../worktree-pool.js");
  return {
    ...actual,
    classifyTaskWorktree: vi.fn().mockResolvedValue({ ok: true }),
    isInsideWorktreesDir: vi.fn().mockReturnValue(true),
  };
});

vi.mock("../worktree-db-hydrate.js", () => ({
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }),
}));

/*
FNXC:EngineTests 2026-07-21-00:10:
Pool unit tests use non-git temp paths; identity guard would throw and fall through to fresh.
*/
vi.mock("../worktree-hooks.js", async () => {
  const actual = await vi.importActual<any>("../worktree-hooks.js");
  return {
    ...actual,
    installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined),
  };
});

import { acquireTaskWorktree } from "../worktree-acquisition.js";
import { classifyTaskWorktree } from "../worktree-pool.js";

describe("worktree-acquisition secrets env hook", () => {
  const task = { id: "FN-1", title: "t", description: "d", branch: null, worktree: null } as any;
  let store: any;

  beforeEach(() => {
    writeSecretsEnvFile.mockReset().mockResolvedValue({ outcome: "skipped", filename: ".env", reason: "disabled" });
    vi.mocked(classifyTaskWorktree).mockResolvedValue({ ok: true } as any);
    store = { updateTask: vi.fn().mockResolvedValue(undefined), logEntry: vi.fn().mockResolvedValue(undefined) };
  });

  it("calls writer on pool", async () => {
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { recycleWorktrees: true, secretsEnv: { enabled: true } } as any,
      pool: {
        acquire: () => "/tmp/pool",
        prepareForTask: vi.fn().mockResolvedValue({ branch: "fusion/fn-1", worktreePath: "/tmp/pool", reclaimed: false }),
        release: vi.fn(),
      } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh-fallback", branch: "fusion/fn-1" }),
      secretsStore: undefined,
    });
    expect(writeSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({ worktreeSource: "pool", secretsStore: undefined }));
  });

  it("calls writer on fresh", async () => {
    await acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" }),
      secretsStore: undefined,
    });
    expect(writeSecretsEnvFile).toHaveBeenCalledWith(expect.objectContaining({ worktreeSource: "fresh" }));
  });

  it("does not call writer for existing resume", async () => {
    const existingWorktree = process.cwd();
    const projectRoot = dirname(existingWorktree);

    await acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: existingWorktree },
      rootDir: projectRoot,
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn(),
    });
    expect(writeSecretsEnvFile).not.toHaveBeenCalled();
  });

  it("isolates writer failures", async () => {
    writeSecretsEnvFile.mockRejectedValueOnce(new Error("boom"));
    await expect(acquireTaskWorktree({
      task,
      rootDir: process.cwd(),
      store,
      settings: { secretsEnv: { enabled: true } } as any,
      createWorktree: vi.fn().mockResolvedValue({ path: "/tmp/fresh", branch: "fusion/fn-1" }),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).resolves.toMatchObject({ source: "fresh" });
  });
});
