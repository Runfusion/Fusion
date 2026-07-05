// @vitest-environment node

/*
FNXC:TaskRevert 2026-07-04-00:00:
API-level coverage for POST /tasks/:id/revert (FN-7523). The real git dry-run/
classify/apply behavior is proven in packages/engine/src/__tests__/task-revert.real-git.test.ts —
this suite stubs `performTaskRevert` at the route boundary and asserts:
  - the done/archived guard (4xx for other columns, before the engine service is even called);
  - the response contract shapes for clean / alreadyReverted / conflicting outcomes;
  - error mapping (TaskRevertError -> 409 for dirty-working-tree, 500 otherwise).
*/
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Task, TaskStore } from "@fusion/core";
import { createApiRoutes } from "../routes.js";
import { request as performRequest } from "../test-request.js";
import { githubRateLimiter } from "../github-poll.js";

// FN-7577: `getCurrentRepo` is mocked at the `@fusion/core` boundary (partial
// mock, everything else passes through to the real module) so workspace
// mode:"pr" tests can resolve distinct owner/repo per sub-repo without a real
// GitHub remote. The returned wrapper defers reading `getCurrentRepoMock` (and
// falls back to the REAL `getCurrentRepo`) until CALL time — never inside the
// synchronous factory body — so existing single-repo FN-7554 tests (which
// rely on real local-remote resolution / the `GITHUB_REPOSITORY` env
// override) are unaffected; workspace tests below override via
// `mockImplementation`.
const getCurrentRepoMock = vi.fn();
vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    getCurrentRepo: (...args: [string?]) =>
      getCurrentRepoMock.getMockImplementation() ? getCurrentRepoMock(...args) : actual.getCurrentRepo(...args),
  };
});

// FNXC:TaskRevert 2026-07-04-00:00: the route now guards against `rootDir`
// (the shared user checkout) sitting on a branch other than the resolved
// base branch (see the branch-mismatch check in register-task-workflow-routes.ts).
// A real repo checked out on "main" (the integration-branch fallback with no
// `integrationBranch`/`baseBranch` setting) satisfies that guard for the
// success-path tests below.
function makeGitRepoOnMain(): string {
  const dir = mkdtempSync(join(tmpdir(), "kb-task-revert-route-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
  // FN-7554: a local bare "origin" remote lets `mode:"pr"` tests exercise a
  // REAL `git push -u origin <revertBranch>` without any network dependency.
  const originDir = mkdtempSync(join(tmpdir(), "kb-task-revert-route-origin-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: originDir });
  execFileSync("git", ["remote", "add", "origin", originDir], { cwd: dir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: dir });
  return dir;
}

const performTaskRevertMock = vi.fn();
const revertWorkspaceTaskMock = vi.fn();
const prepareRevertPrBranchMock = vi.fn();
const prepareWorkspaceRevertPrBranchesMock = vi.fn();

vi.mock("@fusion/engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/engine")>();
  return {
    ...actual,
    performTaskRevert: (...args: unknown[]) => performTaskRevertMock(...args),
    revertWorkspaceTask: (...args: unknown[]) => revertWorkspaceTaskMock(...args),
    prepareRevertPrBranch: (...args: unknown[]) => prepareRevertPrBranchMock(...args),
    prepareWorkspaceRevertPrBranches: (...args: unknown[]) => prepareWorkspaceRevertPrBranchesMock(...args),
  };
});

// FN-7554: stub GitHubClient at the route boundary — `findPrForBranch`/`createPr`
// idempotency + push/create behavior is exercised here; real GitHubClient HTTP/gh-CLI
// behavior is covered by github.test.ts.
const findPrForBranchMock = vi.fn();
const createPrMock = vi.fn();

vi.mock("../github.js", () => ({
  GitHubClient: vi.fn().mockImplementation(function (this: unknown) {
    return {
      findPrForBranch: (...args: unknown[]) => findPrForBranchMock(...args),
      createPr: (...args: unknown[]) => createPrMock(...args),
    };
  }),
}));

// FNXC:TaskRevert 2026-07-04-00:00 (FN-7524): `createAiUndoTask` is NOT mocked —
// these route tests exercise the real engine helper against a fake store
// (`createTask`/`findOpenRevertTaskForSource`), proving the route wires the
// AI-undo fallback correctly rather than merely asserting it was "called".

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "FN-100",
    lineageId: "FN-100",
    description: "revert me",
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

// FNXC:TaskRevert 2026-07-04-00:00 (FN-7547 — workspace dispatch coverage):
// Workspace tasks (`workspaceWorktrees` populated) must route to
// `revertWorkspaceTask` instead of `performTaskRevert` — real per-repo git
// behavior (attribution/classification/all-or-nothing rollback) is proven in
// packages/engine/src/__tests__/task-revert.workspace.real-git.test.ts; this
// suite only asserts the route dispatch and per-repo response shape.
function makeWorkspaceTask(overrides: Partial<Task>): Task {
  return makeTask({
    workspaceWorktrees: {
      "repo-a": { worktreePath: "/tmp/repo-a", branch: "fusion/FN-100", landedSha: "aaa111" },
      "repo-b": { worktreePath: "/tmp/repo-b", branch: "fusion/FN-100", landedSha: "bbb222" },
    },
    ...overrides,
  });
}

// FN-7577: real multi-sub-repo git fixture for workspace mode:"pr" tests —
// each sub-repo is its own real git repo with a real bare "origin" remote, so
// the route's REAL `git push -u origin <revertBranch>` has something to push
// (mirrors `makeGitRepoOnMain`'s single-repo pattern, once per sub-repo).
function makeWorkspaceGitRoot(repoRels: string[]): { rootDir: string; repoDirs: Record<string, string> } {
  const rootDir = mkdtempSync(join(tmpdir(), "kb-task-revert-ws-route-"));
  const repoDirs: Record<string, string> = {};
  for (const rel of repoRels) {
    const dir = join(rootDir, rel);
    mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir });
    const originDir = mkdtempSync(join(tmpdir(), "kb-task-revert-ws-route-origin-"));
    execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: originDir });
    execFileSync("git", ["remote", "add", "origin", originDir], { cwd: dir });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: dir });
    repoDirs[rel] = dir;
  }
  return { rootDir, repoDirs };
}

