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
  hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0 }),
}));

import { acquireTaskWorktree } from "../worktree-acquisition.js";

describe("worktree-acquisition secrets env hook", () => {
  const task = { id: "FN-1", title: "t", description: "d", branch: null, worktree: null } as any;
  let store: any;

  beforeEach(() => {
    writeSecretsEnvFile.mockReset().mockResolvedValue({ outcome: "skipped", filename: ".env", reason: "disabled" });
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
      createWorktree: vi.fn(),
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
    await acquireTaskWorktree({
      task: { ...task, branch: "fusion/fn-1", worktree: process.cwd() },
      rootDir: process.cwd(),
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
