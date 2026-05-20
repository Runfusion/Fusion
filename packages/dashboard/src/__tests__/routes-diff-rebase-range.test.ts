import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";

const gitCalls: string[] = [];

vi.mock("../routes/resolve-diff-base.js", async () => {
  const actual = await vi.importActual<typeof import("../routes/resolve-diff-base.js")>("../routes/resolve-diff-base.js");
  return {
    ...actual,
    runGitCommand: async (args: string[], cwd: string, timeoutMs?: number) => {
      gitCalls.push(args.join(" "));
      return actual.runGitCommand(args, cwd, timeoutMs);
    },
  };
});

import { createServer } from "../server.js";

class RealGitStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  constructor(private rootDir: string) {
    super();
  }

  getRootDir(): string {
    return this.rootDir;
  }

  getFusionDir(): string {
    return join(this.rootDir, ".fusion");
  }

  getDatabase() {
    return {
      exec: () => {},
      prepare: () => ({ run: () => ({ changes: 0 }), get: () => undefined, all: () => [] }),
    };
  }

  getMissionStore() {
    return { listMissions: async () => [], listTemplates: async () => [] };
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

  async getTaskCommitAssociationsByLineageId(): Promise<any[]> {
    return [];
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

function parseShortstat(output: string) {
  const fileMatch = output.match(/(\d+) files? changed/);
  const addMatch = output.match(/(\d+) insertions?\(\+\)/);
  const delMatch = output.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: fileMatch ? Number(fileMatch[1]) : 0,
    additions: addMatch ? Number(addMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  };
}

async function getDiff(store: RealGitStore): Promise<{ status: number; body: any }> {
  const app = createServer(store as any);
  const { get } = await import("../test-request.js");
  return get(app, "/api/tasks/FN-4754/diff");
}

describe("FN-4754 rebase range diff display", () => {
  beforeEach(() => {
    gitCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses rebaseBaseSha..commitSha range and matches direct shortstat", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4754-rebase-range-"));
    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.txt", "base\n", "base");
      git(rootDir, "checkout", "-b", "task");
      commitFile(rootDir, "task.txt", "line 1\n", "feat(FN-4754): task-1");
      commitFile(rootDir, "task.txt", "line 1\nline 2\n", "feat(FN-4754): task-2");
      commitFile(rootDir, "task2.txt", "line a\n", "feat(FN-4754): task-3");

      git(rootDir, "checkout", "main");
      commitFile(rootDir, "main.txt", "main advance\n", "main-advance");

      git(rootDir, "checkout", "task");
      git(rootDir, "rebase", "main");

      const rebaseBaseSha = git(rootDir, "merge-base", "task", "main");
      const commitSha = git(rootDir, "rev-parse", "task");

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4754",
        title: "rebase range",
        description: "rebase range",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
        columnMovedAt: "2026-05-16T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: { commitSha, rebaseBaseSha, filesChanged: 2 },
      } as Task);

      const response = await getDiff(store);
      expect(response.status).toBe(200);

      const expected = parseShortstat(git(rootDir, "diff", "--shortstat", `${rebaseBaseSha}..${commitSha}`));
      expect(response.body.stats).toEqual(expected);

      expect(gitCalls.some((entry) => entry.includes(`diff --name-status -M ${rebaseBaseSha}..${commitSha}`))).toBe(true);
      expect(gitCalls.some((entry) => entry === `show --shortstat --format= ${commitSha}`)).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("falls back to single-commit diff and logs warning when rebase base is not ancestor", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4754-rebase-fallback-"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.txt", "base\n", "base");
      git(rootDir, "checkout", "-b", "task");
      const commitSha = commitFile(rootDir, "task.txt", "task\n", "feat(FN-4754): task-1");
      git(rootDir, "checkout", "main");
      const nonAncestor = commitFile(rootDir, "foreign.txt", "foreign\n", "foreign");

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4754",
        title: "fallback",
        description: "fallback",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-16T00:00:00.000Z",
        updatedAt: "2026-05-16T00:00:00.000Z",
        columnMovedAt: "2026-05-16T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: { commitSha, rebaseBaseSha: nonAncestor, filesChanged: 1 },
      } as Task);

      const response = await getDiff(store);
      expect(response.status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[diff] done task FN-4754: mergeDetails.rebaseBaseSha"));
      expect(gitCalls.some((entry) => entry.includes(`diff --name-status -M ${nonAncestor}..${commitSha}`))).toBe(false);
      expect(gitCalls.some((entry) => entry.includes(`rev-list --parents -n 1 ${commitSha}`))).toBe(true);
    } finally {
      warnSpy.mockRestore();
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
