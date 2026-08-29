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

  it("skips a dirty checkout without changing the durable baseline, and stays execution-safe", async () => {
    const { root, worktree, c0 } = fixture();
    writeFileSync(join(worktree, "dirty.txt"), "keep me\n");
    const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await refreshReusedWorktreeBase({
      task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
    });
    expect(result).toMatchObject({ kind: "dirty-worktree", executionSafe: true, skipped: true });
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(git(worktree, "rev-parse HEAD")).toBe(c0);
    expect(git(worktree, "status --porcelain")).toContain("dirty.txt");
  });

  /*
  FNXC:WorktreeBaseRefreshTests 2026-08-09-23:49:
  The invariant, asserted across every surface that produced an execution refusal in production: a refresh that
  cannot proceed leaves the checkout untouched and lets the session run. Between 2026-08-01 and 2026-08-09 the
  blocking form parked 99 tasks `failed` — 74 dirty-worktree, 25 own-commit rebase conflicts — for a base that
  the merge lane rebases with conflict resolution anyway. Only an UNPROVEN tree may still refuse.
  */
  describe("never blocks execution for a recoverable base state", () => {
    it("keeps the local base when rebasing own commits onto a moved base conflicts", async () => {
      const { root, worktree, c0, c1 } = fixture();
      // Same file edited on both sides of the fork → the rebase onto C1 must conflict.
      writeFileSync(join(worktree, "scaffold.ts"), "export const scaffold = 'task-side';\n");
      git(worktree, "add scaffold.ts && git commit -m C2");
      const c2 = git(worktree, "rev-parse HEAD");
      const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;

      const result = await refreshReusedWorktreeBase({
        task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
      });

      expect(result).toMatchObject({ kind: "stale-base-conflict", executionSafe: true, skipped: true });
      // Compensated back to the task's own tip, with no rebase left in progress and no work lost.
      expect(git(worktree, "rev-parse HEAD")).toBe(c2);
      expect(git(worktree, "status --porcelain")).toBe("");
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(c2).not.toBe(c1);
    });

    it("runs on the existing base when the base commit cannot be resolved", async () => {
      const { worktree, c0 } = fixture();
      // A repo with no `main` commit to resolve: `rev-parse main^{commit}` fails, so the probe itself is unusable.
      const emptyRoot = mkdtempSync(join(tmpdir(), "fn-8693-empty-"));
      paths.push(emptyRoot);
      git(emptyRoot, "init -b main");
      const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;

      const result = await refreshReusedWorktreeBase({
        task: { id: "FN-1", baseCommitSha: c0 } as any,
        rootDir: emptyRoot,
        worktreePath: worktree,
        store,
        settings: {},
      });

      expect(result).toMatchObject({ kind: "base-unresolvable", executionSafe: true, skipped: true });
      expect(git(worktree, "rev-parse HEAD")).toBe(c0);
      expect(store.updateTask).not.toHaveBeenCalled();
    });

    it("treats a worktrunk-managed checkout as safe rather than refusing execution", async () => {
      const { root, worktree, c0 } = fixture();
      const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;
      const result = await refreshReusedWorktreeBase({
        task: { id: "FN-1", baseCommitSha: c0 } as any,
        rootDir: root,
        worktreePath: worktree,
        store,
        settings: { worktrunk: { enabled: true } } as any,
      });
      expect(result).toMatchObject({ kind: "worktrunk-refresh-unsupported", executionSafe: true, skipped: true });
    });

    /*
    The ordering defect on its own: HEAD already contains the integration tip, so no git command would run and
    uncommitted work is irrelevant — yet the dirty check ran first and refused execution anyway.
    */
    it("reports up-to-date for a dirty checkout that already sits on the current base", async () => {
      const { root, worktree, c1 } = fixture();
      git(worktree, `reset --hard ${c1}`);
      writeFileSync(join(worktree, "wip.ts"), "export const wip = true;\n");
      const store = { updateTask: vi.fn().mockResolvedValue(undefined) } as any;

      const result = await refreshReusedWorktreeBase({
        task: { id: "FN-1", baseCommitSha: c1 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
      });

      expect(result).toMatchObject({ kind: "up-to-date", executionSafe: true });
      expect(result.skipped).toBeUndefined();
      expect(git(worktree, "status --porcelain")).toContain("wip.ts");
    });

    it("still proceeds when only the durable baseline write fails on an already-current head", async () => {
      const { root, worktree, c0, c1 } = fixture();
      git(worktree, `reset --hard ${c1}`);
      const store = { updateTask: vi.fn().mockRejectedValue(new Error("database unavailable")) } as any;
      const result = await refreshReusedWorktreeBase({
        task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
      });
      // No git command ran, so HEAD is the verified-current tip — a failed baseline write must not block a session.
      expect(result).toMatchObject({ executionSafe: true, skipped: true });
      expect(git(worktree, "rev-parse HEAD")).toBe(c1);
    });

    it("keeps the compensated persistence failure execution-safe", async () => {
      const { root, worktree, c0 } = fixture();
      const store = { updateTask: vi.fn().mockRejectedValue(new Error("database unavailable")) } as any;
      const result = await refreshReusedWorktreeBase({
        task: { id: "FN-1", baseCommitSha: c0 } as any, rootDir: root, worktreePath: worktree, store, settings: {},
      });
      expect(result).toMatchObject({ kind: "base-persistence-failed-compensated", executionSafe: true, skipped: true });
      expect(git(worktree, "rev-parse HEAD")).toBe(c0);
    });
  });
});
