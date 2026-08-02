import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshReusedWorktreeBase } from "../worktree-base-refresh.js";

const paths: string[] = [];
const git = (cwd: string, command: string) => execSync(`git ${command}`, { cwd, encoding: "utf8" }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fn-8693-base-"));
  paths.push(root);
  git(root, "init -b main");
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test"');
  writeFileSync(join(root, "README.md"), "C0\n");
  git(root, "add README.md && git commit -m C0");
  const c0 = git(root, "rev-parse HEAD");
  const worktree = join(root, "task");
  git(root, `worktree add -b fusion/fn-1 ${JSON.stringify(worktree)} ${c0}`);
  writeFileSync(join(root, "scaffold.ts"), "export const scaffold = true;\n");
  git(root, "add scaffold.ts && git commit -m C1");
  return { root, worktree, c0, c1: git(root, "rev-parse HEAD") };
}
afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

/*
FNXC:WorktreeBaseRefreshTests 2026-08-01-16:04:
These temp-git fixtures reproduce a dependency task planned at C0 while main advances to C1.
They prove execution refresh stores integration C1, never stale C0, before a session caller may proceed.
*/
describe("refreshReusedWorktreeBase", () => {
  it("resets a clean planning branch to C1 and persists C1", async () => {
    const { root, worktree, c0, c1 } = fixture();
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
    });
    expect(result).toMatchObject({ kind: "reset-to-base", executionSafe: true, baseSha: c1 });
    expect(git(worktree, "rev-parse HEAD")).toBe(c1);
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { baseCommitSha: c1 });
  });

  it("rebases own commit C2 onto C1 while storing C1, not C2", async () => {
    const { root, worktree, c0, c1 } = fixture();
    writeFileSync(join(worktree, "implementation.ts"), "export const implementation = true;\n");
    git(worktree, "add implementation.ts && git commit -m C2");
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
    });
    const c2 = git(worktree, "rev-parse HEAD");
    expect(result).toMatchObject({ kind: "rebased", executionSafe: true, baseSha: c1, observedHead: c2 });
    expect(c2).not.toBe(c1);
    expect(git(worktree, `merge-base --is-ancestor ${c1} ${c2}; echo $?`)).toBe("0");
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { baseCommitSha: c1 });
  });

  it("returns the compensated persistence failure after restoring C0", async () => {
    const { root, worktree, c0 } = fixture();
    const store = { updateTask: vi.fn().mockRejectedValue(new Error("database unavailable")) } as any;
    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
    });
    expect(result.kind).toBe("base-persistence-failed-compensated");
    expect(git(worktree, "rev-parse HEAD")).toBe(c0);
  });

  it("statelessly reconciles stale durable C0 when clean HEAD is already C1", async () => {
    const { root, worktree, c0, c1 } = fixture();
    git(worktree, `reset --hard ${c1}`);
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
    });
    expect(result).toMatchObject({ kind: "up-to-date", executionSafe: true, baseSha: c1 });
    expect(store.updateTask).toHaveBeenCalledWith("FN-1", { baseCommitSha: c1 });
  });

  it("blocks a dirty checkout without changing the durable baseline", async () => {
    const { root, worktree, c0 } = fixture();
    writeFileSync(join(worktree, "dirty.txt"), "keep me\n");
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
    });
    expect(result.kind).toBe("dirty-worktree");
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
