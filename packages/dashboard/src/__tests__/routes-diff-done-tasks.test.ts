import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Task, TaskCommitAssociation } from "@fusion/core";
import { EventEmitter } from "node:events";
import { createServer } from "../server.js";

type Shortstat = { filesChanged: number; additions: number; deletions: number };

class RealGitStore extends EventEmitter {
  private tasks = new Map<string, Task>();
  private associations = new Map<string, TaskCommitAssociation[]>();

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
    return {
      listMissions: async () => [],
      listTemplates: async () => [],
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

  setAssociations(lineageId: string, associations: TaskCommitAssociation[]): void {
    this.associations.set(lineageId, associations);
  }

  async getTaskCommitAssociationsByLineageId(lineageId: string): Promise<TaskCommitAssociation[]> {
    return this.associations.get(lineageId) ?? [];
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

function parseShortstat(output: string): Shortstat {
  const fileMatch = output.match(/(\d+) files? changed/);
  const addMatch = output.match(/(\d+) insertions?\(\+\)/);
  const delMatch = output.match(/(\d+) deletions?\(-\)/);
  return {
    filesChanged: fileMatch ? Number(fileMatch[1]) : 0,
    additions: addMatch ? Number(addMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  };
}

function shortstatForShow(cwd: string, sha: string): Shortstat {
  const output = git(cwd, "show", "--shortstat", "--format=", sha);
  return parseShortstat(output);
}

function shortstatForRange(cwd: string, range: string): Shortstat {
  return parseShortstat(git(cwd, "diff", "--shortstat", range));
}

function shortstatForLineage(cwd: string, shas: string[]): Shortstat {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const sha of shas) {
    const patchStats = parseShortstat(git(cwd, "show", "--shortstat", "--format=", sha));
    additions += patchStats.additions;
    deletions += patchStats.deletions;

    const names = git(cwd, "diff", "--name-only", "-M", `${sha}^..${sha}`)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const name of names) {
      files.add(name);
    }
  }

  return {
    filesChanged: files.size,
    additions,
    deletions,
  };
}

function mkAssoc(lineageId: string, sha: string, authoredAt: string): TaskCommitAssociation {
  return {
    lineageId,
    commitSha: sha,
    commitSubject: sha,
    authoredAt,
    matchedBy: "manual",
    confidence: 1,
    taskIdSnapshot: "FN-4524",
    note: null,
    createdAt: authoredAt,
    updatedAt: authoredAt,
  };
}

async function getDoneDiff(store: RealGitStore, taskId = "FN-4524") {
  const app = createServer(store as any);
  const { get } = await import("../test-request.js");
  return get(app, `/api/tasks/${taskId}/diff`);
}

describe("FN-4524 done-task diff stats", () => {
  it("matches shortstat and excludes interleaved foreign commit files", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4524-done-lineage-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.txt", "base\n", "A base");

      git(rootDir, "checkout", "-b", "task-branch");
      const commitB = commitFile(rootDir, "a.ts", "export const a = 1;\n", "B task change a");

      git(rootDir, "checkout", "main");
      commitFile(rootDir, "unrelated.ts", "export const unrelated = true;\n", "C foreign change");

      git(rootDir, "checkout", "task-branch");
      git(rootDir, "merge", "main", "--no-edit");
      const commitD = commitFile(rootDir, "b.ts", "export const b = 2;\n", "D task change b");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "task-branch", "--no-ff", "-m", "M merge task branch");
      const mergeCommit = git(rootDir, "rev-parse", "HEAD");
      const expected = shortstatForLineage(rootDir, [commitB, commitD]);

      const lineageId = "lin-fn-4524-a";
      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "lineage test",
        description: "lineage test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        lineageId,
        baseBranch: "main",
        mergeDetails: { filesChanged: expected.filesChanged },
      } as Task);
      store.setAssociations(lineageId, [
        mkAssoc(lineageId, commitB, "2026-05-14T00:00:01.000Z"),
        mkAssoc(lineageId, commitD, "2026-05-14T00:00:02.000Z"),
      ]);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats).toEqual(expected);
      const paths = response.body.files.map((f: { path: string }) => f.path);
      expect(paths).not.toContain("unrelated.ts");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("deduplicates rename across lineage and matches shortstat", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4524-done-rename-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "old.ts", "export const value = 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      git(rootDir, "mv", "old.ts", "new.ts");
      git(rootDir, "commit", "-m", "rename old to new");
      const renameCommit = git(rootDir, "rev-parse", "HEAD");
      commitFile(rootDir, "new.ts", "export const value = 2;\n", "modify renamed file");
      const modifyCommit = git(rootDir, "rev-parse", "HEAD");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "task-branch", "--no-ff", "-m", "merge rename branch");
      const mergeCommit = git(rootDir, "rev-parse", "HEAD");
      const expected = shortstatForLineage(rootDir, [renameCommit, modifyCommit]);

