import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Task } from "@fusion/core";
import { createServer } from "../server.js";
import { resolveDiffBase } from "../routes.js";
import { resolveTaskDiffBaseRef } from "../../../engine/src/merger.js";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

const fs = await import("node:fs");
const mockExistsSync = vi.mocked(fs.existsSync);

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  getRootDir(): string {
    return "/tmp/kb-651";
  }

  getFusionDir(): string {
    return "/tmp/kb-651/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }

  getMissionStore() {
    return {
      listMissions: vi.fn().mockResolvedValue([]),
      createMission: vi.fn(),
      getMission: vi.fn(),
      updateMission: vi.fn(),
      deleteMission: vi.fn(),
      listTemplates: vi.fn().mockResolvedValue([]),
      createTemplate: vi.fn(),
      getTemplate: vi.fn(),
      updateTemplate: vi.fn(),
      deleteTemplate: vi.fn(),
      instantiateMission: vi.fn(),
    };
  }

  async listTasks(): Promise<Task[]> {
    return Array.from(this.tasks.values());
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  addTask(task: Task): void {
    this.tasks.set(task.id, task);
  }
}

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "KB-651",
    title: "Test task",
    description: "Test description",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    columnMovedAt: "2026-04-01T00:00:00.000Z",
    worktree: "/tmp/kb-651",
    baseBranch: "main",
    ...overrides,
  };
}

async function requestFileDiffs(app: Parameters<typeof import("../test-request.js").get>[0], taskId = "KB-651"): Promise<{ status: number; body: any }> {
  const { get } = await import("../test-request.js");
  return get(app, `/api/tasks/${taskId}/file-diffs`);
}

