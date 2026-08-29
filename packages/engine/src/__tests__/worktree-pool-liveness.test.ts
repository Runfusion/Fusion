import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { classifyTaskWorktree, hasRequiredWorktreeFiles, hasUsableWorktreeShape, isUsableTaskWorktree } from "../worktree/worktree-pool.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;

function git(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function makeRepo(setup?: (rootDir: string) => void): string {
  const rootDir = mkdtempSync(join(tmpdir(), "fn-4682-root-"));
  git(rootDir, "git init -b main");
  git(rootDir, 'git config user.email "test@example.com"');
  git(rootDir, 'git config user.name "Test User"');
  setup?.(rootDir);
  return rootDir;
}

function makeWorktree(rootDir: string, branch = "feature"): string {
  const worktreePath = mkdtempSync(join(tmpdir(), "fn-4682-wt-"));
  rmSync(worktreePath, { recursive: true, force: true });
  git(rootDir, `git worktree add -b ${branch} ${JSON.stringify(worktreePath)} main`);
  return worktreePath;
}

const cleanupPaths: string[] = [];
function track(path: string): string {
  cleanupPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describeIfGit("worktree liveness gating (FN-4682)", () => {
  it("FN-4682: accepts node-root worktree", async () => {
    const rootDir = track(makeRepo((dir) => {
      writeFileSync(join(dir, "package.json"), '{"name":"root"}\n', "utf-8");
      git(dir, "git add package.json");
      git(dir, 'git commit -m "init"');
    }));
    const worktreePath = track(makeWorktree(rootDir, "node-root"));
    await expect(isUsableTaskWorktree(rootDir, worktreePath)).resolves.toBe(true);
  });

  it("FN-4682: accepts python-root worktree without package.json", async () => {
    const rootDir = track(makeRepo((dir) => {
      writeFileSync(join(dir, "requirements.txt"), "requests==2.31.0\n", "utf-8");
      git(dir, "git add requirements.txt");
      git(dir, 'git commit -m "init"');
    }));
    const worktreePath = track(makeWorktree(rootDir, "python-root"));
    await expect(isUsableTaskWorktree(rootDir, worktreePath)).resolves.toBe(true);
  });

  it("FN-4682: accepts nested-manifest worktree", async () => {
    const rootDir = track(makeRepo((dir) => {
      writeFileSync(join(dir, "requirements.txt"), "flask==3.0.0\n", "utf-8");
      mkdirSync(join(dir, "web"), { recursive: true });
      writeFileSync(join(dir, "web", "package.json"), '{"name":"web"}\n', "utf-8");
      git(dir, "git add requirements.txt web/package.json");
      git(dir, 'git commit -m "init"');
    }));
    const worktreePath = track(makeWorktree(rootDir, "nested-manifest"));
    await expect(isUsableTaskWorktree(rootDir, worktreePath)).resolves.toBe(true);
  });

  it("FN-4682: accepts empty registered worktree", async () => {
    const rootDir = track(makeRepo((dir) => {
      git(dir, 'git commit --allow-empty -m "init"');
    }));
    const worktreePath = track(makeWorktree(rootDir, "empty"));
    await expect(isUsableTaskWorktree(rootDir, worktreePath)).resolves.toBe(true);
  });

  it.each([
    {
      name: "ok",
      setup: () => {
        const rootDir = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "init"');
        }));
        const worktreePath = track(makeWorktree(rootDir, "ok"));
        return { rootDir, worktreePath };
      },
      expected: { ok: true } as const,
    },
    {
      name: "repo-root",
      setup: () => {
        const rootDir = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "init"');
        }));
        return { rootDir, worktreePath: rootDir };
      },
      expected: {
        ok: false,
        classification: "repo-root",
        reason: "worktree path is the project root, not a task worktree",
      } as const,
    },
    {
      name: "missing",
      setup: () => {
        const rootDir = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "init"');
        }));
        const worktreePath = join(tmpdir(), `fn-4682-missing-${Date.now()}`);
        return { rootDir, worktreePath };
      },
      expected: {
        ok: false,
        classification: "missing",
        reason: "worktree directory does not exist",
      } as const,
    },
    {
      name: "incomplete",
      setup: () => {
        const rootDir = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "init"');
        }));
        const worktreePath = track(mkdtempSync(join(tmpdir(), "fn-4682-incomplete-")));
        return { rootDir, worktreePath };
      },
      expected: {
        ok: false,
        classification: "incomplete",
        reason: "missing .git metadata",
      } as const,
    },
    {
      name: "unregistered",
      setup: () => {
        const rootDir = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "init"');
        }));
        const worktreePath = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "standalone"');
        }));
        return { rootDir, worktreePath };
      },
      expected: {
        ok: false,
        classification: "unregistered",
        reason: "not registered in git worktree list",
      } as const,
    },
    {
      name: "outside-work-tree",
      setup: () => {
        const rootDir = track(makeRepo((dir) => {
          git(dir, 'git commit --allow-empty -m "init"');
        }));
        const worktreePath = track(makeWorktree(rootDir, "outside-work-tree"));
        rmSync(join(worktreePath, ".git"), { recursive: true, force: true });
        writeFileSync(join(worktreePath, ".git"), "gitdir: /tmp/nonexistent\n", "utf-8");
        return { rootDir, worktreePath };
      },
      expected: {
        ok: false,
        classification: "outside-work-tree",
        reason: "git rev-parse --is-inside-work-tree returned false",
      } as const,
    },
  ])("FN-4935: classifyTaskWorktree %s", async ({ setup, expected }) => {
    const { rootDir, worktreePath } = setup();
    await expect(classifyTaskWorktree(rootDir, worktreePath)).resolves.toEqual(expected);
  });

  it("FN-6861: rejects canonical-equal repo root paths before accepting registered worktrees", async () => {
    const rootDir = track(makeRepo((dir) => {
      git(dir, 'git commit --allow-empty -m "init"');
    }));
    await expect(classifyTaskWorktree(rootDir, `${rootDir}/`)).resolves.toEqual({
      ok: false,
      classification: "repo-root",
      reason: "worktree path is the project root, not a task worktree",
    });
  });

  it("FN-4682: rejects missing worktree directory", async () => {
    const rootDir = track(makeRepo((dir) => {
      git(dir, 'git commit --allow-empty -m "init"');
    }));
    const missingPath = join(tmpdir(), `fn-4682-missing-${Date.now()}`);
    await expect(isUsableTaskWorktree(rootDir, missingPath)).resolves.toBe(false);
  });

  it("FN-4682: rejects incomplete worktree without .git entry", async () => {
    const rootDir = track(makeRepo((dir) => {
      git(dir, 'git commit --allow-empty -m "init"');
    }));
    const incompletePath = track(mkdtempSync(join(tmpdir(), "fn-4682-incomplete-")));
    await expect(isUsableTaskWorktree(rootDir, incompletePath)).resolves.toBe(false);
  });

  it("FN-4682: rejects unregistered git repository", async () => {
    const rootDir = track(makeRepo((dir) => {
      git(dir, 'git commit --allow-empty -m "init"');
    }));
    const standalonePath = track(makeRepo((dir) => {
      git(dir, 'git commit --allow-empty -m "standalone"');
    }));
    await expect(isUsableTaskWorktree(rootDir, standalonePath)).resolves.toBe(false);
  });

  it("FN-4682: hasRequiredWorktreeFiles accepts .git directory", () => {
    const path = track(mkdtempSync(join(tmpdir(), "fn-4682-git-dir-")));
    mkdirSync(join(path, ".git"), { recursive: true });
    expect(hasRequiredWorktreeFiles(path)).toBe(true);
  });

  it("FN-4682: hasRequiredWorktreeFiles accepts .git file", () => {
    const path = track(mkdtempSync(join(tmpdir(), "fn-4682-git-file-")));
    writeFileSync(join(path, ".git"), "gitdir: /tmp/fake\n", "utf-8");
    expect(hasRequiredWorktreeFiles(path)).toBe(true);
  });

  it("FN-4682: hasRequiredWorktreeFiles rejects missing .git", () => {
    const path = track(mkdtempSync(join(tmpdir(), "fn-4682-no-git-")));
    expect(hasRequiredWorktreeFiles(path)).toBe(false);
  });

  /*
  FNXC:WorktreeLiveness 2026-07-26-08:20:
  `hasUsableWorktreeShape` is the sync, non-spawning probe recovery paths use instead of the
  canonical async `classifyTaskWorktree`. These cases pin BOTH halves of its contract: what it
  rejects, and — just as important — the narrower guarantee it makes, so a future caller does not
  mistake it for the full classifier. Every "reads as usable" case below is a shape the caller must
  still be able to survive.
  */
  describe("hasUsableWorktreeShape (sync recovery-path probe)", () => {
    it("rejects empty, missing, and .git-less paths", () => {
      const missing = join(track(mkdtempSync(join(tmpdir(), "fn-8594-missing-"))), "gone");
      const noGit = track(mkdtempSync(join(tmpdir(), "fn-8594-no-git-")));
      expect(hasUsableWorktreeShape(undefined)).toBe(false);
      expect(hasUsableWorktreeShape(null)).toBe(false);
      expect(hasUsableWorktreeShape("")).toBe(false);
      expect(hasUsableWorktreeShape(missing)).toBe(false);
      expect(hasUsableWorktreeShape(noGit)).toBe(false);
    });

    it("accepts a real registered task worktree", () => {
      const rootDir = track(makeRepo((dir) => {
        git(dir, 'git commit --allow-empty -m "init"');
      }));
      const worktreePath = track(makeWorktree(rootDir, "shape-ok"));
      expect(hasUsableWorktreeShape(worktreePath, rootDir)).toBe(true);
    });

    it("rejects the repo root when rootDir is supplied, and cannot detect it without one", () => {
      const rootDir = track(makeRepo((dir) => {
        git(dir, 'git commit --allow-empty -m "init"');
      }));
      // FN-6861: the main checkout is a registered worktree carrying `.git`, so the repo-root gate
      // is the ONLY thing that keeps it from reading as a usable task worktree.
      expect(hasUsableWorktreeShape(rootDir, rootDir)).toBe(false);
      expect(hasUsableWorktreeShape(rootDir)).toBe(true);
    });

    it("still reads a de-registered worktree with a dangling gitdir as usable (documented limit)", () => {
      const rootDir = track(makeRepo((dir) => {
        git(dir, 'git commit --allow-empty -m "init"');
      }));
      const worktreePath = track(makeWorktree(rootDir, "shape-deregistered"));
      // Break the link the way `git worktree prune` / a manual admin-dir delete would.
      writeFileSync(join(worktreePath, ".git"), "gitdir: /nonexistent/.git/worktrees/gone\n", "utf-8");
      // The probe cannot see this without spawning git — callers must tolerate it, and the
      // executor's own session-start assertion is the backstop that rejects the checkout.
      expect(hasUsableWorktreeShape(worktreePath, rootDir)).toBe(true);
      // The canonical classifier DOES catch it, which is why it stays the default.
      return expect(isUsableTaskWorktree(rootDir, worktreePath)).resolves.toBe(false);
    });
  });
});
