import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeSessionRegistry } from "../../agents/active-session-registry.js";
import { classifyStaleLock, tryRemoveStaleLock } from "../../worktree/worktree-stale-lock.js";
import { git, hasGit } from "./_helpers.js";

describe.skipIf(!hasGit)("reliability interactions: worktree stale lock recovery", () => {
  const roots: string[] = [];
  afterEach(async () => {
    activeSessionRegistry.clear();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  async function setupRepo() {
    const root = await mkdtemp(join(tmpdir(), "fusion-stale-lock-"));
    roots.push(root);
    git(root, "git init -b main");
    git(root, 'git config user.email "test@example.com"');
    git(root, 'git config user.name "Test User"');
    await writeFile(join(root, "README.md"), "# repo\n", "utf-8");
    git(root, "git add README.md");
    git(root, 'git commit -m "init"');
    return root;
  }

  it("classifies stale lock and removes it", async () => {
    const root = await setupRepo();
    const lockPath = join(root, ".git", "index.lock");
    await writeFile(lockPath, "lock", "utf-8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);

    const classification = await classifyStaleLock({ rootDir: root, lockPath, activeSessionRegistry });
    expect(classification.kind).toBe("stale");

    const removed = await tryRemoveStaleLock({ lockPath });
    expect(removed.removed).toBe(true);
    await expect(stat(lockPath)).rejects.toBeTruthy();
  });

  it("classifies active-session and preserves lock", async () => {
    const root = await setupRepo();
    const lockPath = join(root, ".git", "index.lock");
    await writeFile(lockPath, "lock", "utf-8");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    activeSessionRegistry.registerPath(root, { taskId: "FN-OWNER", kind: "executor", ownerKey: "owner" });

    const classification = await classifyStaleLock({ rootDir: root, lockPath, activeSessionRegistry });
    expect(classification.kind).toBe("active-session");
    await expect(stat(lockPath)).resolves.toBeTruthy();
  });

  it("returns one terminal outcome per classification branch", async () => {
    const root = await setupRepo();
    const staleLockPath = join(root, ".git", "index.lock");
    await writeFile(staleLockPath, "lock", "utf-8");
    const old = new Date(Date.now() - 120_000);
    await utimes(staleLockPath, old, old);

    const stale = await classifyStaleLock({ rootDir: root, lockPath: staleLockPath, activeSessionRegistry });
    const staleTerminal = stale.kind === "stale" ? "worktree:stale-lock-recovered" : "worktree:stale-lock-refused";
    expect(["worktree:stale-lock-recovered", "worktree:stale-lock-refused"]).toContain(staleTerminal);

    await writeFile(staleLockPath, "lock", "utf-8");
    await utimes(staleLockPath, old, old);
    activeSessionRegistry.registerPath(root, { taskId: "FN-OWNER-2", kind: "executor", ownerKey: "owner-2" });
    const active = await classifyStaleLock({ rootDir: root, lockPath: staleLockPath, activeSessionRegistry });
    const activeTerminal = active.kind === "stale" ? "worktree:stale-lock-recovered" : "worktree:stale-lock-refused";
    expect(activeTerminal).toBe("worktree:stale-lock-refused");
  });
});