function createMockStore(
  task: Task,
  opts?: {
    openUndoTask?: Task | null;
    createdUndoTask?: Task;
    autoMerge?: boolean;
    aiUndoTaskWorkflowId?: string;
    knownWorkflowIds?: string[];
    rootDir?: string;
  },
): TaskStore {
  let nextId = 800;
  const createTask = vi.fn().mockImplementation(async (input: { description: string; source?: { sourceParentTaskId?: string; sourceMetadata?: Record<string, unknown> } }) => {
    const created = opts?.createdUndoTask ?? ({
      id: `FN-${nextId++}`,
      lineageId: `FN-${nextId}`,
      description: input.description,
      column: "triage",
      dependencies: [],
      steps: [],
      currentStep: 0,
      sourceParentTaskId: input.source?.sourceParentTaskId,
      sourceMetadata: input.source?.sourceMetadata,
    } as unknown as Task);
    return created;
  });
  const findOpenRevertTaskForSource = vi.fn().mockResolvedValue(opts?.openUndoTask ?? null);
  // FN-7556: `getWorkflowDefinition` backs the route's validation of a
  // configured (non-builtin) `aiUndoTaskWorkflowId`; default to "unknown" so
  // tests must explicitly declare a custom id as known via `knownWorkflowIds`.
  const getWorkflowDefinition = vi.fn().mockImplementation(async (id: string) =>
    (opts?.knownWorkflowIds ?? []).includes(id) ? { id, name: id, ir: {} } : undefined,
  );
  return {
    getSettings: vi.fn().mockResolvedValue({}),
    getSettingsFast: vi.fn().mockResolvedValue({
      autoMerge: opts?.autoMerge ?? true,
      aiUndoTaskWorkflowId: opts?.aiUndoTaskWorkflowId,
    }),
    getWorkflowDefinition,
    getRootDir: vi.fn().mockReturnValue(opts?.rootDir ?? makeGitRepoOnMain()),
    getTask: vi.fn().mockResolvedValue(task),
    getTaskCommitAssociationsByLineageId: vi.fn().mockResolvedValue([]),
    createTask,
    findOpenRevertTaskForSource,
    updatePrInfo: vi.fn().mockResolvedValue(task),
    addPrInfo: vi.fn().mockResolvedValue(task),
    logEntry: vi.fn().mockResolvedValue(undefined),
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

async function REQUEST(app: express.Express, method: string, path: string, body?: unknown) {
  if (body === undefined) {
    return performRequest(app, method, path);
  }
  return performRequest(app, method, path, JSON.stringify(body), { "content-type": "application/json" });
}

async function POST_JSON(app: express.Express, path: string, body: Record<string, unknown>) {
  return performRequest(app, "POST", path, JSON.stringify(body), { "content-type": "application/json" });
}

describe("POST /tasks/:id/revert", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns a clean revert result for a done task", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, revertCommitSha: "abc123" });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, revertCommitSha: "abc123" });
    expect(performTaskRevertMock).toHaveBeenCalledTimes(1);
  });

  it("returns an alreadyReverted result without invoking a second commit", async () => {
    const task = makeTask({ column: "archived" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, alreadyReverted: true });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, alreadyReverted: true });
  });

  it("mode:'git' returns a conflicting result without creating an AI-undo follow-up task (FN-7524: default mode is now 'auto', which DOES fall back to AI on conflict — explicit 'git' is required to preserve the FN-7523 git-only contract)", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({
      mode: "git",
      clean: false,
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "git" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "git",
      clean: false,
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });
  });

  it("rejects a non-done/archived task with a 4xx guard before invoking the engine service", async () => {
    const task = makeTask({ column: "in-progress" });
    const store = createMockStore(task);

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(String((res.body as { error?: string }).error ?? "")).toMatch(/done\/archived/i);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the task does not exist", async () => {
    const store = createMockStore(makeTask({}));
    (store.getTask as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const res = await REQUEST(createApp(store), "POST", "/api/tasks/FN-999/revert");
    expect(res.status).toBe(404);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("maps a dirty-working-tree TaskRevertError to 409", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    const { TaskRevertError } = await import("@fusion/engine");
    performTaskRevertMock.mockRejectedValue(new TaskRevertError("working tree is dirty", "dirty-working-tree"));

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(409);
  });

  it("maps an unexpected TaskRevertError to 500", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    const { TaskRevertError } = await import("@fusion/engine");
    performTaskRevertMock.mockRejectedValue(new TaskRevertError("git log failed", "git-log-failed"));

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(500);
  });

  it("rejects with a branch-mismatch 409 when rootDir is checked out on a different branch than the resolved base branch, without invoking the engine service", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    const rootDir = (store.getRootDir as () => string)();
    execFileSync("git", ["checkout", "-b", "some-other-branch"], { cwd: rootDir });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(409);
    expect((res.body as { details?: { code?: string } }).details?.code ?? (res.body as { error?: string }).error).toBeTruthy();
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("dispatches a done workspace task to revertWorkspaceTask and returns the per-repo breakdown (clean)", async () => {
    const task = makeWorkspaceTask({ column: "done" });
    const store = createMockStore(task);
    revertWorkspaceTaskMock.mockResolvedValue({
      mode: "git",
      clean: true,
      workspace: {
        repos: [
          { repo: "repo-a", classification: "clean", revertCommitSha: "rev-a" },
          { repo: "repo-b", classification: "clean", revertCommitSha: "rev-b" },
        ],
      },
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "git",
      clean: true,
      workspace: { repos: [{ repo: "repo-a" }, { repo: "repo-b" }] },
    });
    expect(revertWorkspaceTaskMock).toHaveBeenCalledTimes(1);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("mode:'git' dispatches a workspace task conflict to the per-repo conflict shape without creating an AI-undo task or calling performTaskRevert", async () => {
    const task = makeWorkspaceTask({ column: "archived" });
    const store = createMockStore(task);
    revertWorkspaceTaskMock.mockResolvedValue({
      mode: "git",
      clean: false,
      workspace: {
        repos: [
          { repo: "repo-a", classification: "clean", revertCommitSha: "rev-a" },
          { repo: "repo-b", classification: "conflicting", conflicts: [{ file: "b.ts", status: "UU" }] },
        ],
      },
      conflicts: [{ repo: "repo-b", file: "b.ts", status: "UU" }],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "git" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "git",
      clean: false,
      conflicts: [{ repo: "repo-b", file: "b.ts" }],
    });
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  // FN-7547 + FN-7524: default mode is "auto", which falls back to the AI-undo
  // task on a conflicting WORKSPACE result too, same as the single-repo contract.
  it("auto (default) mode falls back to the AI-undo task on a conflicting workspace result", async () => {
    const task = makeWorkspaceTask({ id: "FN-950", column: "archived" });
    const store = createMockStore(task);
    revertWorkspaceTaskMock.mockResolvedValue({
      mode: "git",
      clean: false,
      workspace: {
        repos: [
          { repo: "repo-a", classification: "clean", revertCommitSha: "rev-a" },
          { repo: "repo-b", classification: "conflicting", conflicts: [{ file: "b.ts", status: "UU" }] },
        ],
      },
      conflicts: [{ repo: "repo-b", file: "b.ts", status: "UU" }],
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai" });
    expect((res.body as { createdTaskId?: string }).createdTaskId).toBeTruthy();
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("rejects a non-done/archived workspace task with a 4xx guard before invoking the workspace service", async () => {
    const task = makeWorkspaceTask({ column: "in-progress" });
    const store = createMockStore(task);

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(revertWorkspaceTaskMock).not.toHaveBeenCalled();
  });
});

// FN-7524 Symptom Verification: `{ mode }` request handling + the AI-undo fallback.
describe("POST /tasks/:id/revert — FN-7524 mode + AI-undo fallback", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid mode value with 400 before invoking the engine service", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "bogus" });
    expect(res.status).toBe(400);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
    expect((store.createTask as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("(a) auto + conflict: creates an AI-undo task and returns { mode: 'ai', createdTaskId }, stamped with the revertOf marker", async () => {
    const task = makeTask({ id: "FN-901", column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({
      mode: "git",
      clean: false,
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai" });
    expect((res.body as { createdTaskId?: string }).createdTaskId).toBeTruthy();
    expect(store.createTask as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const createInput = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      source?: { sourceParentTaskId?: string; sourceMetadata?: Record<string, unknown> };
    };
    expect(createInput.source?.sourceMetadata?.revertOf).toBe("FN-901");
  });

  it("(b) mode:'ai' forced: creates the AI-undo task without ever invoking the git path", async () => {
    const task = makeTask({ id: "FN-902", column: "done" });
    const store = createMockStore(task);

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "ai" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai" });
    expect(performTaskRevertMock).not.toHaveBeenCalled();
    expect(store.createTask as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("(c) duplicate guard: a second call while an AI-undo task is already open returns the SAME createdTaskId and creates no duplicate", async () => {
    const task = makeTask({ id: "FN-903", column: "done" });
    const existingUndo = makeTask({ id: "FN-950", column: "triage", sourceParentTaskId: "FN-903", sourceMetadata: { revertOf: "FN-903" } });
    const store = createMockStore(task, { openUndoTask: existingUndo });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "ai" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai", createdTaskId: "FN-950", alreadyOpen: true });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("(FN-7556) forwards the configured aiUndoTaskWorkflowId (default review-heavy) into the created AI-undo task", async () => {
    const task = makeTask({ id: "FN-970", column: "done" });
    const store = createMockStore(task, { aiUndoTaskWorkflowId: "builtin:review-heavy" });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "ai" });
    expect(res.status).toBe(200);
    expect(store.createTask as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const createInput = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0] as { workflowId?: string };
    expect(createInput.workflowId).toBe("builtin:review-heavy");
  });

  it("(FN-7556) a blank/unset aiUndoTaskWorkflowId omits workflowId so the task inherits the project default", async () => {
    const task = makeTask({ id: "FN-971", column: "done" });
    const store = createMockStore(task, { aiUndoTaskWorkflowId: "" });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "ai" });
    expect(res.status).toBe(200);
    const createInput = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0] as { workflowId?: string };
    expect("workflowId" in createInput).toBe(false);
  });

  it("(FN-7556) an unknown configured workflow id falls back to inherit (task still created, no 500)", async () => {
    const task = makeTask({ id: "FN-972", column: "done" });
    const store = createMockStore(task, { aiUndoTaskWorkflowId: "WF-does-not-exist", knownWorkflowIds: [] });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "ai" });
    expect(res.status).toBe(200);
    expect(store.createTask as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const createInput = (store.createTask as ReturnType<typeof vi.fn>).mock.calls[0][0] as { workflowId?: string };
    expect("workflowId" in createInput).toBe(false);
  });

  it("(d) auto + clean: returns the git result and does NOT create an AI-undo task", async () => {
    const task = makeTask({ id: "FN-904", column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, revertCommitSha: "abc123" });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, revertCommitSha: "abc123" });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("mode:'git' on a conflicting result returns the raw conflict and NEVER creates an AI-undo task", async () => {
    const task = makeTask({ id: "FN-905", column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({
      mode: "git",
      clean: false,
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "git" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: false });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("auto + unsupported (workspace) git result falls back to the AI-undo task", async () => {
    const task = makeTask({ id: "FN-906", column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", unsupported: true, reason: "workspace-task-revert-unsupported" });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai" });
    expect(store.createTask as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("auto + needsHuman (autoMerge-off) returns the git result and does NOT create an AI-undo task", async () => {
    const task = makeTask({ id: "FN-907", column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", needsHuman: true, reason: "autoMerge is disabled" });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", needsHuman: true });
    expect(store.createTask as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // FN-7548: the optional `granularity` request-body field ("squash" | "per-sha")
  // is validated at the route and forwarded verbatim to `performTaskRevert`.
  it("forwards granularity: \"per-sha\" to the engine service and returns the revertCommitShas result shape", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({
      mode: "git",
      clean: true,
      revertCommitSha: "def456",
      revertCommitShas: ["def456", "abc123"],
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`, { granularity: "per-sha" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, revertCommitShas: ["def456", "abc123"] });
    expect(performTaskRevertMock).toHaveBeenCalledTimes(1);
    expect(performTaskRevertMock.mock.calls[0]?.[0]).toMatchObject({ granularity: "per-sha" });
  });

  it("rejects an unknown granularity value with a 400, before invoking the engine service", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`, { granularity: "bogus" });
    expect(res.status).toBe(400);
    expect(String((res.body as { error?: string }).error ?? "")).toMatch(/granularity/i);
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("defaults to squash granularity when the body omits the field, preserving existing behavior", async () => {
    const task = makeTask({ column: "done" });
    const store = createMockStore(task);
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, revertCommitSha: "abc123", revertCommitShas: ["abc123"] });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(performTaskRevertMock.mock.calls[0]?.[0]).toMatchObject({ granularity: "squash" });
  });
});

// FN-7554: mode:"pr" — PR-based revert for autoMerge:false projects.
describe("POST /tasks/:id/revert — FN-7554 mode:'pr' (autoMerge:false)", () => {
  const originalGithubRepository = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    if (originalGithubRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalGithubRepository;
    }
  });

  it("clean + autoMerge:false → mode:'pr', pushes and creates the PR with manual:true persistence", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-100", column: "done" });
    const store = createMockStore(task, { autoMerge: false });
    const rootDir = (store.getRootDir as () => string)();
    // `prepareRevertPrBranch` is mocked (real branch-prep behavior is proven by
    // task-revert-pr.real-git.test.ts), so create the branch it would have
    // created locally, so the route's REAL `git push -u origin <branch>` has
    // something to push.
    execFileSync("git", ["branch", "fusion/revert-fn-100"], { cwd: rootDir });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockResolvedValue(null);
    prepareRevertPrBranchMock.mockResolvedValue({
      eligible: true,
      revertBranch: "fusion/revert-fn-100",
      revertCommitShas: ["abc"],
    });
    createPrMock.mockResolvedValue({ number: 7, url: "https://github.com/o/r/pull/7" });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "pr",
      clean: true,
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      revertBranch: "fusion/revert-fn-100",
    });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    expect(createPrMock.mock.calls[0]?.[0]).toMatchObject({ head: "fusion/revert-fn-100" });
    expect(typeof createPrMock.mock.calls[0]?.[0]?.body).toBe("string");
    expect((createPrMock.mock.calls[0]?.[0]?.body as string).length).toBeGreaterThan(0);
    expect(store.updatePrInfo as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({ manual: true, number: 7 }),
    );
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("existing PR idempotency: links the existing PR without re-preparing/re-pushing", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-100", column: "done" });
    const store = createMockStore(task, { autoMerge: false });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockResolvedValue({ number: 9, url: "https://github.com/o/r/pull/9" });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "pr",
      clean: true,
      prUrl: "https://github.com/o/r/pull/9",
      prNumber: 9,
      existingPr: true,
    });
    expect(prepareRevertPrBranchMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("GitHub unconfigured degrade: no GITHUB_REPOSITORY and no git remote → needsHuman", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeTask({ id: "FN-100", column: "done" });
    const store = createMockStore(task, { autoMerge: false });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", needsHuman: true });
    expect(String((res.body as { reason?: string }).reason ?? "")).toMatch(/no GitHub repository/i);
    expect(prepareRevertPrBranchMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("rate-limited degrade: needsHuman without touching prepareRevertPrBranch/createPr", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-100", column: "done" });
    const store = createMockStore(task, { autoMerge: false });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(false);

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", needsHuman: true });
    expect(String((res.body as { reason?: string }).reason ?? "")).toMatch(/rate limit/i);
    expect(prepareRevertPrBranchMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("conflicting under autoMerge:false, mode:'git' → { mode: 'git', clean: false, conflicts } without a PR", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-100", column: "done" });
    const store = createMockStore(task, { autoMerge: false });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockResolvedValue(null);
    prepareRevertPrBranchMock.mockResolvedValue({
      eligible: false,
      classification: "conflicting",
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "git" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: false, conflicts: [{ file: "foo.ts", status: "UU" }] });
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("conflicting under autoMerge:false, mode:'auto' → falls back to the AI-undo task", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-960", column: "done" });
    const store = createMockStore(task, { autoMerge: false });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockResolvedValue(null);
    prepareRevertPrBranchMock.mockResolvedValue({
      eligible: false,
      classification: "conflicting",
      conflicts: [{ file: "foo.ts", status: "UU" }],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai" });
    expect((res.body as { createdTaskId?: string }).createdTaskId).toBeTruthy();
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("regression — autoMerge:true unchanged: still calls performTaskRevert and returns the existing shape", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-970", column: "done" });
    const store = createMockStore(task, { autoMerge: true });
    performTaskRevertMock.mockResolvedValue({ mode: "git", clean: true, revertCommitSha: "abc123", revertCommitShas: ["abc123"] });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, revertCommitSha: "abc123" });
    expect(prepareRevertPrBranchMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
    expect(performTaskRevertMock).toHaveBeenCalledTimes(1);
  });

  it("regression — non-done/archived guard unchanged: still 4xx before any engine/GitHub call", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-971", column: "in-progress" });
    const store = createMockStore(task, { autoMerge: false });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(prepareRevertPrBranchMock).not.toHaveBeenCalled();
    expect(performTaskRevertMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
  });
});

// FN-7577: mode:"pr" — PR-based revert extended to WORKSPACE (multi-repo)
// tasks under autoMerge:false. Real per-sub-repo branch-prep behavior is
// proven by packages/engine/src/__tests__/task-revert-workspace-pr.real-git.test.ts;
// this suite stubs `prepareWorkspaceRevertPrBranches` at the engine boundary
// and `getCurrentRepo` at the core boundary, and asserts the route's
// per-sub-repo PR orchestration, atomic pre-check degrade ordering, and
// idempotency.
describe("POST /tasks/:id/revert — FN-7577 workspace mode:'pr' (autoMerge:false)", () => {
  const originalGithubRepository = process.env.GITHUB_REPOSITORY;

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    if (originalGithubRepository === undefined) {
      delete process.env.GITHUB_REPOSITORY;
    } else {
      process.env.GITHUB_REPOSITORY = originalGithubRepository;
    }
  });

  function mockRepoResolution(resolvable: Record<string, { owner: string; repo: string } | null>): void {
    getCurrentRepoMock.mockImplementation((cwd?: string) => {
      for (const [rel, value] of Object.entries(resolvable)) {
        if (typeof cwd === "string" && cwd.endsWith(rel)) return value;
      }
      return null;
    });
  }

  it("all clean + autoMerge:false → mode:'pr' (multi-PR), one PR per sub-repo, manual:true persistence", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-100", column: "done" });
    const { rootDir, repoDirs } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    // `prepareWorkspaceRevertPrBranches` is mocked (real branch-prep behavior is
    // proven by the engine real-git suite) — create the branches it would have
    // created locally, so the route's REAL `git push -u origin <branch>` per
    // sub-repo has something to push.
    execFileSync("git", ["branch", "fusion/revert-fn-100"], { cwd: repoDirs["repo-a"] });
    execFileSync("git", ["branch", "fusion/revert-fn-100"], { cwd: repoDirs["repo-b"] });
    mockRepoResolution({ "repo-a": { owner: "o", repo: "repo-a" }, "repo-b": { owner: "o", repo: "repo-b" } });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockResolvedValue(null);
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({
      eligible: true,
      repos: [
        { repo: "repo-a", revertBranch: "fusion/revert-fn-100", integrationBranch: "main", revertCommitShas: ["a"] },
        { repo: "repo-b", revertBranch: "fusion/revert-fn-100", integrationBranch: "main", revertCommitShas: ["b"] },
      ],
    });
    let callCount = 0;
    createPrMock.mockImplementation(async () => {
      callCount += 1;
      return { number: 100 + callCount, url: `https://github.com/o/repo/pull/${100 + callCount}` };
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "pr",
      clean: true,
      workspace: {
        repos: [
          { repo: "repo-a", revertBranch: "fusion/revert-fn-100" },
          { repo: "repo-b", revertBranch: "fusion/revert-fn-100" },
        ],
      },
    });
    expect(createPrMock).toHaveBeenCalledTimes(2);
    expect(createPrMock.mock.calls[0]?.[0]).toMatchObject({ owner: "o", repo: "repo-a", head: "fusion/revert-fn-100", base: "main" });
    expect(createPrMock.mock.calls[1]?.[0]).toMatchObject({ owner: "o", repo: "repo-b", head: "fusion/revert-fn-100", base: "main" });
    for (const call of createPrMock.mock.calls) {
      expect(typeof call[0]?.body).toBe("string");
      expect((call[0]?.body as string).length).toBeGreaterThan(0);
    }
    expect(store.updatePrInfo as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(task.id, expect.objectContaining({ manual: true }));
    expect(revertWorkspaceTaskMock).not.toHaveBeenCalled();
    expect(performTaskRevertMock).not.toHaveBeenCalled();
  });

  it("existing PR idempotency: links repo-a's existing PR and only creates a PR for repo-b", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-101", column: "done" });
    const { rootDir, repoDirs } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    execFileSync("git", ["branch", "fusion/revert-fn-101"], { cwd: repoDirs["repo-b"] });
    mockRepoResolution({ "repo-a": { owner: "o", repo: "repo-a" }, "repo-b": { owner: "o", repo: "repo-b" } });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockImplementation(async ({ repo }: { repo: string }) =>
      repo === "repo-a" ? { number: 55, url: "https://github.com/o/repo-a/pull/55" } : null,
    );
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({
      eligible: true,
      repos: [
        { repo: "repo-a", revertBranch: "fusion/revert-fn-101", integrationBranch: "main", revertCommitShas: ["a"] },
        { repo: "repo-b", revertBranch: "fusion/revert-fn-101", integrationBranch: "main", revertCommitShas: ["b"] },
      ],
    });
    createPrMock.mockResolvedValue({ number: 56, url: "https://github.com/o/repo-b/pull/56" });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "pr",
      clean: true,
      workspace: {
        repos: [
          { repo: "repo-a", prNumber: 55, existingPr: true },
          { repo: "repo-b", prNumber: 56 },
        ],
      },
    });
    expect(createPrMock).toHaveBeenCalledTimes(1);
    expect(createPrMock.mock.calls[0]?.[0]).toMatchObject({ repo: "repo-b" });
  });

  it("GitHub unconfigured degrade (whole-task): needsHuman, no createPr for ANY sub-repo", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-102", column: "done" });
    const { rootDir, repoDirs } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    execFileSync("git", ["branch", "fusion/revert-fn-102"], { cwd: repoDirs["repo-a"] });
    execFileSync("git", ["branch", "fusion/revert-fn-102"], { cwd: repoDirs["repo-b"] });
    // repo-b has NO configured GitHub repository.
    mockRepoResolution({ "repo-a": { owner: "o", repo: "repo-a" }, "repo-b": null });
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({
      eligible: true,
      repos: [
        { repo: "repo-a", revertBranch: "fusion/revert-fn-102", integrationBranch: "main", revertCommitShas: ["a"] },
        { repo: "repo-b", revertBranch: "fusion/revert-fn-102", integrationBranch: "main", revertCommitShas: ["b"] },
      ],
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", needsHuman: true });
    expect(String((res.body as { reason?: string }).reason ?? "")).toMatch(/no GitHub repository/i);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(findPrForBranchMock).not.toHaveBeenCalled();
  });

  it("rate-limited degrade (whole-task): needsHuman without touching createPr for any sub-repo", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-103", column: "done" });
    const { rootDir, repoDirs } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    execFileSync("git", ["branch", "fusion/revert-fn-103"], { cwd: repoDirs["repo-a"] });
    execFileSync("git", ["branch", "fusion/revert-fn-103"], { cwd: repoDirs["repo-b"] });
    mockRepoResolution({ "repo-a": { owner: "o", repo: "repo-a" }, "repo-b": { owner: "o", repo: "repo-b" } });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockImplementation((repoKey: string) => repoKey !== "o/repo-b");
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({
      eligible: true,
      repos: [
        { repo: "repo-a", revertBranch: "fusion/revert-fn-103", integrationBranch: "main", revertCommitShas: ["a"] },
        { repo: "repo-b", revertBranch: "fusion/revert-fn-103", integrationBranch: "main", revertCommitShas: ["b"] },
      ],
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", needsHuman: true });
    expect(String((res.body as { reason?: string }).reason ?? "")).toMatch(/rate limit/i);
    expect(createPrMock).not.toHaveBeenCalled();
    expect(findPrForBranchMock).not.toHaveBeenCalled();
  });

  it("conflicting under autoMerge:false, mode:'git' → { mode: 'git', clean: false, workspace, conflicts }, no PR", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-104", column: "done" });
    const { rootDir } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({
      eligible: false,
      classification: "conflicting",
      conflicts: [{ repo: "repo-b", file: "b.ts", status: "UU" }],
      repos: [
        { repo: "repo-a", classification: "clean" },
        { repo: "repo-b", classification: "conflicting", conflicts: [{ file: "b.ts", status: "UU" }] },
      ],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "git" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: "git",
      clean: false,
      conflicts: [{ repo: "repo-b", file: "b.ts" }],
    });
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("conflicting under autoMerge:false, mode:'auto' → falls back to the AI-undo task", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-105", column: "done" });
    const { rootDir } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({
      eligible: false,
      classification: "conflicting",
      conflicts: [{ repo: "repo-b", file: "b.ts", status: "UU" }],
      repos: [
        { repo: "repo-a", classification: "clean" },
        { repo: "repo-b", classification: "conflicting", conflicts: [{ file: "b.ts", status: "UU" }] },
      ],
    });

    const res = await POST_JSON(createApp(store), `/api/tasks/${task.id}/revert`, { mode: "auto" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "ai" });
    expect((res.body as { createdTaskId?: string }).createdTaskId).toBeTruthy();
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("empty prep (all already-reverted) → { mode: 'git', clean: true, workspace: { repos: [] } }, no createPr", async () => {
    delete process.env.GITHUB_REPOSITORY;
    const task = makeWorkspaceTask({ id: "FN-106", column: "done" });
    const { rootDir } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: false, rootDir });
    prepareWorkspaceRevertPrBranchesMock.mockResolvedValue({ eligible: true, repos: [] });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true, workspace: { repos: [] } });
    expect(createPrMock).not.toHaveBeenCalled();
    expect(findPrForBranchMock).not.toHaveBeenCalled();
  });

  it("regression — workspace autoMerge:true unchanged: still calls revertWorkspaceTask, prepareWorkspaceRevertPrBranches/createPr not called", async () => {
    const task = makeWorkspaceTask({ id: "FN-107", column: "done" });
    const { rootDir } = makeWorkspaceGitRoot(["repo-a", "repo-b"]);
    const store = createMockStore(task, { autoMerge: true, rootDir });
    revertWorkspaceTaskMock.mockResolvedValue({
      mode: "git",
      clean: true,
      workspace: {
        repos: [
          { repo: "repo-a", classification: "clean", revertCommitSha: "rev-a" },
          { repo: "repo-b", classification: "clean", revertCommitSha: "rev-b" },
        ],
      },
    });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "git", clean: true });
    expect(revertWorkspaceTaskMock).toHaveBeenCalledTimes(1);
    expect(prepareWorkspaceRevertPrBranchesMock).not.toHaveBeenCalled();
    expect(createPrMock).not.toHaveBeenCalled();
  });

  it("regression — single-repo autoMerge:false unchanged: still takes prepareRevertPrBranch, prepareWorkspaceRevertPrBranches not called", async () => {
    process.env.GITHUB_REPOSITORY = "o/r";
    const task = makeTask({ id: "FN-108", column: "done" });
    const store = createMockStore(task, { autoMerge: false });
    vi.spyOn(githubRateLimiter, "canMakeRequest").mockReturnValue(true);
    findPrForBranchMock.mockResolvedValue({ number: 21, url: "https://github.com/o/r/pull/21" });

    const res = await REQUEST(createApp(store), "POST", `/api/tasks/${task.id}/revert`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "pr", clean: true, prNumber: 21, existingPr: true });
    expect(prepareWorkspaceRevertPrBranchesMock).not.toHaveBeenCalled();
  });
});
