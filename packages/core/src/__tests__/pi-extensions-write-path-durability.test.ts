/**
 * FNXC:Storage 2026-07-09-00:00:
 * FN-7730 symptom verification. The original report: board mutations applied
 * through fn_task_update / CEO override / Release Manager closure / direct SQL
 * "appear to complete" but are never durably visible to the engine or a
 * subsequent read, with NO error surfaced. The root cause (see task FN-7730
 * `research` document) is a project-root resolution mismatch: a pi-extension
 * tool session running inside a non-standard-location linked worktree could
 * silently resolve its TaskStore against the worktree's own locally-hydrated
 * `.fusion/fusion.db` instead of the true project root, when the `git` CLI
 * path-resolution fallback failed (missing binary / Docker dubious-ownership /
 * NFS-overlay permission issues) with no thrown error.
 *
 * This test reproduces the full write -> second-connection-read shape end to
 * end: it resolves the project root the SAME way `packages/cli/src/extension.ts`
 * does (via `resolvePiExtensionProjectRoot`) from inside a non-standard-location
 * worktree with the git CLI made to fail, writes a dependency-edit mutation and
 * an archival (column move) mutation through a TaskStore opened at the resolved
 * path, and asserts a FRESH second TaskStore instance opened directly against
 * the true project root sees both mutations immediately — proving the write
 * path and the engine's read path now agree on the same physical database file.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const cleanupDirs: string[] = [];

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.resetModules();
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("write-path durability across a non-standard-location worktree (FN-7730)", () => {
  it("mutations written via the resolved project root are visible to a fresh second connection at the true root", async () => {
    vi.resetModules();
    vi.doMock("node:child_process", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:child_process")>();
      return {
        ...actual,
        spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "fatal: detected dubious ownership" })),
      };
    });

    const root = mkdtempSync(join(tmpdir(), "fn-7730-durability-root-"));
    const worktreeDir = mkdtempSync(join(tmpdir(), "fn-7730-durability-wt-"));
    cleanupDirs.push(root, worktreeDir);

    mkdirSync(join(root, ".fusion"), { recursive: true });

    // Fabricate the on-disk linked-worktree metadata for a NON-standard
    // location (outside `.worktrees`), matching a configured settings.worktreesDir.
    const worktreeGitDir = join(root, ".git", "worktrees", "durability-wt");
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreeGitDir}\n`);

    // Simulate hydrateWorktreeDb's ensureWorktreeSchema having already given
    // the worktree its own local `.fusion` directory (a decoy target the old
    // naive fallback walk would have matched).
    mkdirSync(join(worktreeDir, ".fusion"), { recursive: true });

    const { resolvePiExtensionProjectRoot } = await import("../pi-extensions.js");
    const { TaskStore } = await import("../store.js");

    const resolvedRoot = resolvePiExtensionProjectRoot(worktreeDir);
    expect(resolvedRoot).toBe(resolve(root));
    expect(resolvedRoot).not.toBe(resolve(worktreeDir));

    // Write path: a TaskStore opened exactly the way the CLI extension's
    // getStore(cwd) would, at the resolved root.
    const writerStore = new TaskStore(resolvedRoot);
    await writerStore.init();

    const depTarget = await writerStore.createTask({ description: "FN-7730 dependency target" });
    const task = await writerStore.createTask({ description: "FN-7730 mutated task" });
    await writerStore.updateTaskDependencies(task.id, { operation: "add", dependency: depTarget.id });
    await writerStore.archiveTask(task.id);
    await writerStore.close();

    // Read path: a FRESH second TaskStore instance opened directly against the
    // true project root, modeling the engine's own store.
    const readerStore = new TaskStore(resolve(root));
    await readerStore.init();
    try {
      const reReadTask = await readerStore.getTask(task.id, { includeDeleted: true });
      expect(reReadTask).toBeTruthy();
      expect(reReadTask?.dependencies ?? []).toContain(depTarget.id);
      expect(reReadTask?.column).toBe("archived");
    } finally {
      await readerStore.close();
    }
  });
});
