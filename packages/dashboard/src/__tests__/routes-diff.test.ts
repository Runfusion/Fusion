import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Task } from "@fusion/core";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { get } from "../test-request.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execSync: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { createServer } from "../server.js";

const mockExecSync = vi.mocked(childProcess.execSync);
const mockExistsSync = vi.mocked(fs.existsSync);

class MockStore extends EventEmitter {
  private tasks = new Map<string, Task>();

  getRootDir(): string {
    return "/tmp/fn-679";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({ run: vi.fn().mockReturnValue({ changes: 0 }), get: vi.fn(), all: vi.fn().mockReturnValue([]) }),
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
    id: "FN-679",
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
    worktree: "/tmp/fn-679",
    baseBranch: "main",
    ...overrides,
  };
}

async function requestDiff(app: Parameters<typeof get>[0], taskId = "FN-679", worktree?: string): Promise<{ status: number; body: any }> {
  const url = `/api/tasks/${taskId}/diff${worktree ? `?worktree=${encodeURIComponent(worktree)}` : ""}`;
  return await get(app, url);
}

/**
 * The diff endpoint uses resolveDiffBase() which:
 * 1. Checks task.baseCommitSha (if present, validates with git merge-base --is-ancestor)
 * 2. Runs `git merge-base HEAD origin/<baseBranch>` falling back to `git merge-base HEAD <baseBranch>`
 * 3. Falls back to `git rev-parse HEAD~1`
 * Then uses two-dot syntax: `git diff --name-status <diffBase>..HEAD`
 * Plus a separate working-tree diff: `git diff --name-status`
 */
describe("GET /api/tasks/:id/diff", () => {
  const FAKE_MERGE_BASE = "abc123def";

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses merge-base to resolve diff base from baseBranch", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "develop" }));
    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // resolveDiffBase: merge-base lookup
      if (cmd.includes("git merge-base HEAD origin/develop") || cmd.includes("git merge-base HEAD develop")) {
        return `${FAKE_MERGE_BASE}\n` as any;
      }
      // committed diff
      if (cmd === `git diff --name-status ${FAKE_MERGE_BASE}..HEAD`) {
        return "M\tsrc/app.ts\nA\tsrc/new.ts\n" as any;
      }
      // working tree diff
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      // file patches
      if (cmd === `git diff ${FAKE_MERGE_BASE}..HEAD -- "src/app.ts"`) {
        return `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 const foo = "bar";
+const baz = "qux";
` as any;
      }
      if (cmd === `git diff ${FAKE_MERGE_BASE}..HEAD -- "src/new.ts"`) {
        return `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+const newFile = true;
` as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(2);
    expect(response.body.files[0].path).toBe("src/app.ts");
    expect(response.body.files[0].status).toBe("modified");
    expect(response.body.files[1].path).toBe("src/new.ts");
    expect(response.body.files[1].status).toBe("added");
  });

  it("defaults to main when baseBranch is not set", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: undefined }));
    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("git merge-base HEAD origin/main") || cmd.includes("git merge-base HEAD main")) {
        return `${FAKE_MERGE_BASE}\n` as any;
      }
      if (cmd === `git diff --name-status ${FAKE_MERGE_BASE}..HEAD`) {
        return "M\tsrc/index.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === `git diff ${FAKE_MERGE_BASE}..HEAD -- "src/index.ts"`) {
        return `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,2 +1,3 @@
 const app = true;
+const initialized = true;
` as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    // Verify merge-base was called with main (default)
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("merge-base HEAD"),
      expect.objectContaining({ cwd: "/tmp/fn-679" }),
    );
  });

  it("returns 404 when task not found", async () => {
    const store = new MockStore();

    const app = createServer(store as any);
    const response = await requestDiff(app, "NONEXISTENT");

    expect(response.status).toBe(404);
    expect(response.body.error).toBe("Task not found");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("uses provided worktree path from query param", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "feature" }));
    mockExecSync.mockImplementation((command, opts) => {
      const cmd = String(command);
      if (cmd.includes("git merge-base")) {
        return `${FAKE_MERGE_BASE}\n` as any;
      }
      if (cmd === `git diff --name-status ${FAKE_MERGE_BASE}..HEAD`) {
        return "M\tpackage.json\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === `git diff ${FAKE_MERGE_BASE}..HEAD -- "package.json"`) {
        return `diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,3 +1,4 @@
 {
   "name": "test",
+  "version": "1.0.0"
 }
` as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app, "FN-679", "/custom/worktree/path");

    expect(response.status).toBe(200);
    // The custom worktree should be used as cwd
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("merge-base"),
      expect.objectContaining({ cwd: "/custom/worktree/path" }),
    );
  });

  it("falls back when merge-base fails", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "nonexistent" }));
    const FALLBACK_SHA = "fallbacksha123";
    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // merge-base fails
      if (cmd.includes("git merge-base")) {
        throw new Error("merge-base failed");
      }
      // HEAD~1 fallback
      if (cmd === "git rev-parse HEAD~1") {
        return `${FALLBACK_SHA}\n` as any;
      }
      if (cmd === `git diff --name-status ${FALLBACK_SHA}..HEAD`) {
        return "M\tREADME.md\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === `git diff ${FALLBACK_SHA}..HEAD -- "README.md"`) {
        return `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Test
+New content
` as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
  });

  it("returns empty files array when no changes", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));
    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("git merge-base")) {
        return `${FAKE_MERGE_BASE}\n` as any;
      }
      // Both diffs return empty
      return "" as any;
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([]);
    expect(response.body.stats).toEqual({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("correctly counts additions and deletions in patches", async () => {
    const store = new MockStore();
    store.addTask(createTask({ baseBranch: "main" }));
    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd.includes("git merge-base")) {
        return `${FAKE_MERGE_BASE}\n` as any;
      }
      if (cmd === `git diff --name-status ${FAKE_MERGE_BASE}..HEAD`) {
        return "M\tsrc/changes.ts\n" as any;
      }
      if (cmd === "git diff --name-status") {
        return "" as any;
      }
      if (cmd === `git diff ${FAKE_MERGE_BASE}..HEAD -- "src/changes.ts"`) {
        return `diff --git a/src/changes.ts b/src/changes.ts
--- a/src/changes.ts
+++ b/src/changes.ts
@@ -1,5 +1,8 @@
 const original = true;
-const removed = true;
 const unchanged = true;
+const added1 = true;
+const added2 = true;
+const added3 = true;
` as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].additions).toBe(3);
    expect(response.body.files[0].deletions).toBe(1);
    expect(response.body.stats).toEqual({
      filesChanged: 1,
      additions: 3,
      deletions: 1,
    });
  });
});

