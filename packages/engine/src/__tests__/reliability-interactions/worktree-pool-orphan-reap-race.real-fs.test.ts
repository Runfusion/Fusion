import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmdirSync: vi.fn((path: unknown) => {
      const worktreePath = String(path);
      if (worktreePath.endsWith("/race-orphan")) {
        actual.writeFileSync(`${worktreePath}/created-after-scan.txt`, "user-authored\n");
      }
      if (worktreePath.endsWith("/restore-fails-orphan") || worktreePath.endsWith("/concurrent-wins-orphan")) {
        actual.writeFileSync(`${worktreePath}/user-file.txt`, "user-authored\n");
      }
      return actual.rmdirSync(worktreePath);
    }),
    // Pointer recreation through writeFileSync(wx) must never be the restore path:
    // force it to fail, so a regression back to recreate-based restoration is caught.
    writeFileSync: vi.fn((path: unknown, data: unknown, options?: unknown) => {
      const opts = options as { flag?: string } | undefined;
      if (String(path).endsWith("/race-orphan/.git") && opts?.flag === "wx") {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      return actual.writeFileSync(String(path), String(data), options as never);
    }),
    // Force the restore link to fail with a NON-EEXIST error (EPERM): the stash
    // must be restored via the copy fallback rather than abandoned, and a
    // regression to a warn-only catch (orphaned stash + lost pointer) is caught.
    linkSync: vi.fn((src: unknown, dest: unknown) => {
      if (String(dest).endsWith("/restore-fails-orphan/.git") || String(dest).endsWith("/concurrent-wins-orphan/.git")) {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      }
      return actual.linkSync(String(src), String(dest));
    }),
    // Simulate a concurrent process creating an authoritative .git between the
    // link failure and the copy fallback: the copy must fail EEXIST and the
    // concurrent pointer must win, never being overwritten by the stash.
    copyFileSync: vi.fn((src: unknown, dest: unknown, mode?: unknown) => {
      if (String(dest).endsWith("/concurrent-wins-orphan/.git")) {
        actual.writeFileSync(String(dest), "gitdir: /concurrent/authoritative.git\n");
        throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
      }
      return actual.copyFileSync(String(src), String(dest), mode as never);
    }),
  };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reapOrphanWorktrees } from "../../worktree/worktree-pool.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("reapOrphanWorktrees real filesystem race", () => {
  it("restores dangling .git metadata when content appears before rmdir, even if pointer recreation would fail", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-orphan-race-"));
    roots.push(root);
    const orphan = join(root, ".worktrees", "race-orphan");
    const dotGit = join(orphan, ".git");
    const createdAfterScan = join(orphan, "created-after-scan.txt");
    const pointer = `gitdir: ${join(root, ".git", "worktrees", "race-orphan")}\n`;
    const mode = 0o640;

    mkdirSync(orphan, { recursive: true });
    writeFileSync(dotGit, pointer, { mode });

    const removed = await reapOrphanWorktrees(root);

    expect(removed).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(createdAfterScan)).toBe(true);
    expect(readFileSync(dotGit, "utf8")).toBe(pointer);
    expect(statSync(dotGit).mode & 0o777).toBe(mode);
  });

  it("restores the dangling .git pointer via the copy fallback when restore-link fails with a non-EEXIST error (no orphaned stash)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-orphan-restore-fail-"));
    roots.push(root);
    const orphan = join(root, ".worktrees", "restore-fails-orphan");
    const dotGit = join(orphan, ".git");
    const userFile = join(orphan, "user-file.txt");
    const pointer = `gitdir: ${join(root, ".git", "worktrees", "restore-fails-orphan")}\n`;
    const mode = 0o640;

    mkdirSync(orphan, { recursive: true });
    writeFileSync(dotGit, pointer, { mode });

    const removed = await reapOrphanWorktrees(root);

    expect(removed).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    // Pointer restored from the stash (rename-back preserves content and mode),
    // never lost to a warn-only catch.
    expect(readFileSync(dotGit, "utf8")).toBe(pointer);
    expect(statSync(dotGit).mode & 0o777).toBe(mode);
    // No stash left abandoned next to the orphan.
    const stashFiles = readdirSync(join(root, ".worktrees")).filter((entry) => entry.includes(".git-reap-stash-"));
    expect(stashFiles).toEqual([]);
  });

  it("never overwrites a concurrent .git pointer during the copy-fallback restore (concurrent pointer wins)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pool-orphan-concurrent-wins-"));
    roots.push(root);
    const orphan = join(root, ".worktrees", "concurrent-wins-orphan");
    const dotGit = join(orphan, ".git");
    const userFile = join(orphan, "user-file.txt");
    const pointer = `gitdir: ${join(root, ".git", "worktrees", "concurrent-wins-orphan")}\n`;
    const mode = 0o640;

    mkdirSync(orphan, { recursive: true });
    writeFileSync(dotGit, pointer, { mode });

    const removed = await reapOrphanWorktrees(root);

    expect(removed).toBe(0);
    expect(existsSync(orphan)).toBe(true);
    expect(existsSync(userFile)).toBe(true);
    // The concurrent authoritative pointer wins; the stashed dangling pointer
    // must never replace it (COPYFILE_EXCL refuses and the stash is dropped).
    expect(readFileSync(dotGit, "utf8")).toBe("gitdir: /concurrent/authoritative.git\n");
    const stashFiles = readdirSync(join(root, ".worktrees")).filter((entry) => entry.includes(".git-reap-stash-"));
    expect(stashFiles).toEqual([]);
  });
});
