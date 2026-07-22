import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { classifyStaleLock, parseIndexLockPath, tryRemoveStaleLock } from "../worktree/worktree-stale-lock.js";

const { execMock } = vi.hoisted(() => {
  const mock = vi.fn();
  (mock as any)[Symbol.for("nodejs.util.promisify.custom")] = mock;
  return { execMock: mock };
});

vi.mock("node:child_process", () => ({ exec: execMock, execFile: vi.fn() }));

describe("worktree-stale-lock", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("parses worktree index.lock and main .git/index.lock errors", () => {
    expect(
      parseIndexLockPath("fatal: unable to create '/repo/.git/worktrees/fresh-oak/index.lock': File exists."),
    ).toBe("/repo/.git/worktrees/fresh-oak/index.lock");
    expect(parseIndexLockPath("fatal: unable to create '.git/index.lock': File exists.")).toBe(".git/index.lock");
  });

  it("classifies young locks as fresh", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fn-4830-"));
    const lockPath = resolve(root, ".git/worktrees/fresh-oak/index.lock");
    await mkdir(resolve(root, ".git/worktrees/fresh-oak"), { recursive: true });
    await writeFile(lockPath, "lock", "utf-8");

    const result = await classifyStaleLock({ rootDir: root, lockPath, minAgeMs: 30_000, now: () => Date.now() });
    expect(result.kind).toBe("fresh");

    await rm(root, { recursive: true, force: true });
  });

  it("classifies active-session match", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fn-4830-"));
    const worktreePath = resolve(root, ".worktrees/fresh-oak");
    const lockDir = resolve(root, ".git/worktrees/fresh-oak");
    const lockPath = resolve(lockDir, "index.lock");
    await mkdir(lockDir, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(resolve(lockDir, "gitdir"), `${worktreePath}/.git\n`, "utf-8");
    await writeFile(lockPath, "lock", "utf-8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);

    const result = await classifyStaleLock({
      rootDir: root,
      lockPath,
      activeSessionRegistry: {
        lookupByPath: (p) => (p === worktreePath ? ({ taskId: "FN-1" } as const) : null),
      },
    });

    expect(result.kind).toBe("active-session");
    expect(result.owningWorktreePath).toBe(worktreePath);

    await rm(root, { recursive: true, force: true });
  });

  it("classifies missing lock file", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fn-4830-"));
    const lockPath = resolve(root, ".git/worktrees/fresh-oak/index.lock");

    const result = await classifyStaleLock({ rootDir: root, lockPath });
    expect(result).toMatchObject({ kind: "missing" });

    await rm(root, { recursive: true, force: true });
  });

  it("classifies stale when old and no owner", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fn-4830-"));
    const lockPath = resolve(root, ".git/worktrees/fresh-oak/index.lock");
    await mkdir(resolve(root, ".git/worktrees/fresh-oak"), { recursive: true });
    await writeFile(lockPath, "lock", "utf-8");
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    execMock.mockResolvedValue({ stdout: "worktree /repo/.worktrees/other\n\n", stderr: "" });

    const result = await classifyStaleLock({ rootDir: root, lockPath, minAgeMs: 30_000 });
    expect(result.kind).toBe("stale");

    await rm(root, { recursive: true, force: true });
  });

  it("tryRemoveStaleLock handles ENOENT and successful delete", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "fn-4830-"));
    const lockPath = resolve(root, "index.lock");
    await writeFile(lockPath, "lock", "utf-8");

    await expect(tryRemoveStaleLock({ lockPath })).resolves.toEqual({ removed: true });
    await expect(tryRemoveStaleLock({ lockPath })).resolves.toEqual({ removed: false, reason: "already-missing" });

    await rm(root, { recursive: true, force: true });
  });
});
