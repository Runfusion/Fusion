import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { reconcileArchivedTaskHistory } from "../reconcile-archived-task-history.mjs";

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function task(id, overrides = {}) {
  return {
    id,
    description: id,
    column: "done",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeStore({ done = [], liveSentinels = [], coldEntries = [], malformedColdEntryIds = [], artifacts = {}, projectId = "project-exact" } = {}) {
  const rows = new Map([...done, ...liveSentinels].map((value) => [value.id, clone(value)]));
  let cold = coldEntries.map((entry) => clone(entry));
  let reconcileCalls = 0;
  let backfillApplyCalls = 0;
  let supplementApplyCalls = 0;
  return {
    getAsyncLayer: () => ({ projectId }),
    listCompletedTasks: async ({ limit, offset }) => {
      const values = [...rows.values()].filter((value) => value.column === "done" && !value.deletedAt).sort((a, b) => b.id.localeCompare(a.id));
      return { tasks: values.slice(offset, offset + limit), total: values.length, hasMore: offset + limit < values.length };
    },
    inspectArchivedTaskHistory: async () => ({
      liveSentinels: [...rows.values()].filter((value) => value.column === "archived" && !value.deletedAt).map((value) => clone(value)),
      coldEntries: cold.map((value) => clone(value)),
      malformedColdEntryIds: [...malformedColdEntryIds],
    }),
    getTask: async (id, options) => {
      const value = rows.get(id);
      if (!value || (value.deletedAt && !options?.includeDeleted)) throw new Error("not found");
      return clone(value);
    },
    readTaskHistoryArtifact: async (id) => clone(artifacts[id]),
    supplementTaskHistoryFromEvidence: async (id, evidence, { dryRun }) => {
      const value = rows.get(id);
      if (!value || value.deletedAt) return { outcome: "missing", fields: [] };
      if (value.userPaused) return { outcome: "user-paused", fields: [] };
      const fields = Object.keys(evidence).filter((field) => value[field] === undefined || value[field] === null);
      if (fields.length === 0) return { outcome: "no-op", fields: [] };
      if (!dryRun) {
        supplementApplyCalls += 1;
        rows.set(id, { ...value, ...Object.fromEntries(fields.map((field) => [field, clone(evidence[field])])) });
      }
      return { outcome: "supplemented", fields };
    },
    backfillCommitAssociationDiffStats: async ({ dryRun }) => {
      if (!dryRun) backfillApplyCalls += 1;
      return { dryRun, updated: 0, unavailable: 1 };
    },
    reconcileArchivedTasksIntoDone: async () => {
      reconcileCalls += 1;
      const outcomes = [];
      for (const value of [...rows.values()]) {
        if (value.column !== "archived" || value.deletedAt) continue;
        if (value.userPaused) {
          outcomes.push({ taskId: value.id, source: "live-column", outcome: "retained", reason: "user-paused" });
          continue;
        }
        rows.set(value.id, { ...value, column: "done" });
        outcomes.push({ taskId: value.id, source: "live-column", outcome: "moved" });
      }
      for (const entry of cold) {
        const existing = rows.get(entry.id);
        if (existing?.userPaused) {
          outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: "retained", reason: "user-paused" });
          continue;
        }
        if (!existing) rows.set(entry.id, { ...task(entry.id), ...entry, column: "done" });
        outcomes.push({ taskId: entry.id, source: "cold-storage", outcome: existing ? "live-won" : "restored" });
      }
      cold = cold.filter((entry) => rows.get(entry.id)?.userPaused);
      return {
        movedCount: outcomes.filter((item) => item.outcome === "moved").length,
        restoredCount: outcomes.filter((item) => item.outcome === "restored").length,
        outcomes,
        hasMore: false,
      };
    },
    diagnostics: () => ({
      rows,
      get reconcileCalls() { return reconcileCalls; },
      get backfillApplyCalls() { return backfillApplyCalls; },
      get supplementApplyCalls() { return supplementApplyCalls; },
    }),
  };
}

