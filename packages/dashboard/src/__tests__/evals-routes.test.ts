import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { TaskStore as TaskStoreClass } from "@fusion/core";
import { request } from "../test-request.js";
import { createServer } from "../server.js";

const resolverMocks = vi.hoisted(() => ({
  getOrCreateProjectStore: vi.fn(),
}));

vi.mock("../project-store-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../project-store-resolver.js")>("../project-store-resolver.js");
  return {
    ...actual,
    getOrCreateProjectStore: resolverMocks.getOrCreateProjectStore,
  };
});

/*
FNXC:DashboardTests 2026-06-14-09:58:
FN-6444 rescues this route/API suite from the curated skip-list, so cleanup must tolerate asynchronous SQLite/global-settings teardown without leaving a silent orphan.
*/
describe("Evals routes", () => {
  let rootA: string;
  let storeA: TaskStore;
  let app: ReturnType<typeof createServer>;

  /*
  FNXC:DashboardTests 2026-06-25-10:05:
  Only the project-scoping tests touch the project-b store. Lazily init storeB on
  first use instead of in beforeEach so the other tests skip a redundant second
  TaskStore.init()/migrate per test (FN-5048: avoid redundant per-test setup).
  */
  let rootB: string | null = null;
  let storeB: TaskStore | null = null;
  async function getStoreB(): Promise<TaskStore> {
    if (!storeB) {
      rootB = mkdtempSync(join(tmpdir(), "kb-evals-routes-b-"));
      storeB = new TaskStoreClass(rootB, join(rootB, ".fusion-global-settings"), { inMemoryDb: true });
      await storeB.init();
    }
    return storeB;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    rootA = mkdtempSync(join(tmpdir(), "kb-evals-routes-a-"));
    rootB = null;
    storeB = null;

    storeA = new TaskStoreClass(rootA, join(rootA, ".fusion-global-settings"), { inMemoryDb: true });
    await storeA.init();

    resolverMocks.getOrCreateProjectStore.mockImplementation(async (projectId: string) => (
      projectId === "project-b" ? getStoreB() : storeA
    ));

    app = createServer(storeA);
  });

  afterEach(async () => {
    try { await storeA.close(); } catch { /* cleanup */ }
    if (storeB) {
      try { await storeB.close(); } catch { /* cleanup */ }
    }
    await rm(rootA, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    if (rootB) {
      await rm(rootB, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  function seedEvalResult(store: TaskStore, options?: { runId?: string; title?: string; score?: number; rationale?: string }) {
    const evalStore = store.getEvalStore();
    const run = options?.runId
      ? evalStore.getRun(options.runId)!
      : evalStore.createRun({ projectId: "", scope: "scheduled", trigger: "manual" });

    return evalStore.createTaskResult(run.id, {
      taskId: "FN-1",
      taskSnapshot: { taskId: "FN-1", title: options?.title ?? "Fix routing", column: "done" },
      status: "scored",
      overallScore: options?.score ?? 82,
      maxScore: 100,
      categoryScores: [{ category: "quality", score: 80, maxScore: 100 }],
      rationale: options?.rationale ?? "Looks good",
      evidence: [{ source: "task", id: "FN-1", label: "Task" }],
      followUps: [],
    });
  }

  it("GET /api/evals/runs is not shadowed by /:id", async () => {
    const run = storeA.getEvalStore().createRun({ projectId: "", scope: "scheduled", trigger: "manual" });
    const listRes = await request(app, "GET", "/api/evals/runs");
    const getRes = await request(app, "GET", `/api/evals/${run.id}`);

    expect(listRes.status).toBe(200);
    expect((listRes.body as { runs: Array<{ id: string }> }).runs.length).toBeGreaterThan(0);
    expect(getRes.status).toBe(404);
  });

  it("GET /api/evals supports q/runId/score filters and pagination", async () => {
    const evalStore = storeA.getEvalStore();
    const runA = evalStore.createRun({ projectId: "", scope: "scheduled", trigger: "manual" });
    const runB = evalStore.createRun({ projectId: "", scope: "scheduled", trigger: "manual" });
    seedEvalResult(storeA, { runId: runA.id, title: "Fix auth", score: 92, rationale: "Strong" });
    evalStore.createTaskResult(runB.id, {
      taskId: "FN-2",
      taskSnapshot: { taskId: "FN-2", title: "Tune docs", column: "done" },
      status: "scored",
      overallScore: 45,
      maxScore: 100,
      categoryScores: [],
      rationale: "Weak",
      evidence: [],
      followUps: [],
    });

    const filtered = await request(app, "GET", `/api/evals?runId=${runA.id}&q=auth&scoreMin=90&scoreMax=95&limit=1&offset=0`);

    expect(filtered.status).toBe(200);
    expect((filtered.body as { count: number }).count).toBe(1);
    expect((filtered.body as { results: Array<{ taskSnapshot: { title: string } }> }).results[0].taskSnapshot.title).toBe("Fix auth");
  });

  it("GET /api/evals uses default limit of 100 and offset of 0", async () => {
    const evalStore = storeA.getEvalStore();
    const run = evalStore.createRun({ projectId: "", scope: "scheduled", trigger: "manual" });

    for (let index = 0; index < 101; index += 1) {
      evalStore.createTaskResult(run.id, {
        taskId: `FN-${index + 1}`,
        taskSnapshot: { taskId: `FN-${index + 1}`, title: `Task ${index + 1}`, column: "done" },
        status: "scored",
        overallScore: 80,
        maxScore: 100,
        categoryScores: [],
        evidence: [],
        followUps: [],
      });
    }

    const response = await request(app, "GET", "/api/evals");

    expect(response.status).toBe(200);
    expect((response.body as { results: unknown[] }).results).toHaveLength(100);
    expect((response.body as { count: number }).count).toBe(101);
  });

  it("GET /api/evals list endpoint honors project scoping", async () => {
    const storeBInstance = await getStoreB();
    const runA = storeA.getEvalStore().createRun({ projectId: "", scope: "scheduled", trigger: "manual" });
    const runB = storeBInstance.getEvalStore().createRun({ projectId: "", scope: "scheduled", trigger: "manual" });

    storeA.getEvalStore().createTaskResult(runA.id, {
      taskId: "FN-1",
      taskSnapshot: { taskId: "FN-1", title: "Project A task", column: "done" },
      status: "scored",
      overallScore: 80,
      maxScore: 100,
      categoryScores: [],
      evidence: [],
      followUps: [],
    });
    storeBInstance.getEvalStore().createTaskResult(runB.id, {
      taskId: "FN-2",
      taskSnapshot: { taskId: "FN-2", title: "Project B task", column: "done" },
      status: "scored",
      overallScore: 70,
      maxScore: 100,
      categoryScores: [],
      evidence: [],
      followUps: [],
    });

    const scoped = await request(app, "GET", "/api/evals?projectId=project-b");

    expect(scoped.status).toBe(200);
    expect((scoped.body as { count: number }).count).toBe(1);
    expect((scoped.body as { results: Array<{ taskSnapshot: { title: string } }> }).results.map((result) => result.taskSnapshot.title)).toEqual(["Project B task"]);
  });

  it("GET /api/evals/:id returns detail and unknown ids return 404", async () => {
    const result = seedEvalResult(storeA);

    const ok = await request(app, "GET", `/api/evals/${result.id}`);
    expect(ok.status).toBe(200);
    expect((ok.body as { result: { id: string } }).result.id).toBe(result.id);

    const missing = await request(app, "GET", "/api/evals/ER-missing");
    expect(missing.status).toBe(404);
  });

  it("GET /api/evals/runs includes selector metadata and supports project scoping", async () => {
    const storeBInstance = await getStoreB();
    const runA = storeA.getEvalStore().createRun({ projectId: "", scope: "scheduled", trigger: "manual" });
    const runB = storeBInstance.getEvalStore().createRun({ projectId: "", scope: "scheduled", trigger: "manual" });

    storeA.getEvalStore().createTaskResult(runA.id, {
      taskId: "FN-1",
      taskSnapshot: { taskId: "FN-1", title: "A", column: "done" },
      status: "scored",
      overallScore: 80,
      maxScore: 100,
      categoryScores: [],
      evidence: [],
      followUps: [],
    });
    storeBInstance.getEvalStore().createTaskResult(runB.id, {
      taskId: "FN-2",
      taskSnapshot: { taskId: "FN-2", title: "B", column: "done" },
      status: "scored",
      overallScore: 70,
      maxScore: 100,
      categoryScores: [],
      evidence: [],
      followUps: [],
    });

    const defaultRuns = await request(app, "GET", "/api/evals/runs");
    expect(defaultRuns.status).toBe(200);
    expect((defaultRuns.body as { runs: Array<{ id: string; status: string; createdAt: string; evaluatedTaskCount: number }> }).runs[0]).toMatchObject({ id: runA.id, status: expect.any(String), createdAt: expect.any(String) });

    const scopedRuns = await request(app, "GET", "/api/evals/runs?projectId=project-b");
    expect(scopedRuns.status).toBe(200);
    expect((scopedRuns.body as { runs: Array<{ id: string }> }).runs.map((run) => run.id)).toEqual([runB.id]);
  });

  it("rejects invalid score and pagination queries", async () => {
    const badScore = await request(app, "GET", "/api/evals?scoreMin=foo");
    expect(badScore.status).toBe(400);

    const reversed = await request(app, "GET", "/api/evals?scoreMin=90&scoreMax=10");
    expect(reversed.status).toBe(400);

    const badLimit = await request(app, "GET", "/api/evals?limit=0");
    expect(badLimit.status).toBe(400);
  });
});
