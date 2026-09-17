// @vitest-environment node

/*
FNXC:TaskRevert 2026-09-15-10:00 (FN-416):
API-level coverage for POST /tasks/:id/revert/restore. Real git behavior is proven in
packages/engine/src/__tests__/task-revert-restore.real-git.test.ts — this suite stubs
`performTaskRevertRestore` at the route boundary and asserts:
  - the Complete-lane guard and the "not currently reverted" guard (409, no write, no engine call);
  - the durable additive `restoredAt` marker on clean/alreadyRestored outcomes (never deleting
    `revertedAt`, never moving the task);
  - the AI-restore fallback contract: only in `mode:"auto"`, only on conflict/unsupported, and
    idempotent against an already-open restore task.
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";

const performTaskRevertRestoreMock = vi.fn();

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    performTaskRevertRestore: (...args: unknown[]) => performTaskRevertRestoreMock(...args),
  };
});

// `createAiRestoreTask` is deliberately NOT mocked: the route must be proven to wire the real
// engine helper (including its `restoreOf` idempotency key) against a fake store.

function makeGitRepoOnMain(): string {
  const dir = mkdtempSync(join(tmpdir(), "fn-416-restore-route-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

const REVERTED_AT = "2026-09-01T00:00:00.000Z";

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-100",
    lineageId: "FN-100",
    description: "restore me",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceMetadata: { revertedAt: REVERTED_AT, revertedCommitSha: "revert-sha" },
    ...overrides,
  } as Task;
}

function createMockStore(
  task: Task,
  opts?: { openRestoreTask?: Task | null; autoMerge?: boolean },
): TaskStore {
  let nextId = 900;
  const createTask = vi.fn().mockImplementation(async (input: { description: string; source?: { sourceMetadata?: Record<string, unknown> } }) => ({
    id: `FN-${nextId++}`,
    description: input.description,
    column: "triage",
    dependencies: [],
    steps: [],
    currentStep: 0,
    sourceMetadata: input.source?.sourceMetadata,
  } as unknown as Task));
  const findOpenRevertTaskForSource = vi.fn().mockImplementation(async (_id: string, key?: string) =>
    (key === "restoreOf" ? (opts?.openRestoreTask ?? null) : null));
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({ autoMerge: opts?.autoMerge ?? true }),
    getWorkflowDefinition: vi.fn().mockResolvedValue(undefined),
    getRootDir: vi.fn().mockReturnValue(makeGitRepoOnMain()),
    getTask: vi.fn().mockResolvedValue(task),
    getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([]),
    createTask,
    findOpenRevertTaskForSource,
    recordPatchnodeRevert: vi.fn().mockResolvedValue(null),
    updateTask: vi.fn().mockImplementation(async (_id: string, updates: { sourceMetadataPatch?: Record<string, unknown> }) => {
      if (updates.sourceMetadataPatch) {
        task.sourceMetadata = { ...task.sourceMetadata, ...updates.sourceMetadataPatch };
      }
      return task;
    }),
    logEntry: vi.fn().mockResolvedValue(undefined),
    getProjectScopedPluginMcpServers: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TaskStore;
}

function createApp(store: TaskStore) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store));
  return app;
}

async function POST(app: express.Express, path: string, body?: Record<string, unknown>) {
  if (body === undefined) return performRequest(app, "POST", path);
  return performRequest(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });
}

describe("POST /tasks/:id/revert/restore", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Case (q)
  it("stamps restoredAt and returns the clean git result", async () => {
    const task = makeTask({});
    const store = createMockStore(task);
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", clean: true, restoreCommitSha: "restore-sha" });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, restoreCommitSha: "restore-sha" });
    expect(store.updateTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(task.id, {
      sourceMetadataPatch: expect.objectContaining({ restoredAt: expect.any(String), restoredCommitSha: "restore-sha" }),
    });
    // `revertedAt` is never deleted — the Patchnode cancellation history must stay readable.
    expect(task.sourceMetadata).toMatchObject({ revertedAt: REVERTED_AT, restoredAt: expect.any(String) });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("stamps restoredAt for an alreadyRestored outcome too", async () => {
    const task = makeTask({});
    const store = createMockStore(task);
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", clean: true, alreadyRestored: true });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, alreadyRestored: true });
    expect(store.updateTask as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(task.id, {
      sourceMetadataPatch: expect.objectContaining({ restoredAt: expect.any(String) }),
    });
  });

  // Case (r)
  it("refuses a task that is not reverted with 409 and writes nothing", async () => {
    const task = makeTask({ sourceMetadata: {} } as Partial<Task>);
    const store = createMockStore(task);

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`);

    expect(res.status).toBe(409);
    expect(performTaskRevertRestoreMock).not.toHaveBeenCalled();
    expect(store.updateTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("refuses an already-restored task with 409 and writes nothing", async () => {
    const task = makeTask({ sourceMetadata: { revertedAt: REVERTED_AT, restoredAt: "2026-09-02T00:00:00.000Z" } } as Partial<Task>);
    const store = createMockStore(task);

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`);

    expect(res.status).toBe(409);
    expect(performTaskRevertRestoreMock).not.toHaveBeenCalled();
    expect(store.updateTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("still allows a restore when a STALE restore marker predates the revert", async () => {
    const task = makeTask({ sourceMetadata: { revertedAt: REVERTED_AT, restoredAt: "2026-08-01T00:00:00.000Z" } } as Partial<Task>);
    const store = createMockStore(task);
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", clean: true, restoreCommitSha: "restore-sha" });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`);

    expect(res.status).toBe(200);
    expect(performTaskRevertRestoreMock).toHaveBeenCalledTimes(1);
  });

  // Case (s)
  it("refuses a task outside the Complete lanes with 409", async () => {
    const task = makeTask({ column: "in-progress" });
    const store = createMockStore(task);

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`);

    expect(res.status).toBe(409);
    expect(performTaskRevertRestoreMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid mode with 400", async () => {
    const task = makeTask({});
    const store = createMockStore(task);

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "nope" });

    expect(res.status).toBe(400);
    expect(performTaskRevertRestoreMock).not.toHaveBeenCalled();
  });

  // Case (t)
  it("mode:'auto' falls back to an AI restore task on conflict and does not stamp restoredAt", async () => {
    const task = makeTask({});
    const store = createMockStore(task);
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", clean: false, conflicts: [{ file: "foo.ts", status: "UU" }] });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "auto" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai", createdTaskId: expect.any(String) });
    expect(store.updateTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const createdInput = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { source: { sourceMetadata: Record<string, unknown> } };
    expect(createdInput.source.sourceMetadata).toMatchObject({ restoreOf: task.id });
  });

  it("mode:'auto' falls back to an AI restore task on an unsupported git result", async () => {
    const task = makeTask({});
    const store = createMockStore(task);
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", unsupported: true, reason: "no-revert-commit-resolved" });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "auto" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai", createdTaskId: expect.any(String) });
  });

  it("mode:'auto' returns a needsHuman result as-is and never AI-forks it", async () => {
    const task = makeTask({});
    const store = createMockStore(task, { autoMerge: false });
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", needsHuman: true, reason: "autoMerge is disabled" });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "auto" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", needsHuman: true });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(store.updateTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // Case (u)
  it("mode:'git' returns the raw conflicting result and creates no task", async () => {
    const task = makeTask({});
    const store = createMockStore(task);
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", clean: false, conflicts: [{ file: "foo.ts", status: "UU" }] });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "git" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: false });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // Case (v)
  it("returns the already-open restore task instead of creating a second one", async () => {
    const task = makeTask({});
    const store = createMockStore(task, { openRestoreTask: { id: "FN-777" } as Task });
    performTaskRevertRestoreMock.mockResolvedValue({ mode: "git", clean: false, conflicts: [{ file: "foo.ts", status: "UU" }] });

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "auto" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai", createdTaskId: "FN-777", alreadyOpen: true });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("mode:'ai' goes straight to the AI restore task without touching git", async () => {
    const task = makeTask({});
    const store = createMockStore(task);

    const res = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "ai" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai", createdTaskId: expect.any(String) });
    expect(performTaskRevertRestoreMock).not.toHaveBeenCalled();
  });

  it("refuses a workspace task on the single-repo path and routes auto to the AI restore task", async () => {
    const task = makeTask({
      workspaceWorktrees: {
        "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/FN-100", landedSha: "aaa111" },
      },
    } as Partial<Task>);
    const store = createMockStore(task);

    const gitRes = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "git" });
    expect(gitRes.status).toBe(200);
    expect(gitRes.body).toMatchObject({ mode: "git", unsupported: true });
    expect(performTaskRevertRestoreMock).not.toHaveBeenCalled();

    const autoRes = await POST(createApp(store), `/api/tasks/${task.id}/revert/restore`, { mode: "auto" });
    expect(autoRes.status).toBe(200);
    expect(autoRes.body).toMatchObject({ mode: "ai", createdTaskId: expect.any(String) });
  });
});