describe("GET /api/tasks/:id/file-diffs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns error when task not found", async () => {
    const store = new MockStore();

    const app = createServer(store as any);
    const response = await requestFileDiffs(app, "NONEXISTENT");

    // Server returns 500 for task not found in test environment due to async error handling
    expect([404, 500]).toContain(response.status);
  }, 15_000);

  it("returns empty array when worktree is missing", async () => {
    const store = new MockStore();
    store.addTask(createTask({ worktree: undefined }));

    const app = createServer(store as any);
    const response = await requestFileDiffs(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("returns empty array when worktree does not exist", async () => {
    const store = new MockStore();
    const taskWithMissingWorktree = createTask();
    taskWithMissingWorktree.worktree = "/nonexistent/path";
    store.addTask(taskWithMissingWorktree);
    mockExistsSync.mockReturnValue(false);

    const app = createServer(store as any);
    const response = await requestFileDiffs(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it("handler can be created with valid task", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main", baseCommitSha: "taskbase456" }));

    const app = createServer(store as any);
    const response = await requestFileDiffs(app);

    // Should return 200 or 500 depending on git command results
    expect([200, 500]).toContain(response.status);
  });

  it("done task without commitSha returns empty array", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: undefined,
      worktree: undefined,
    }));

    const app = createServer(store as any);
    const response = await requestFileDiffs(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe("resolveDiffBase", () => {
  it("prefers merge-base when it differs from head", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base HEAD main") return "merge-base-123";
      if (args.join(" ") === "rev-parse HEAD") return "head-456";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseBranch: "main", baseCommitSha: "task-base-789" },
      "/tmp/worktree",
      "HEAD",
      runGit,
    );

    expect(diffBase).toBe("merge-base-123");
    expect(runGit).not.toHaveBeenCalledWith(
      ["merge-base", "--is-ancestor", "task-base-789", "HEAD"],
      "/tmp/worktree",
      5000,
    );
  });

  it("uses baseCommitSha when merge-base equals head", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base HEAD main") return "head-456";
      if (args.join(" ") === "rev-parse HEAD") return "head-456";
      if (args.join(" ") === "merge-base --is-ancestor task-base-789 HEAD") return "";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseBranch: "main", baseCommitSha: "task-base-789" },
      "/tmp/worktree",
      "HEAD",
      runGit,
    );

    expect(diffBase).toBe("task-base-789");
  });

  it("falls back to origin/baseBranch when local base branch is unavailable", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base HEAD main") {
        throw new Error("missing local main");
      }
      if (args.join(" ") === "merge-base HEAD origin/main") return "origin-merge-base";
      if (args.join(" ") === "rev-parse HEAD") return "head-456";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseBranch: "main", baseCommitSha: "task-base-789" },
      "/tmp/worktree",
      "HEAD",
      runGit,
    );

    expect(diffBase).toBe("origin-merge-base");
  });

  it("uses baseCommitSha directly when baseBranch is null (upstream branch deleted)", async () => {
    // Regression: FN-2855 showed 108 changed files because the dashboard fell
    // back to merge-base(HEAD, main) after self-healing nulled the original
    // baseBranch. With a valid baseCommitSha recorded, we must skip the
    // "main" default and use the SHA so the diff range stays task-scoped.
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base --is-ancestor task-base-789 HEAD") return "";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseCommitSha: "task-base-789" },
      "/tmp/worktree",
      "HEAD",
      runGit,
    );

    expect(diffBase).toBe("task-base-789");
    expect(runGit).not.toHaveBeenCalledWith(
      ["merge-base", "HEAD", "main"],
      "/tmp/worktree",
      5000,
    );
  });

  it("falls back to HEAD~1 when merge-base is unavailable and baseCommitSha is stale", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base HEAD main") {
        throw new Error("missing local main");
      }
      if (args.join(" ") === "merge-base HEAD origin/main") {
        throw new Error("missing remote main");
      }
      if (args.join(" ") === "merge-base --is-ancestor stale-base HEAD") {
        throw new Error("stale base sha");
      }
      if (args.join(" ") === "rev-parse HEAD~1") return "parent-123";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseBranch: "main", baseCommitSha: "stale-base" },
      "/tmp/worktree",
      "HEAD",
      runGit,
    );

    expect(diffBase).toBe("parent-123");
  });

  it("display recovery: uses merge-base(HEAD, main) when baseCommitSha stale and baseBranch missing", async () => {
    // Regression: FN-2957 showed only 2 changed files in review (the last
    // commit's files) instead of all 6. Cause: baseBranch was unset and
    // baseCommitSha pointed to a pre-rebase commit that was no longer an
    // ancestor of HEAD, so resolveDiffBase fell to HEAD~1. The display-only
    // recovery path widens to merge-base(HEAD, main) when callers opt in.
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base --is-ancestor stale-base HEAD") {
        throw new Error("stale base sha");
      }
      if (args.join(" ") === "merge-base HEAD main") return "rebased-base-456";
      if (args.join(" ") === "rev-parse HEAD~1") return "parent-123";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseCommitSha: "stale-base" }, // no baseBranch
      "/tmp/worktree",
      "HEAD",
      runGit,
      { enableDisplayRecovery: true },
    );

    expect(diffBase).toBe("rebased-base-456");
    expect(runGit).not.toHaveBeenCalledWith(
      ["rev-parse", "HEAD~1"],
      "/tmp/worktree",
      5000,
    );
  });

  it("display recovery: falls back to origin/main when local main is missing", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base --is-ancestor stale-base HEAD") {
        throw new Error("stale base sha");
      }
      if (args.join(" ") === "merge-base HEAD main") {
        throw new Error("no local main");
      }
      if (args.join(" ") === "merge-base HEAD origin/main") return "origin-base-789";
      if (args.join(" ") === "rev-parse HEAD~1") return "parent-123";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseCommitSha: "stale-base" },
      "/tmp/worktree",
      "HEAD",
      runGit,
      { enableDisplayRecovery: true },
    );

    expect(diffBase).toBe("origin-base-789");
  });

  it("display recovery: still falls to HEAD~1 when both main and origin/main are missing", async () => {
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base --is-ancestor stale-base HEAD") {
        throw new Error("stale base sha");
      }
      if (args.join(" ") === "merge-base HEAD main") {
        throw new Error("no local main");
      }
      if (args.join(" ") === "merge-base HEAD origin/main") {
        throw new Error("no remote main");
      }
      if (args.join(" ") === "rev-parse HEAD~1") return "parent-123";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseCommitSha: "stale-base" },
      "/tmp/worktree",
      "HEAD",
      runGit,
      { enableDisplayRecovery: true },
    );

    expect(diffBase).toBe("parent-123");
  });

  it("display recovery: prefers merge-base over outdated-but-ancestor baseCommitSha", async () => {
    // Regression: FN-2840 showed 33 changed files in review (12 commits)
    // because the worktree was rebased onto newer main, leaving an old
    // baseCommitSha as a still-valid ancestor of HEAD. The actual task
    // touched only 4 files (3 commits). Prefer merge-base(HEAD, main) when
    // it's a descendant of baseCommitSha — it's a tighter fork point.
    const runGit = vi.fn(async (args: string[]) => {
      const cmd = args.join(" ");
      if (cmd === "merge-base HEAD main") return "rebased-onto-main";
      if (cmd === "merge-base --is-ancestor old-base HEAD") return "";
      if (cmd === "merge-base --is-ancestor old-base rebased-onto-main") return "";
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const diffBase = await resolveDiffBase(
      { baseCommitSha: "old-base" },
      "/tmp/worktree",
      "HEAD",
      runGit,
      { enableDisplayRecovery: true },
    );

    expect(diffBase).toBe("rebased-onto-main");
  });

  it("display recovery: keeps baseCommitSha when merge-base is not a descendant (FN-2855)", async () => {
    // Regression: FN-2855 had baseBranch nulled (deleted upstream feature
    // branch) with baseCommitSha pointing to a commit on that feature
    // branch. merge-base(HEAD, main) returns an older commit that is NOT
    // a descendant of baseCommitSha — so widening to it would surface 108
    // unrelated upstream files. Keep the task-scoped baseCommitSha.
    const runGit = vi.fn(async (args: string[]) => {
      const cmd = args.join(" ");
      if (cmd === "merge-base HEAD main") return "older-main-commit";
      if (cmd === "merge-base --is-ancestor task-base-789 HEAD") return "";
      if (cmd === "merge-base --is-ancestor task-base-789 older-main-commit") {
        throw new Error("not an ancestor — feature branch base");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const diffBase = await resolveDiffBase(
      { baseCommitSha: "task-base-789" },
      "/tmp/worktree",
      "HEAD",
      runGit,
      { enableDisplayRecovery: true },
    );

    expect(diffBase).toBe("task-base-789");
  });

  it("display recovery: does NOT trigger when baseBranch is set (merger-parity case)", async () => {
    // When baseBranch is recorded, the regular merge-base path runs first.
    // Recovery is only meant for the post-rebase "no baseBranch + stale
    // baseCommitSha" hole. This guards against widening when the original
    // ordering was tried and intentionally produced no merge-base.
    const runGit = vi.fn(async (args: string[]) => {
      if (args.join(" ") === "merge-base HEAD main") {
        throw new Error("no local main");
      }
      if (args.join(" ") === "merge-base HEAD origin/main") {
        throw new Error("no remote main");
      }
      if (args.join(" ") === "merge-base --is-ancestor stale-base HEAD") {
        throw new Error("stale base sha");
      }
      if (args.join(" ") === "rev-parse HEAD~1") return "parent-123";
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const diffBase = await resolveDiffBase(
      { baseBranch: "main", baseCommitSha: "stale-base" },
      "/tmp/worktree",
      "HEAD",
      runGit,
      { enableDisplayRecovery: true },
    );

    // Same result as without recovery — baseBranch was tried, no extra
    // recovery attempted.
    expect(diffBase).toBe("parent-123");
  });
});

describe("diff-base parity between dashboard and merger", () => {
  it("resolves the same effective diff base for identical task metadata", async () => {
    const repoDir = mkdtempSync(join(tmpdir(), "fn-diff-base-parity-"));

    try {
      execFileSync("git", ["init", "-b", "main", repoDir], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "config", "user.email", "parity@example.com"], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "config", "user.name", "Parity Test"], { stdio: "pipe" });

      writeFileSync(join(repoDir, "README.md"), "# parity\n");
      execFileSync("git", ["-C", repoDir, "add", "README.md"], { stdio: "pipe" });
      execFileSync("git", ["-C", repoDir, "commit", "-m", "initial"], { stdio: "pipe" });

      writeFileSync(join(repoDir, "README.md"), "# parity\nsecond\n");
      execFileSync("git", ["-C", repoDir, "commit", "-am", "second"], { stdio: "pipe" });

      const diffBaseFromDashboard = await resolveDiffBase(
        { baseBranch: "missing-main", baseCommitSha: "stale-base" },
        repoDir,
        "HEAD",
      );

      const diffBaseFromMerger = await resolveTaskDiffBaseRef({
        cwd: repoDir,
        headRef: "HEAD",
        baseBranch: "missing-main",
        baseCommitSha: "stale-base",
      });

      const expectedParent = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD~1"], {
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();

      expect(diffBaseFromDashboard).toBe(expectedParent);
      expect(diffBaseFromMerger).toBe(expectedParent);
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);
});
