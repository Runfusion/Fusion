import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
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

async function getPath(store: RealGitStore, path: string): Promise<{ status: number; body: any }> {
  const app = createServer(store as any);
  const { get } = await import("../test-request.js");
  return get(app, path);
}

describe("FN-5154 attribution-restricted done diff routes", () => {
  it("uses landedFiles when attribution is restricted", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5154-attrib-restricted-"));
    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      const rebaseBaseSha = commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");
      commitFile(rootDir, "foreign.ts", "export const foreign = true;\n", "chore: catch-up");
      const commitSha = commitFile(rootDir, "own.ts", "export const own = true;\n", "feat(FN-9999): own work");

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-9999",
        title: "restricted",
        description: "restricted",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
        columnMovedAt: "2026-05-19T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: {
          commitSha,
          rebaseBaseSha,
          landedFiles: ["own.ts"],
          landedFilesAttributionRestricted: true,
          filesChanged: 1,
        },
      } as Task);

      const diff = await getPath(store, "/api/tasks/FN-9999/diff");
      expect(diff.status).toBe(200);
      expect(diff.body.stats.filesChanged).toBe(1);
      expect(diff.body.files.map((f: { path: string }) => f.path)).toEqual(["own.ts"]);

      const fileDiffs = await getPath(store, "/api/tasks/FN-9999/file-diffs");
      expect(fileDiffs.status).toBe(200);
      expect(fileDiffs.body.map((f: { path: string }) => f.path)).toEqual(["own.ts"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("filters to own attributed files when landedFiles metadata is absent", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5154-attrib-unrestricted-"));
    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      const rebaseBaseSha = commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");
      commitFile(rootDir, "foreign.ts", "export const foreign = true;\n", "chore: catch-up");
      const commitSha = commitFile(rootDir, "own.ts", "export const own = true;\n", "feat(FN-9999): own work");

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-9999",
        title: "unrestricted",
        description: "unrestricted",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
        columnMovedAt: "2026-05-19T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: {
          commitSha,
          rebaseBaseSha,
          filesChanged: 2,
        },
      } as Task);

      const diff = await getPath(store, "/api/tasks/FN-9999/diff");
      expect(diff.status).toBe(200);
      expect(diff.body.stats.filesChanged).toBe(1);
      expect(diff.body.files.map((f: { path: string }) => f.path)).toEqual(["own.ts"]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns empty restricted set for no-op verified short-circuit", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-5154-attrib-noop-"));
    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      const rebaseBaseSha = commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");
      commitFile(rootDir, "foreign.ts", "export const foreign = true;\n", "chore: catch-up");
      const commitSha = commitFile(rootDir, "own.ts", "export const own = true;\n", "feat(FN-9999): own work");

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-9999",
        title: "noop",
        description: "noop",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-19T00:00:00.000Z",
        updatedAt: "2026-05-19T00:00:00.000Z",
        columnMovedAt: "2026-05-19T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: {
          commitSha,
          rebaseBaseSha,
          landedFiles: [],
          noOpVerifiedShortCircuit: true,
          filesChanged: 0,
        },
      } as Task);

      const diff = await getPath(store, "/api/tasks/FN-9999/diff");
      expect(diff.status).toBe(200);
      expect(diff.body.files).toEqual([]);
      expect(diff.body.stats).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });

      const fileDiffs = await getPath(store, "/api/tasks/FN-9999/file-diffs");
      expect(fileDiffs.status).toBe(200);
      expect(fileDiffs.body).toEqual([]);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
