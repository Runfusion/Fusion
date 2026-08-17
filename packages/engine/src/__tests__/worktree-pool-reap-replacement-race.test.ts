import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
FNXC:WorktreeCleanup 2026-08-17: replacement-pointer boundary regression.
`reapOrphanWorktrees` stashes an orphan's dangling `.git` pointer, revalidates its
inode, then removes the pathname. Between the inode revalidation and the unlink, a
concurrent repair can REPLACE the `.git` pathname with a pointer to a DIFFERENT, live
admin directory. The cleanup's own `targetPath` is derived from the STASHED original,
so it stays stale and cannot see the replacement — naive `unlinkSync(dotGit)` then
deletes the live replacement pointer and `rmdir` destroys the live directory.

This test drives the real filesystem (only the deletion boundary is wrapped) and
asserts fail-closed preservation: the replacement pointer and the directory it points
into must survive, and no reap residue may be left behind.
*/

// Hostile-repair injection switch. When production's fuse `renameSync` removes the
// occupant of this exact path, the wrapper first swaps in a fresh pointer to a
// DIFFERENT live admin before delegating the real move, guaranteeing a new inode.
let injectReplacementAt: string | null = null;
let replacementGitdirContent = "";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: vi.fn((src: unknown, dest: unknown) => {
      const s = String(src);
      if (s === injectReplacementAt) {
        // Hostile repair lands at the deletion boundary: unlink the dangling original
        // and write a NEW `.git` pointer to a different, live admin in its place, then
        // let production move whichever inode now occupies the pathname aside.
        actual.unlinkSync(s);
        actual.writeFileSync(s, replacementGitdirContent);
      }
      return actual.renameSync(s, String(dest));
    }),
  };
});

const dirs: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "reap-repl-race-"));
  dirs.push(root);
  return root;
}
afterEach(async () => {
  injectReplacementAt = null;
  replacementGitdirContent = "";
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("reapOrphanWorktrees replacement-pointer boundary", () => {
  it("preserves an orphan whose .git pointer is replaced with a LIVE pointer to a different admin at the deletion boundary", async () => {
    const root = tmpRoot();
    const worktrees = join(root, ".worktrees");
    const orphanDir = join(worktrees, "leaked-wt");
    const orphanDotGit = join(orphanDir, ".git");
    const admins = join(root, ".git", "worktrees");
    const liveOtherAdmin = join(admins, "other-live");
    const deadOwnAdmin = join(admins, "leaked-wt");
    mkdirSync(orphanDir, { recursive: true });
    mkdirSync(liveOtherAdmin, { recursive: true });
    // The orphan's `.git` is dangling: it points at its OWN admin entry which no longer exists.
    writeFileSync(orphanDotGit, `gitdir: ${deadOwnAdmin}\n`);

    // Arm the hostile repair for the orphan's `.git` path.
    injectReplacementAt = orphanDotGit;
    replacementGitdirContent = `gitdir: ${liveOtherAdmin}\n`;

    const mod = await import("../worktree/worktree-pool.js");
    const removed = await mod.reapOrphanWorktrees(root);

    expect(injectReplacementAt).not.toBeNull(); // defensive: the injection must have run
    // Fail closed: the repair must win. Nothing is removed, no residue, the live pointer
    // and the different live admin it targets survive.
    expect(removed).toBe(0);
    expect(existsSync(orphanDir)).toBe(true);
    expect(existsSync(orphanDotGit)).toBe(true);
    expect(readFileSync(orphanDotGit, "utf8")).toBe(`gitdir: ${liveOtherAdmin}\n`);
    expect(existsSync(liveOtherAdmin)).toBe(true);
    const reapResidue = readdirSync(worktrees).filter((n) => n.includes(".git-reap-"));
    expect(reapResidue).toEqual([]);
  });
});