test("dry-run inventories more than 200 candidates without writing", async () => {
  const coldEntries = Array.from({ length: 205 }, (_, index) => task(`FN-${50000 + index}`, {
    column: "archived",
    archivedAt: "2026-01-02T00:00:00.000Z",
  }));
  const store = fakeStore({ coldEntries });

  const report = await reconcileArchivedTaskHistory({ store, apply: false });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.candidates.length, 205);
  assert.equal(report.sources.coldOnly, 205);
  assert.equal(report.totalDoneBefore, 0);
  assert.equal(report.totalDoneAfter, 0);
  assert.equal(store.diagnostics().reconcileCalls, 0);
  assert.equal(store.diagnostics().backfillApplyCalls, 0);
});

test("dry-run reports malformed cold proof as retained without blocking valid candidates", async () => {
  const valid = task("FN-59999", { column: "archived", archivedAt: "2026-01-02T00:00:00.000Z" });
  const store = fakeStore({ coldEntries: [valid], malformedColdEntryIds: ["FN-59998"] });

  const report = await reconcileArchivedTaskHistory({ store, apply: false });

  assert.equal(report.sources.coldSnapshots, 2);
  assert.equal(report.sources.malformedColdSnapshots, 1);
  assert.deepEqual(report.retained, [{ taskId: "FN-59998", reason: "malformed-snapshot" }]);
  assert.deepEqual(report.wouldRestore, [valid.id]);
});

test("apply is idempotent, preserves live proof, and reports unavailable fields", async () => {
  const authoritative = task("FN-60000", {
    column: "archived",
    cumulativeActiveMs: 900,
    tokenUsage: { inputTokens: 1, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1, firstUsedAt: "a", lastUsedAt: "b" },
  });
  const cold = task(authoritative.id, {
    column: "archived",
    archivedAt: "2026-01-02T00:00:00.000Z",
    cumulativeActiveMs: 100,
    mergeDetails: { commitSha: "sha" },
  });
  const store = fakeStore({ liveSentinels: [authoritative], coldEntries: [cold] });

  const first = await reconcileArchivedTaskHistory({ store, apply: true });
  const second = await reconcileArchivedTaskHistory({ store, apply: true });

  assert.equal(first.totalDoneAfter, 1);
  assert.deepEqual(first.liveWon, [authoritative.id]);
  assert.equal(store.diagnostics().rows.get(authoritative.id).cumulativeActiveMs, 900);
  assert.deepEqual(store.diagnostics().rows.get(authoritative.id).mergeDetails, { commitSha: "sha" });
  assert.equal(second.totalDoneBefore, 1);
  assert.equal(second.restored.length, 0);
  assert(first.fieldsWithoutProof.some((item) => item.taskId === authoritative.id && item.field === "modifiedFiles"));
  assert.equal(store.diagnostics().backfillApplyCalls, 2);
});