// ── Done task diff: first-parent computation ──────────────────────────────────
// Done tasks use the first parent of the merge commit (sha^) to isolate only
// this task's changes, avoiding files from unrelated commits on the main branch.
describe("GET /api/tasks/:id/diff — done tasks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows only this task's files using sha^, not unrelated main branch changes", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "merge789" },
      baseBranch: "main",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Done tasks resolve merge base via sha^
      if (cmd === "git rev-parse merge789^") {
        return "base456\n" as any;
      }
      // git diff --name-status base456..merge789 → only this task's files
      if (cmd === "git diff --name-status base456..merge789") {
        return "A\tfile-b.txt\n" as any;
      }
      // Per-file diff using first parent
      if (cmd === 'git diff base456..merge789 -- "file-b.txt"') {
        return "diff --git a/file-b.txt b/file-b.txt\n--- /dev/null\n+++ b/file-b.txt\n+hello\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    // Should only show file-b.txt (this task's work), NOT file-a.txt (main branch)
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("file-b.txt");
    expect(response.body.files[0].status).toBe("added");
    expect(response.body.stats.filesChanged).toBe(1);
  });

  it("computes correct additions and deletions from sha^ diff", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "sha_with_modifications" },
      baseBranch: "main",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Done tasks resolve merge base via sha^
      if (cmd === "git rev-parse sha_with_modifications^") {
        return "base_xyz\n" as any;
      }
      if (cmd === "git diff --name-status base_xyz..sha_with_modifications") {
        return "M\tsrc/app.ts\n" as any;
      }
      if (cmd === 'git diff base_xyz..sha_with_modifications -- "src/app.ts"') {
        return `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,5 @@
 const original = true;
-const removed = true;
+const added1 = true;
+const added2 = true;
` as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].additions).toBe(2);
    expect(response.body.files[0].deletions).toBe(1);
    expect(response.body.stats).toEqual({
      filesChanged: 1,
      additions: 2,
      deletions: 1,
    });
  });

  it("uses parent commit when rev-parse sha^ succeeds", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "merge_ff" },
      baseBranch: "main",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Done tasks always resolve the first parent via sha^
      if (cmd === "git rev-parse merge_ff^") {
        return "parent_ff\n" as any;
      }
      // Name-status from parent to merge commit
      if (cmd === "git diff --name-status parent_ff..merge_ff") {
        return "M\treadme.md\n" as any;
      }
      if (cmd === 'git diff parent_ff..merge_ff -- "readme.md"') {
        return "diff --git a/readme.md b/readme.md\n+content\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("readme.md");
  });

  it("returns empty result when rev-parse sha^ fails", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "broken_sha" },
    }));

    // All git commands fail
    mockExecSync.mockImplementation(() => {
      throw new Error("git command failed");
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toEqual([]);
    expect(response.body.stats).toEqual({
      filesChanged: 0,
      additions: 0,
      deletions: 0,
    });
  });

  it("handles multiple files in a done task diff", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "multi_merge" },
      baseBranch: "main",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Done tasks resolve merge base via sha^
      if (cmd === "git rev-parse multi_merge^") {
        return "multi_base\n" as any;
      }
      if (cmd === "git diff --name-status multi_base..multi_merge") {
        return "A\tsrc/new.ts\nM\tsrc/changed.ts\nD\tsrc/removed.ts\n" as any;
      }
      if (cmd === 'git diff multi_base..multi_merge -- "src/new.ts"') {
        return "diff --git a/src/new.ts b/src/new.ts\n+new\n" as any;
      }
      if (cmd === 'git diff multi_base..multi_merge -- "src/changed.ts"') {
        return "diff --git a/src/changed.ts b/src/changed.ts\n-old\n+new\n" as any;
      }
      if (cmd === 'git diff multi_base..multi_merge -- "src/removed.ts"') {
        return "diff --git a/src/removed.ts b/src/removed.ts\n-old line\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(3);
    expect(response.body.files[0]).toMatchObject({ path: "src/new.ts", status: "added" });
    expect(response.body.files[1]).toMatchObject({ path: "src/changed.ts", status: "modified" });
    expect(response.body.files[2]).toMatchObject({ path: "src/removed.ts", status: "deleted" });
  });

  it("ignores baseCommitSha even when valid ancestor to avoid cross-task leaks", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "task_a_merge" },
      baseCommitSha: "very_old_base",
      baseBranch: "main",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Scenario: Task B merged between Task A start and Task A merge.
      // Using baseCommitSha would include Task B's file, but sha^ isolates Task A.
      if (cmd === "git rev-parse task_a_merge^") {
        return "task_a_parent\n" as any;
      }
      if (cmd === "git diff --name-status task_a_parent..task_a_merge") {
        return "A\ttask-a.ts\n" as any;
      }
      if (cmd === 'git diff task_a_parent..task_a_merge -- "task-a.ts"') {
        return "diff --git a/task-a.ts b/task-a.ts\n+task A only\n" as any;
      }
      if (cmd.includes("git merge-base --is-ancestor")) {
        throw new Error("Done-task diff must ignore baseCommitSha");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("task-a.ts");
    expect(response.body.files.map((f: any) => f.path)).not.toContain("task-b.ts");
    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse task_a_merge^",
      expect.any(Object),
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("git merge-base --is-ancestor"),
      expect.any(Object),
    );
  });

  it("uses sha^ even when baseCommitSha is stale", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "merged_commit" },
      baseCommitSha: "stale_base",
      baseBranch: "develop",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      if (cmd === "git rev-parse merged_commit^") {
        return "branch_base\n" as any;
      }
      if (cmd === "git diff --name-status branch_base..merged_commit") {
        return "M\tsrc/app.ts\n" as any;
      }
      if (cmd === 'git diff branch_base..merged_commit -- "src/app.ts"') {
        return "diff --git a/src/app.ts b/src/app.ts\n-old\n+new\n" as any;
      }
      if (cmd.includes("git merge-base --is-ancestor")) {
        throw new Error("Done-task diff must not validate baseCommitSha");
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("src/app.ts");
    expect(mockExecSync).toHaveBeenCalledWith(
      "git rev-parse merged_commit^",
      expect.any(Object),
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      expect.stringContaining("git merge-base --is-ancestor"),
      expect.any(Object),
    );
  });

  it("uses sha^ regardless of baseBranch", async () => {
    const store = new MockStore();
    store.addTask(createTask({
      column: "done",
      mergeDetails: { commitSha: "custom_merge" },
      // baseBranch should be ignored for done-task diffs
      baseBranch: "release/v2",
    }));

    mockExecSync.mockImplementation((command) => {
      const cmd = String(command);
      // Done tasks resolve merge base via sha^
      if (cmd === "git rev-parse custom_merge^") {
        return "release_base\n" as any;
      }
      if (cmd === "git diff --name-status release_base..custom_merge") {
        return "A\trelease-file.ts\n" as any;
      }
      if (cmd === 'git diff release_base..custom_merge -- "release-file.ts"') {
        return "diff --git a/release-file.ts b/release-file.ts\n+release stuff\n" as any;
      }
      throw new Error(`Unexpected command: ${cmd}`);
    });

    const app = createServer(store as any);
    const response = await requestDiff(app);

    expect(response.status).toBe(200);
    expect(response.body.files).toHaveLength(1);
    expect(response.body.files[0].path).toBe("release-file.ts");
    // Verify the first parent was resolved via rev-parse
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("git rev-parse custom_merge^"),
      expect.any(Object),
    );
  });
});