      const lineageId = "lin-fn-4524-b";
      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "rename test",
        description: "rename test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        lineageId,
        baseBranch: "main",
        mergeDetails: { filesChanged: expected.filesChanged },
      } as Task);
      store.setAssociations(lineageId, [
        mkAssoc(lineageId, renameCommit, "2026-05-14T00:00:01.000Z"),
        mkAssoc(lineageId, modifyCommit, "2026-05-14T00:00:02.000Z"),
      ]);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats.filesChanged).toBe(expected.filesChanged);
      const renamed = response.body.files.filter((f: { path: string }) => f.path === "new.ts");
      expect(renamed).toHaveLength(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("counts copy destination once across lineage and matches shortstat", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4524-done-copy-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "source.ts", "export const source = 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      writeFileSync(join(rootDir, "copy.ts"), readFileSync(join(rootDir, "source.ts"), "utf8"));
      git(rootDir, "add", "copy.ts");
      git(rootDir, "commit", "-m", "copy source to copy");
      const copyCommit = git(rootDir, "rev-parse", "HEAD");
      commitFile(rootDir, "copy.ts", "export const source = 2;\n", "modify copy");
      const modifyCommit = git(rootDir, "rev-parse", "HEAD");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "task-branch", "--no-ff", "-m", "merge copy branch");
      const mergeCommit = git(rootDir, "rev-parse", "HEAD");
      const expected = shortstatForLineage(rootDir, [copyCommit, modifyCommit]);

      const lineageId = "lin-fn-4524-c";
      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "copy test",
        description: "copy test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        lineageId,
        baseBranch: "main",
        mergeDetails: { filesChanged: expected.filesChanged },
      } as Task);
      store.setAssociations(lineageId, [
        mkAssoc(lineageId, copyCommit, "2026-05-14T00:00:01.000Z"),
        mkAssoc(lineageId, modifyCommit, "2026-05-14T00:00:02.000Z"),
      ]);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats).toEqual(expected);
      const copied = response.body.files.filter((f: { path: string }) => f.path === "copy.ts");
      expect(copied).toHaveLength(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("matches shortstat for squash-merge done task with commitSha only", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4524-done-squash-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      commitFile(rootDir, "x.ts", "export const x = 1;\n", "task x");
      commitFile(rootDir, "y.ts", "export const y = 1;\n", "task y");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "--squash", "task-branch");
      git(rootDir, "commit", "-m", "squash merge task");
      const squashCommit = git(rootDir, "rev-parse", "HEAD");
      const expected = shortstatForShow(rootDir, squashCommit);

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "squash test",
        description: "squash test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: { commitSha: squashCommit, filesChanged: expected.filesChanged },
      } as Task);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats).toEqual(expected);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("uses live shortstat for done tasks even when mergeDetails stats are stale", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4527-done-stale-merge-details-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      commitFile(rootDir, "one.ts", "export const one = 1;\n", "task one");
      commitFile(rootDir, "two.ts", "export const two = 2;\n", "task two");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "--squash", "task-branch");
      git(rootDir, "commit", "-m", "squash merge task");
      const squashCommit = git(rootDir, "rev-parse", "HEAD");
      const expected = shortstatForShow(rootDir, squashCommit);
      expect(expected).toEqual({ filesChanged: 2, additions: 2, deletions: 0 });

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "stale mergeDetails test",
        description: "stale mergeDetails test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: {
          commitSha: squashCommit,
          filesChanged: 108,
          insertions: 999,
          deletions: 999,
        },
      } as Task);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats).toEqual(expected);
      expect(response.body.stats).not.toEqual({ filesChanged: 108, additions: 999, deletions: 999 });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns zero stats when merge SHA is unresolvable even if mergeDetails has stored counts", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4527-done-no-merge-sha-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");
      commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");

      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "missing sha test",
        description: "missing sha test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        baseBranch: "main",
        mergeDetails: {
          filesChanged: 108,
          insertions: 999,
          deletions: 999,
        },
      } as Task);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats).toEqual({ filesChanged: 0, additions: 0, deletions: 0 });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns lineage-union stats when final commit shortstat undercounts multi-commit landed scope", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4613-done-lineage-union-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      writeFileSync(join(rootDir, "a.ts"), "export const a = 1;\n");
      writeFileSync(join(rootDir, "b.ts"), "export const b = 1;\n");
      git(rootDir, "add", "a.ts", "b.ts");
      git(rootDir, "commit", "-m", "task source files");
      const commitOne = git(rootDir, "rev-parse", "HEAD");

      mkdirSync(join(rootDir, ".changeset"), { recursive: true });
      writeFileSync(join(rootDir, "notes.md"), "# notes\nrefinement\n");
      writeFileSync(join(rootDir, ".changeset/fn-4613-test.md"), "---\n\"@runfusion/fusion\": patch\n---\n\nTest note.\n");
      git(rootDir, "add", "notes.md", ".changeset/fn-4613-test.md");
      git(rootDir, "commit", "-m", "task docs and changeset");
      const finalCommit = git(rootDir, "rev-parse", "HEAD");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "task-branch", "--no-ff", "-m", "merge multi-commit task");

      const lineageId = "lin-fn-4613-a";
      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "multi-commit lineage test",
        description: "multi-commit lineage test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        lineageId,
        baseBranch: "main",
        mergeDetails: { commitSha: finalCommit },
      } as Task);
      store.setAssociations(lineageId, [
        mkAssoc(lineageId, commitOne, "2026-05-14T00:00:01.000Z"),
        mkAssoc(lineageId, finalCommit, "2026-05-14T00:00:02.000Z"),
      ]);

      const finalCommitOnly = shortstatForShow(rootDir, finalCommit);
      expect(finalCommitOnly.filesChanged).toBe(2);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats.filesChanged).toBe(4);
      expect(response.body.files).toHaveLength(4);
      expect(response.body.stats.filesChanged).toBeGreaterThan(finalCommitOnly.filesChanged);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("ignores persisted modifiedFiles superset and returns lineage diff totals", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "fn-4613-stale-modified-files-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "base.ts", "export const base = 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      const commitOne = commitFile(rootDir, "one.ts", "export const one = 1;\n", "one");
      const commitTwo = commitFile(rootDir, "two.ts", "export const two = 2;\n", "two");
      const commitThree = commitFile(rootDir, "readme.md", "task docs\n", "docs");
      mkdirSync(join(rootDir, ".changeset"), { recursive: true });
      const commitFour = commitFile(rootDir, ".changeset/fn-4613-superset.md", "---\n\"@runfusion/fusion\": patch\n---\n\nSuperset test.\n", "changeset");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "task-branch", "--no-ff", "-m", "merge stale modifiedFiles case");

      const lineageId = "lin-fn-4613-b";
      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "stale modifiedFiles test",
        description: "stale modifiedFiles test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        lineageId,
        baseBranch: "main",
        modifiedFiles: Array.from({ length: 10 }, (_, index) => `stale/path-${index + 1}.ts`),
        mergeDetails: { commitSha: commitFour },
      } as Task);
      store.setAssociations(lineageId, [
        mkAssoc(lineageId, commitOne, "2026-05-14T00:00:01.000Z"),
        mkAssoc(lineageId, commitTwo, "2026-05-14T00:00:02.000Z"),
        mkAssoc(lineageId, commitThree, "2026-05-14T00:00:03.000Z"),
        mkAssoc(lineageId, commitFour, "2026-05-14T00:00:04.000Z"),
      ]);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats.filesChanged).toBe(4);
      expect(response.body.files).toHaveLength(4);
      expect(response.body.files.map((f: { path: string }) => f.path)).not.toContain("stale/path-1.ts");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("matches shortstat when hunks include ++/-- content lines", async () => {    const rootDir = mkdtempSync(join(tmpdir(), "fn-4524-done-plusminus-"));

    try {
      git(rootDir, "init", "-b", "main");
      git(rootDir, "config", "user.email", "fusion@example.com");
      git(rootDir, "config", "user.name", "Fusion");

      commitFile(rootDir, "counter.ts", "let counter = 0;\ncounter += 1;\n", "base");

      git(rootDir, "checkout", "-b", "task-branch");
      const patchCommit = commitFile(rootDir, "counter.ts", "let counter = 0;\n++counter;\n--counter;\n", "introduce ++ and -- lines");

      git(rootDir, "checkout", "main");
      git(rootDir, "merge", "task-branch", "--no-ff", "-m", "merge plusminus");
      const mergeCommit = git(rootDir, "rev-parse", "HEAD");
      const expected = shortstatForLineage(rootDir, [patchCommit]);

      const lineageId = "lin-fn-4524-d";
      const store = new RealGitStore(rootDir);
      store.addTask({
        id: "FN-4524",
        title: "plusminus test",
        description: "plusminus test",
        column: "done",
        dependencies: [],
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        columnMovedAt: "2026-05-14T00:00:00.000Z",
        lineageId,
        baseBranch: "main",
        mergeDetails: { filesChanged: expected.filesChanged },
      } as Task);
      store.setAssociations(lineageId, [mkAssoc(lineageId, patchCommit, "2026-05-14T00:00:01.000Z")]);

      const response = await getDoneDiff(store);
      expect(response.status).toBe(200);
      expect(response.body.stats).toEqual(expected);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