test("repairs from retained artifacts and exact commit files without inventing unavailable Git proof", async () => {
  const artifactBacked = task("FN-61000", { lineageId: "lineage-artifact" });
  const gitBacked = task("FN-61001", { lineageId: "lineage-git" });
  const unavailable = task("FN-61002", { lineageId: "lineage-missing-git" });
  const artifacts = {
    [artifactBacked.id]: task(artifactBacked.id, {
      executionCompletedAt: "2026-01-02T00:00:00.000Z",
      tokenUsage: { inputTokens: 2, outputTokens: 1, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 3 },
    }),
  };
  const store = fakeStore({ done: [artifactBacked, gitBacked, unavailable], artifacts });
  const resolveCommitFiles = async (_store, value) => value.id === gitBacked.id
    ? { files: ["src/exact.ts"], available: 1, unavailable: 0 }
    : value.id === unavailable.id
      ? { files: undefined, available: 0, unavailable: 1 }
      : { files: undefined, available: 0, unavailable: 0 };

  const dryRun = await reconcileArchivedTaskHistory({ store, apply: false, resolveCommitFiles });
  assert.equal(store.diagnostics().supplementApplyCalls, 0);
  assert(dryRun.recoveredFields.some((item) => item.taskId === artifactBacked.id && item.field === "tokenUsage"));
  assert(dryRun.recoveredFields.some((item) => item.taskId === gitBacked.id && item.field === "modifiedFiles"));
  assert.deepEqual(dryRun.gitEvidence.find((item) => item.taskId === unavailable.id), {
    taskId: unavailable.id,
    available: 0,
    unavailable: 1,
  });

  const applied = await reconcileArchivedTaskHistory({ store, apply: true, resolveCommitFiles });
  const repeated = await reconcileArchivedTaskHistory({ store, apply: true, resolveCommitFiles });
  assert.equal(store.diagnostics().rows.get(artifactBacked.id).executionCompletedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(store.diagnostics().rows.get(gitBacked.id).modifiedFiles, ["src/exact.ts"]);
  assert.equal(store.diagnostics().rows.get(unavailable.id).modifiedFiles, undefined);
  assert(applied.recoveredFields.some((item) => item.taskId === gitBacked.id && item.field === "modifiedFiles"));
  assert.equal(repeated.recoveredFields.length, 0);
  assert.equal(store.diagnostics().supplementApplyCalls, 2);
});

test("refuses an ambiguous project identity before reading history", async () => {
  const store = fakeStore({ projectId: "" });
  await assert.rejects(
    reconcileArchivedTaskHistory({ store, apply: false }),
    /Exact project identity is required/,
  );
  assert.equal(store.diagnostics().reconcileCalls, 0);
});

test("PostgreSQL orchestration keeps live proof and repairs snapshot, artifact, and Git evidence idempotently", async () => {
  /*
  FNXC:TaskArchiveReintegration 2026-09-06-09:03:
  The operator script needs production-path PostgreSQL coverage, not only a fake that duplicates its
  merge rules. This fixture boots the real backend and exercises locked supplement and drain APIs.
  */
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "fn-303-reconcile-script-pg-"));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: rootDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "fn-303@example.invalid"], { cwd: rootDir });
  execFileSync("git", ["config", "user.name", "FN-303 test"], { cwd: rootDir });
  mkdirSync(path.join(rootDir, "src"), { recursive: true });
  writeFileSync(path.join(rootDir, "src", "exact.ts"), "export const exact = true;\n");
  execFileSync("git", ["add", "src/exact.ts"], { cwd: rootDir });
  execFileSync("git", ["commit", "-m", "test: add exact history proof"], { cwd: rootDir, stdio: "ignore" });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim();

  const startupUrl = new globalThis.URL("../../packages/core/src/postgres/startup-factory.ts", import.meta.url).href;
  const coreUrl = new globalThis.URL("../../packages/core/src/index.ts", import.meta.url).href;
  const archiveLineageUrl = new globalThis.URL("../../packages/core/src/task-store/async/async-archive-lineage.ts", import.meta.url).href;
  const [{ createTaskStoreForBackend }, { postgresSchema: schema, drizzleSql }, { upsertArchivedTaskEntry }] = await Promise.all([
    tsImport(startupUrl, import.meta.url),
    tsImport(coreUrl, import.meta.url),
    tsImport(archiveLineageUrl, import.meta.url),
  ]);
  const boot = await createTaskStoreForBackend({
    rootDir,
    embeddedDataDir: path.join(rootDir, ".embedded-pg"),
    skipArchiveReintegrationOnInit: true,
  });
  const store = boot.taskStore;
  const layer = store.getAsyncLayer();

  try {
    const live = await store.createTaskWithReservedId(
      { description: "live artifact proof", column: "done" },
      { taskId: "FN-30301", applyDefaultWorkflowSteps: false },
    );
    await store.updateTask(live.id, {
      cumulativeActiveMs: 100,
      executionCompletedAt: "2026-09-01T12:00:00.000Z",
    });
    const artifactProof = await store.getTask(live.id);
    const artifactDir = path.join(rootDir, ".fusion", "tasks", live.id);
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, "task.json"), `${JSON.stringify(artifactProof, null, 2)}\n`);
    await layer.db.update(schema.project.tasks).set({
      cumulativeActiveMs: 900,
      executionCompletedAt: null,
    }).where(drizzleSql`${schema.project.tasks.projectId} = ${layer.projectId} AND ${schema.project.tasks.id} = ${live.id}`);

    const cold = await store.createTaskWithReservedId(
      {
        description: "cold snapshot proof",
        column: "done",
        tokenUsage: {
          inputTokens: 8,
          outputTokens: 2,
          cachedTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 10,
          firstUsedAt: "2026-09-01T10:00:00.000Z",
          lastUsedAt: "2026-09-01T10:05:00.000Z",
        },
      },
      { taskId: "FN-30302", applyDefaultWorkflowSteps: false },
    );
    const coldEntry = await store.taskToArchiveEntry(cold, "2026-09-01T12:30:00.000Z");
    await upsertArchivedTaskEntry(layer.db, coldEntry, layer.projectId);
    await layer.db.delete(schema.project.tasks).where(
      drizzleSql`${schema.project.tasks.projectId} = ${layer.projectId} AND ${schema.project.tasks.id} = ${cold.id}`,
    );

    const gitBacked = await store.createTaskWithReservedId(
      { description: "commit association proof", column: "done" },
      { taskId: "FN-30303", applyDefaultWorkflowSteps: false },
    );
    await store.upsertTaskCommitAssociation({
      taskLineageId: gitBacked.lineageId,
      taskIdSnapshot: gitBacked.id,
      commitSha,
      commitSubject: "test: add exact history proof",
      authoredAt: "2026-09-01T11:00:00.000Z",
      matchedBy: "canonical-lineage-trailer",
      confidence: "canonical",
    });
    await store.upsertTaskCommitAssociation({
      taskLineageId: gitBacked.lineageId,
      taskIdSnapshot: gitBacked.id,
      commitSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      commitSubject: "missing object",
      authoredAt: "2026-09-01T11:01:00.000Z",
      matchedBy: "canonical-lineage-trailer",
      confidence: "canonical",
    });
    await layer.db.update(schema.project.tasks).set({ modifiedFiles: null }).where(
      drizzleSql`${schema.project.tasks.projectId} = ${layer.projectId} AND ${schema.project.tasks.id} = ${gitBacked.id}`,
    );

    const dryRun = await reconcileArchivedTaskHistory({ store, apply: false });
    assert.equal((await store.getTask(live.id)).executionCompletedAt, undefined);
    await assert.rejects(store.getTask(cold.id));
    assert(dryRun.recoveredFields.some(({ taskId, field }) => taskId === live.id && field === "executionCompletedAt"));
    assert(dryRun.recoveredFields.some(({ taskId, field }) => taskId === gitBacked.id && field === "modifiedFiles"));
    assert.deepEqual(dryRun.gitEvidence.find(({ taskId }) => taskId === gitBacked.id), {
      taskId: gitBacked.id,
      available: 1,
      unavailable: 1,
    });

    const applied = await reconcileArchivedTaskHistory({ store, apply: true });
    assert.equal(applied.totalDoneAfter, 3);
    assert.equal((await store.getTask(live.id)).cumulativeActiveMs, 900);
    assert.equal((await store.getTask(live.id)).executionCompletedAt, "2026-09-01T12:00:00.000Z");
    assert.equal((await store.getTask(cold.id)).tokenUsage?.totalTokens, 10);
    assert.deepEqual((await store.getTask(gitBacked.id)).modifiedFiles, ["src/exact.ts"]);

    const repeated = await reconcileArchivedTaskHistory({ store, apply: true });
    assert.equal(repeated.totalDoneBefore, 3);
    assert.equal(repeated.totalDoneAfter, 3);
    assert.deepEqual(repeated.restored, []);
    assert.deepEqual(repeated.recoveredFields, []);
  } finally {
    await boot.shutdown();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
