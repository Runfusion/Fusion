/**
 * FNXC:Artifacts FNXC:Documents FNXC:Evals 2026-06-27-12:50:
 * PostgreSQL integration coverage for the three dashboard views that previously
 * 500'd in PG backend mode because they hit the sync `store.db`:
 *   - Artifacts (/api/artifacts → store.listArtifacts → listArtifactsImpl)
 *   - Documents (/api/documents → store.getAllDocuments → getAllDocumentsImpl)
 *   - Evals     (/api/evals → store.getEvalStore() → AsyncEvalStore)
 *
 * Each surface now branches on `store.backendMode` and delegates to an
 * AsyncDataLayer helper / AsyncEvalStore. This drives the real wiring through
 * the shared PG harness and asserts the create → list round-trip plus the
 * joined parent-task fields. Runs in the blocking gate (test:pg-gate).
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import { AsyncEvalStore } from "../../async-eval-store.js";

const pgTest = pgDescribe;

pgTest("Artifacts / Documents / Evals (PostgreSQL backend mode)", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_artifacts_documents_evals",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("listArtifacts returns a registered artifact with the joined task fields", async () => {
    const store = h.store();
    expect(store.backendMode).toBe(true);

    const task = await store.createTask({ description: "Artifact parent task" });

    const artifact = await store.registerArtifact({
      type: "document",
      title: "Design notes",
      description: "An inline artifact body",
      content: "hello world",
      authorId: "agent-1",
      authorType: "agent",
      taskId: task.id,
    });
    expect(artifact.id).toBeTruthy();

    const listed = await store.listArtifacts();
    const mine = listed.find((a) => a.id === artifact.id);
    expect(mine).toBeTruthy();
    expect(mine?.title).toBe("Design notes");
    expect(mine?.taskId).toBe(task.id);
    expect(mine?.taskColumn).toBe(task.column);
    if (task.title) expect(mine?.taskTitle).toBe(task.title);

    // search filter (ILIKE over title/description) finds it…
    expect((await store.listArtifacts({ search: "Design" })).some((a) => a.id === artifact.id)).toBe(true);
    // …and excludes non-matches.
    expect((await store.listArtifacts({ search: "no-such-token-zzz" })).some((a) => a.id === artifact.id)).toBe(false);
    // type filter parity.
    expect((await store.listArtifacts({ type: "document" })).some((a) => a.id === artifact.id)).toBe(true);
  });

  it("getAllDocuments returns an upserted document joined to its live task", async () => {
    const store = h.store();

    const task = await store.createTask({ description: "Document parent task" });

    const doc = await store.upsertTaskDocument(task.id, {
      key: "plan",
      content: "the document body content",
      author: "user",
    });
    expect(doc.id).toBeTruthy();

    const all = await store.getAllDocuments();
    const mine = all.find((d) => d.id === doc.id);
    expect(mine).toBeTruthy();
    expect(mine?.key).toBe("plan");
    expect(mine?.content).toBe("the document body content");
    expect(mine?.taskId).toBe(task.id);
    expect(mine?.taskColumn).toBe(task.column);
    expect(mine?.taskDescription).toBe("Document parent task");
    if (task.title) expect(mine?.taskTitle).toBe(task.title);

    // searchQuery matches the document key/content or the task title.
    expect((await store.getAllDocuments({ searchQuery: "document body" })).some((d) => d.id === doc.id)).toBe(true);
    expect((await store.getAllDocuments({ searchQuery: "no-such-token-zzz" })).some((d) => d.id === doc.id)).toBe(false);
  });

  it("getEvalStore() returns AsyncEvalStore and round-trips an eval run", async () => {
    const store = h.store();
    const evalStore = store.getEvalStore() as AsyncEvalStore;
    expect(evalStore).toBeInstanceOf(AsyncEvalStore);

    const run = await evalStore.createRun({
      projectId: "P-EVAL",
      scope: "all",
      trigger: "manual",
      window: { since: undefined, until: new Date().toISOString() },
      requestedTaskIds: ["T1", "T2"],
    });
    expect(run.id).toMatch(/^ER-/);
    expect(run.status).toBe("pending");
    expect(run.counts.totalTasks).toBe(2);

    // listRuns surfaces it (the dashboard /api/evals/runs path).
    const runs = await evalStore.listRuns();
    expect(runs.map((r) => r.id)).toContain(run.id);

    const fetched = await evalStore.getRun(run.id);
    expect(fetched?.scope).toBe("all");
    expect(fetched?.requestedTaskIds).toEqual(["T1", "T2"]);

    // create → get/list a task result (the dashboard /api/evals + /:id paths).
    const result = await evalStore.createTaskResult(run.id, {
      taskId: "T1",
      taskSnapshot: { taskId: "T1", title: "Snapshot title" },
      status: "scored",
      overallScore: 87,
      maxScore: 100,
    });
    expect(result.id).toMatch(/^ETR-/);

    const results = await evalStore.listTaskResults({ runId: run.id });
    expect(results.map((r) => r.id)).toContain(result.id);
    const got = await evalStore.getTaskResult(result.id);
    expect(got?.overallScore).toBe(87);
    expect(got?.taskSnapshot.title).toBe("Snapshot title");
  });
});
