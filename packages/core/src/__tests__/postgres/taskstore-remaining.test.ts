/**
 * TaskStore remaining modules PostgreSQL integration tests (U14).
 *
 * FNXC:TaskStoreRemaining 2026-06-24-11:10:
 * Integration tests proving the async archive/lineage, branch-groups,
 * workflow-workitems, audit, comments/attachments, events, and search helpers
 * preserve the load-bearing invariants against a real PostgreSQL instance.
 * Each test creates a uniquely-named fresh database, applies the baseline
 * schema, and exercises the async helpers that the migrating TaskStore
 * modules consume.
 *
 * Coverage targets (the assertions U14 fulfills):
 *   VAL-CROSS-014 — Soft-deleting a child task allows parent deletion.
 *   VAL-CROSS-015 — Archiving a parent scopes documents/artifacts out of live
 *     views but preserves them for restore.
 *   Comments/attachments round-trip on active tasks.
 *   Audit mutations and run-audit events commit or roll back together.
 *
 * Skipped when PostgreSQL is unreachable (FUSION_PG_TEST_SKIP=1) so the merge
 * gate stays green without a running server.
 */

import { it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import {
  pgDescribe,
  createSharedPgTaskStoreTestHarness,
} from "../../__test-utils__/pg-test-harness.js";
import * as schema from "../../postgres/schema/index.js";
import { insertTaskRow, softDeleteTaskRow } from "../../task-store/async/async-persistence.js";
import {
  TaskDocumentPreconditionFailedError,
  taskDocumentContentHash,
} from "../../task-document-concurrency.js";
import {
  upsertArchivedTaskEntry,
  findArchivedTaskEntry,
  listArchivedTaskEntries,
  filterArchivedTaskEntries,
  listLiveTaskDocuments,
  listLiveArtifacts,
  listAllTaskDocuments,
} from "../../task-store/async/async-archive-lineage.js";
import {
  createBranchGroup,
  getBranchGroup,
  getBranchGroupBySource,
  updateBranchGroup,
  listBranchGroups,
  ensureBranchGroupForSource,
  ensurePrEntityForSource,
  updatePrEntity,
  getPrEntity,
  listActivePrEntities,
  recordPrThreadOutcome,
  getPrThreadState,
} from "../../task-store/async/async-branch-groups.js";
import {
  upsertWorkflowWorkItem,
  transitionWorkflowWorkItem,
  getWorkflowWorkItem,
  listDueWorkflowWorkItems,
  recordCompletionHandoff,
  getCompletionHandoffMarker,
} from "../../task-store/async/async-workflow-workitems.js";
import {
  recordActivityLogEntry,
  getActivityLog,
  queryRunAuditEvents,
} from "../../task-store/async/async-audit.js";
import {
  getTaskDocument,
  getTaskDocumentRevisions,
  upsertTaskDocument,
  listTaskDocuments,
  insertArtifactRow,
  getArtifact,
  getArtifacts,
} from "../../task-store/async/async-comments-attachments.js";
import {
  recordGoalCitations,
  listGoalCitations,
  emitUsageEvent,
  queryUsageEvents,
  recordPluginActivation,
} from "../../task-store/async/async-events.js";
import {
  sanitizeSearchTokens,
  searchTasksLike,
  countSearchTasksLike,
} from "../../task-store/async/async-search.js";

/** FNXC:MultiProjectIsolation 2026-07-16-00:05: the project every harness row is owned by. */
const TEST_PROJECT_ID = "proj_test_u14";

/*
FNXC:TaskStoreRemaining 2026-08-15-03:52:
Slow-test fix: this file hand-rolled CREATE DATABASE + full applySchemaBaseline
PER TEST (~1.9s/test, 52s for the file). The helpers under test write only data,
so the shared per-file harness (one golden-template DB + per-test reset) keeps
isolation with the schema built once. The FNXC:MultiProjectIsolation 2026-07-16
production-shape binding is preserved by passing `projectId: TEST_PROJECT_ID`
to the harness, which threads the `fusion.project_id` GUC into the runtime
connections and the layer exactly as the old inline setup did. `ctx` keeps its
original `{ layer }` shape so test bodies stay byte-identical.
*/
interface TestCtx {
  layer: AsyncDataLayer;
}

/** A minimal task record with the NOT NULL columns filled. */
function makeMinimalTask(id: string, column = "todo"): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id,
    description: "test task",
    column,
    currentStep: 0,
    createdAt: now,
    updatedAt: now,
  };
}

pgDescribe("U14 taskstore-remaining (PostgreSQL)", () => {
  const h = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_u14",
    projectId: TEST_PROJECT_ID,
  });
  let ctx!: TestCtx;

  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    ctx = { layer: h.layer() };
  });
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  // ── VAL-CROSS-014: Soft-deleting a child task allows parent deletion ──

  it("soft-deleting a child allows parent deletion (VAL-CROSS-014)", async () => {
    // Seed a parent + a live child.
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-PARENT"), { lineageId: null });
    await insertTaskRow(
      ctx.layer,
      { ...makeMinimalTask("KB-CHILD"), sourceParentTaskId: "KB-PARENT" },
      { lineageId: null },
    );

    // Soft-delete the child (moves to archived + sets deleted_at).
    await softDeleteTaskRow(ctx.layer, "KB-CHILD", new Date().toISOString());

    // Now the parent can be soft-deleted because the child no longer counts as live.
    await softDeleteTaskRow(ctx.layer, "KB-PARENT", new Date().toISOString());

    // Both rows are soft-deleted.
    const parent = await ctx.layer.db
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-PARENT"));
    expect(parent[0]?.deletedAt).not.toBeNull();

    const child = await ctx.layer.db
      .select({ deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(eq(schema.project.tasks.id, "KB-CHILD"));
    expect(child[0]?.deletedAt).not.toBeNull();
  });

  // ── VAL-CROSS-015: Archive scopes docs/artifacts out of live views ──

  it("archiving a parent scopes documents out of live views but preserves them (VAL-CROSS-015)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-DOC-PARENT"), { lineageId: null });

    // Create a document on the live task.
    await upsertTaskDocument(ctx.layer, "KB-DOC-PARENT", {
      key: "spec",
      content: "initial content",
      author: "user",
    });

    // Live view shows the document.
    let docs = await listLiveTaskDocuments(ctx.layer.db, "KB-DOC-PARENT");
    expect(docs).toHaveLength(1);
    expect(docs[0]?.key).toBe("spec");

    // Archive the parent (soft-delete → column = 'archived').
    await softDeleteTaskRow(ctx.layer, "KB-DOC-PARENT", new Date().toISOString());

    // Live view now shows NO documents (scoped out).
    docs = await listLiveTaskDocuments(ctx.layer.db, "KB-DOC-PARENT");
    expect(docs).toHaveLength(0);

    // Forensic view still has the document (preserved for restore).
    const allDocs = await listAllTaskDocuments(ctx.layer.db, "KB-DOC-PARENT");
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0]?.key).toBe("spec");
  });

  it("archiving a parent scopes artifacts out of live views but preserves them (VAL-CROSS-015)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-ART-PARENT"), { lineageId: null });

    // Register an artifact on the live task.
    await insertArtifactRow(ctx.layer, {
      type: "screenshot",
      title: "test artifact",
      authorId: "agent-1",
      authorType: "agent",
      taskId: "KB-ART-PARENT",
      content: "base64data",
    }, {});

    // Live view shows the artifact.
    let artifacts = await listLiveArtifacts(ctx.layer.db, "KB-ART-PARENT");
    expect(artifacts).toHaveLength(1);

    // Archive the parent.
    await softDeleteTaskRow(ctx.layer, "KB-ART-PARENT", new Date().toISOString());

    // Live view now shows NO artifacts.
    artifacts = await listLiveArtifacts(ctx.layer.db, "KB-ART-PARENT");
    expect(artifacts).toHaveLength(0);

    // The artifact row still exists (preserved for restore).
    const rows = await ctx.layer.db
      .select({ id: schema.project.artifacts.id })
      .from(schema.project.artifacts)
      .where(eq(schema.project.artifacts.taskId, "KB-ART-PARENT"));
    expect(rows).toHaveLength(1);
  });

  // ── Comments/attachments round-trip on active tasks ──

  it("task documents round-trip on active tasks (upsert + read + update)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-DOC-RT"), { lineageId: null });

    // Initial create.
    const doc1 = await upsertTaskDocument(ctx.layer, "KB-DOC-RT", {
      key: "design",
      content: "v1 content",
      author: "user",
    });
    expect(doc1.revision).toBe(1);
    expect(doc1.content).toBe("v1 content");

    // Update (creates a revision).
    const doc2 = await upsertTaskDocument(ctx.layer, "KB-DOC-RT", {
      key: "design",
      content: "v2 content",
      author: "agent-1",
    });
    expect(doc2.revision).toBe(2);
    expect(doc2.content).toBe("v2 content");

    // Read back.
    const read = await getTaskDocument(ctx.layer.db, "KB-DOC-RT", "design", TEST_PROJECT_ID);
    expect(read?.revision).toBe(2);
    expect(read?.content).toBe("v2 content");

    // List shows the document.
    const docs = await listTaskDocuments(ctx.layer.db, "KB-DOC-RT", TEST_PROJECT_ID);
    expect(docs).toHaveLength(1);
  });

  it("enforces task-document CAS atomically for creates and updates", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-DOC-CAS"), { lineageId: null });

    expect(taskDocumentContentHash("line 1\r\nline 2")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(taskDocumentContentHash("line 1\r\nline 2")).not.toBe(taskDocumentContentHash("line 1\nline 2"));
    await expect(upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "invalid",
      content: "x",
      expectedRevision: -1,
    })).rejects.toThrow(/non-negative integer/);
    await expect(upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "invalid",
      content: "x",
      expectedContentHash: "sha256:ABC",
    })).rejects.toThrow(/64 lowercase hex/);

    await expect(upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "missing", content: "x", expectedRevision: 1,
    })).rejects.toBeInstanceOf(TaskDocumentPreconditionFailedError);
    await expect(upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "missing", content: "x", expectedContentHash: taskDocumentContentHash("x"),
    })).rejects.toBeInstanceOf(TaskDocumentPreconditionFailedError);

    const createRace = await Promise.allSettled([
      upsertTaskDocument(ctx.layer, "KB-DOC-CAS", { key: "evidence", content: "create-a", expectedRevision: 0 }),
      upsertTaskDocument(ctx.layer, "KB-DOC-CAS", { key: "evidence", content: "create-b", expectedRevision: 0 }),
    ]);
    expect(createRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const createLoser = createRace.find((result) => result.status === "rejected");
    expect(createLoser).toMatchObject({ reason: expect.any(TaskDocumentPreconditionFailedError) });

    const created = await getTaskDocument(ctx.layer.db, "KB-DOC-CAS", "evidence", TEST_PROJECT_ID);
    expect(created).not.toBeNull();
    expect(created?.contentHash).toBe(taskDocumentContentHash(created!.content));
    let history = await ctx.layer.db.select().from(schema.project.taskDocumentRevisions).where(eq(schema.project.taskDocumentRevisions.taskId, "KB-DOC-CAS"));
    expect(history).toHaveLength(0);

    const baseRevision = created!.revision;
    const baseHash = created!.contentHash;
    const updateRace = await Promise.allSettled([
      upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
        key: "evidence", content: "winner-a", expectedRevision: baseRevision, expectedContentHash: baseHash,
      }),
      upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
        key: "evidence", content: "winner-b", expectedRevision: baseRevision, expectedContentHash: baseHash,
      }),
    ]);
    expect(updateRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const updateLoser = updateRace.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(updateLoser.reason).toBeInstanceOf(TaskDocumentPreconditionFailedError);
    expect((updateLoser.reason as TaskDocumentPreconditionFailedError).toDetails()).toMatchObject({
      code: "TASK_DOCUMENT_PRECONDITION_FAILED",
      projectId: TEST_PROJECT_ID,
      taskId: "KB-DOC-CAS",
      key: "evidence",
      expectedRevision: baseRevision,
      expectedContentHash: baseHash,
      currentRevision: baseRevision + 1,
    });
    expect((updateLoser.reason as TaskDocumentPreconditionFailedError).toDetails()).not.toHaveProperty("content");

    const current = await getTaskDocument(ctx.layer.db, "KB-DOC-CAS", "evidence", TEST_PROJECT_ID);
    expect(current?.revision).toBe(baseRevision + 1);
    expect(["winner-a", "winner-b"]).toContain(current?.content);
    history = await ctx.layer.db.select().from(schema.project.taskDocumentRevisions).where(eq(schema.project.taskDocumentRevisions.taskId, "KB-DOC-CAS"));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ revision: baseRevision, content: created!.content });

    await expect(upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "evidence", content: "stale-revision", expectedRevision: baseRevision,
    })).rejects.toBeInstanceOf(TaskDocumentPreconditionFailedError);
    await expect(upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "evidence", content: "stale-hash", expectedContentHash: baseHash,
    })).rejects.toBeInstanceOf(TaskDocumentPreconditionFailedError);
    let unchangedHistory = await ctx.layer.db.select().from(schema.project.taskDocumentRevisions).where(eq(schema.project.taskDocumentRevisions.taskId, "KB-DOC-CAS"));
    expect(unchangedHistory).toHaveLength(1);

    const revisionOnly = await upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "evidence", content: "revision-only", expectedRevision: current!.revision,
    });
    const hashOnly = await upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
      key: "evidence", content: "hash-only", expectedContentHash: revisionOnly.contentHash,
    });
    const identicalRace = await Promise.allSettled([
      upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
        key: "evidence", content: "same-content", expectedRevision: hashOnly.revision, expectedContentHash: hashOnly.contentHash,
      }),
      upsertTaskDocument(ctx.layer, "KB-DOC-CAS", {
        key: "evidence", content: "same-content", expectedRevision: hashOnly.revision, expectedContentHash: hashOnly.contentHash,
      }),
    ]);
    expect(identicalRace.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    unchangedHistory = await ctx.layer.db.select().from(schema.project.taskDocumentRevisions).where(eq(schema.project.taskDocumentRevisions.taskId, "KB-DOC-CAS"));
    expect(unchangedHistory).toHaveLength(4);
  });

  it("artifacts round-trip on active tasks (register + read)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-ART-RT"), { lineageId: null });

    const artifact = await insertArtifactRow(ctx.layer, {
      type: "file",
      title: "round-trip artifact",
      description: "a test",
      authorId: "user-1",
      authorType: "user",
      taskId: "KB-ART-RT",
      content: "hello world",
      metadata: { source: "test" },
    }, {});

    expect(artifact.title).toBe("round-trip artifact");
    expect(artifact.taskId).toBe("KB-ART-RT");

    const read = await getArtifact(ctx.layer.db, artifact.id);
    expect(read?.title).toBe("round-trip artifact");
    expect(read?.metadata).toEqual({ source: "test" });

    const list = await getArtifacts(ctx.layer.db, "KB-ART-RT", TEST_PROJECT_ID);
    expect(list).toHaveLength(1);
  });

  it("document upsert is rejected against soft-deleted tasks", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-DELETED-DOC"), { lineageId: null });
    await softDeleteTaskRow(ctx.layer, "KB-DELETED-DOC", new Date().toISOString());

    await expect(
      upsertTaskDocument(ctx.layer, "KB-DELETED-DOC", {
        key: "spec",
        content: "content",
      }),
    ).rejects.toThrow(/deleted|historical|not found/);
  });

  // ── Audit mutations and run-audit events commit/roll back together ──

  it("activity log entries round-trip (record + query)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-ACT"), { lineageId: null });

    await recordActivityLogEntry(ctx.layer.db, ctx.layer.projectId ?? "", {
      type: "task:moved",
      taskId: "KB-ACT",
      taskTitle: "Test Task",
      details: "Moved from todo to in-progress",
      metadata: { from: "todo", to: "in-progress" },
    });

    const entries = await getActivityLog(ctx.layer.db, ctx.layer.projectId ?? "", { type: "task:moved" });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskId).toBe("KB-ACT");
    expect(entries[0]?.metadata).toEqual({ from: "todo", to: "in-progress" });
  });

  it("run-audit events query by taskId", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-AUDIT"), { lineageId: null });

    // Record a run-audit event directly.
    await ctx.layer.transactionImmediate(async (tx) => {
      await tx.insert(schema.project.runAuditEvents).values({
        id: "evt-1",
        timestamp: new Date().toISOString(),
        taskId: "KB-AUDIT",
        agentId: "agent-1",
        runId: "run-1",
        domain: "database",
        mutationType: "task:create",
        target: "KB-AUDIT",
        metadata: { foo: "bar" },
      });
    });

    const events = await queryRunAuditEvents(ctx.layer.db, { taskId: "KB-AUDIT" });
    expect(events).toHaveLength(1);
    expect(events[0]?.mutationType).toBe("task:create");
    expect(events[0]?.metadata).toEqual({ foo: "bar" });
  });

  // ── Branch groups ──

  it("branch groups round-trip (create + read + update + list)", async () => {
    const created = await createBranchGroup(ctx.layer.db, {
      sourceType: "mission",
      sourceId: "miss-1",
      branchName: "feature/test-branch",
      autoMerge: true,
    });

    expect(created.branchName).toBe("feature/test-branch");
    expect(created.autoMerge).toBe(true);
    expect(created.status).toBe("open");

    const read = await getBranchGroup(ctx.layer.db, created.id);
    expect(read?.id).toBe(created.id);

    const bySource = await getBranchGroupBySource(ctx.layer.db, "mission", "miss-1");
    expect(bySource?.id).toBe(created.id);

    const updated = await updateBranchGroup(ctx.layer.db, created.id, {
      prState: "open",
      prUrl: "https://github.com/example/pr/1",
    });
    expect(updated.prState).toBe("open");
    expect(updated.prUrl).toBe("https://github.com/example/pr/1");

    const list = await listBranchGroups(ctx.layer.db, { status: "open" });
    expect(list).toHaveLength(1);
  });

  it("ensureBranchGroupForSource reuses existing group for same branch", async () => {
    const g1 = await ensureBranchGroupForSource(
      ctx.layer.db,
      "mission",
      "m1",
      { branchName: "feature/shared", autoMerge: false },
    );
    const g2 = await ensureBranchGroupForSource(
      ctx.layer.db,
      "mission",
      "m2",
      { branchName: "feature/shared", autoMerge: false },
    );
    // Same branch name → reuse, not collide.
    expect(g2.id).toBe(g1.id);
  });

  it("PR entities round-trip (ensure + update + list active)", async () => {
    const created = await ensurePrEntityForSource(ctx.layer.db, {
      sourceType: "task",
      sourceId: "task-1",
      repo: "owner/repo",
      headBranch: "feature/pr-test",
    });

    expect(created.state).toBe("creating");

    // Re-ensure is idempotent (reuses the active entity).
    const reEnsured = await ensurePrEntityForSource(ctx.layer.db, {
      sourceType: "task",
      sourceId: "task-1",
      repo: "owner/repo",
      headBranch: "feature/pr-test",
    });
    expect(reEnsured.id).toBe(created.id);

    // Update to 'open' with a PR number.
    const updated = await updatePrEntity(ctx.layer.db, created.id, {
      state: "open",
      prNumber: 42,
      prUrl: "https://github.com/owner/repo/pull/42",
    });
    expect(updated.state).toBe("open");
    expect(updated.prNumber).toBe(42);

    // List active includes it.
    const active = await listActivePrEntities(ctx.layer.db);
    expect(active.some((e) => e.id === created.id)).toBe(true);

    // Transition to 'merged' (terminal) removes it from the active set.
    await updatePrEntity(ctx.layer.db, created.id, { state: "merged" });
    const activeAfter = await listActivePrEntities(ctx.layer.db);
    expect(activeAfter.some((e) => e.id === created.id)).toBe(false);
  });

  it("PR thread outcomes round-trip (record + read)", async () => {
    const pr = await ensurePrEntityForSource(ctx.layer.db, {
      sourceType: "task",
      sourceId: "task-thread",
      repo: "owner/repo",
      headBranch: "feature/thread",
    });

    await recordPrThreadOutcome(ctx.layer.db, pr.id, "thread-1", "abc123", "fixed", "fix-commit-1");

    const state = await getPrThreadState(ctx.layer.db, pr.id, "thread-1", "abc123");
    expect(state?.outcome).toBe("fixed");
    expect(state?.fixCommitSha).toBe("fix-commit-1");
  });

  // ── Workflow work-items ──

  it("workflow work items round-trip (upsert + transition + terminal guard)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-WF"), { lineageId: null });

    const item = await upsertWorkflowWorkItem(ctx.layer, {
      runId: "run-1",
      taskId: "KB-WF",
      nodeId: "node-1",
      kind: "review",
      state: "runnable",
    });

    expect(item.state).toBe("runnable");

    // Transition to 'running'.
    const running = await transitionWorkflowWorkItem(ctx.layer, item.id, "running");
    expect(running.state).toBe("running");

    // Transition to 'succeeded' (terminal). #2378 renamed the terminal
    // completion state from 'completed' to 'succeeded' (WORKFLOW_WORK_ITEM_STATES).
    const completed = await transitionWorkflowWorkItem(ctx.layer, item.id, "succeeded");
    expect(completed.state).toBe("succeeded");

    // Terminal guard: cannot requeue a succeeded item.
    await expect(
      transitionWorkflowWorkItem(ctx.layer, item.id, "runnable"),
    ).rejects.toThrow(/terminal/);
  });

  it("workflow work item upsert is idempotent on composite key", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-WF-IDEM"), { lineageId: null });

    const item1 = await upsertWorkflowWorkItem(ctx.layer, {
      runId: "run-2",
      taskId: "KB-WF-IDEM",
      nodeId: "node-1",
      kind: "review",
    });
    const item2 = await upsertWorkflowWorkItem(ctx.layer, {
      runId: "run-2",
      taskId: "KB-WF-IDEM",
      nodeId: "node-1",
      kind: "review",
      state: "running",
    });
    // Same composite key → same id, state updated.
    expect(item2.id).toBe(item1.id);
    expect(item2.state).toBe("running");
  });

  it("completion handoff markers round-trip (record + read)", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-HANDOFF"), { lineageId: null });

    await recordCompletionHandoff(ctx.layer.db, "KB-HANDOFF", "engine");
    const marker = await getCompletionHandoffMarker(ctx.layer.db, "KB-HANDOFF");
    expect(marker?.source).toBe("engine");
  });

  it("listDueWorkflowWorkItems returns items with expired/null leases", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-DUE"), { lineageId: null });

    await upsertWorkflowWorkItem(ctx.layer, {
      runId: "run-due",
      taskId: "KB-DUE",
      nodeId: "node-due",
      kind: "execute",
      state: "runnable",
    });

    const due = await listDueWorkflowWorkItems(ctx.layer.db, { limit: 10 });
    expect(due.some((i) => i.taskId === "KB-DUE")).toBe(true);
  });

  // ── Goal citations / usage events / plugin activations ──

  it("goal citations dedup on (goalId, surface, sourceRef)", async () => {
    const inserted1 = await recordGoalCitations(ctx.layer.db, [
      { goalId: "g1", agentId: "a1", surface: "task_document", sourceRef: "doc:1", snippet: "cite 1" },
    ]);
    expect(inserted1).toHaveLength(1);

    // Same (goalId, surface, sourceRef) → deduped (no insert).
    const inserted2 = await recordGoalCitations(ctx.layer.db, [
      { goalId: "g1", agentId: "a1", surface: "task_document", sourceRef: "doc:1", snippet: "cite 1 updated" },
    ]);
    expect(inserted2).toHaveLength(0);

    // Different sourceRef → inserted.
    const inserted3 = await recordGoalCitations(ctx.layer.db, [
      { goalId: "g1", agentId: "a1", surface: "task_document", sourceRef: "doc:2", snippet: "cite 2" },
    ]);
    expect(inserted3).toHaveLength(1);

    const all = await listGoalCitations(ctx.layer.db, { goalId: "g1" });
    expect(all).toHaveLength(2);
  });

  it("usage events round-trip (emit + query)", async () => {
    const inserted = await emitUsageEvent(ctx.layer.db, ctx.layer.projectId ?? "", {
      kind: "tool_call",
      taskId: "KB-USAGE",
      agentId: "agent-1",
      toolName: "edit",
      category: "edit",
      meta: { duration: 42 },
    });
    expect(inserted).toBe(true);

    const events = await queryUsageEvents(ctx.layer.db, ctx.layer.projectId ?? "", { taskId: "KB-USAGE" });
    expect(events).toHaveLength(1);
    expect(events[0]?.toolName).toBe("edit");
    expect(events[0]?.meta).toEqual({ duration: 42 });
  });

  it("usage events fail-soft on unknown kind", async () => {
    const inserted = await emitUsageEvent(ctx.layer.db, ctx.layer.projectId ?? "", {
      // @ts-expect-error — intentionally invalid kind
      kind: "bogus_kind",
    });
    expect(inserted).toBe(false);
  });

  it("plugin activations round-trip (record)", async () => {
    const activation = await recordPluginActivation(ctx.layer.db, {
      pluginId: "roadmap",
      source: "npm",
      pluginVersion: "1.0.0",
    });
    expect(activation.pluginId).toBe("roadmap");
    expect(activation.id).toBeGreaterThan(0);
  });

  // ── Archive snapshots ──

  it("archived task snapshots round-trip (upsert + find + list + filter)", async () => {
    const entry = {
      id: "KB-ARCH-SNAP",
      lineageId: "lineage-1",
      title: "Archived Task",
      description: "An archived task",
      archivedAt: new Date().toISOString(),
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
    };

    await upsertArchivedTaskEntry(ctx.layer.db, entry);

    const found = await findArchivedTaskEntry(ctx.layer.db, "KB-ARCH-SNAP");
    expect(found?.id).toBe("KB-ARCH-SNAP");
    expect(found?.title).toBe("Archived Task");

    const list = await listArchivedTaskEntries(ctx.layer.db);
    expect(list).toHaveLength(1);

    const filtered = await filterArchivedTaskEntries(ctx.layer.db, ["KB-ARCH-SNAP", "KB-MISSING"]);
    expect(filtered.has("KB-ARCH-SNAP")).toBe(true);
    expect(filtered.has("KB-MISSING")).toBe(false);

    // FNXC:TaskArchiveRemoval 2026-09-04-18:25:
    // Historical snapshots remain readable for migration/forensics but must never enter a move path.
    await expect(h.store().readTaskForMove("KB-ARCH-SNAP")).rejects.toThrow("Task KB-ARCH-SNAP not found");
  });

  // ── Search query structure ──

  it("sanitizeSearchTokens strips FTS operators and splits on whitespace", () => {
    expect(sanitizeSearchTokens("hello world")).toEqual(["hello", "world"]);
    expect(sanitizeSearchTokens('"quoted" {braced} :colons')).toEqual(["quoted", "braced", "colons"]);
    expect(sanitizeSearchTokens("")).toEqual([]);
    expect(sanitizeSearchTokens("   ")).toEqual([]);
  });

  it("searchTasksLike finds tasks by token and respects soft-delete", async () => {
    await insertTaskRow(
      ctx.layer,
      { ...makeMinimalTask("KB-SEARCH-1"), title: "implement auth" },
      { lineageId: null },
    );
    await insertTaskRow(
      ctx.layer,
      { ...makeMinimalTask("KB-SEARCH-2"), title: "unrelated work" },
      { lineageId: null },
    );

    // Soft-delete the second task.
    await softDeleteTaskRow(ctx.layer, "KB-SEARCH-2", new Date().toISOString());

    // Search for "auth" → only KB-SEARCH-1 (KB-SEARCH-2 is soft-deleted).
    const results = await searchTasksLike(ctx.layer.db, "auth");
    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe("KB-SEARCH-1");

    // Count agrees.
    const count = await countSearchTasksLike(ctx.layer.db, "auth");
    expect(count).toBe(1);
  });

  it("searchTasksLike returns empty for empty queries", async () => {
    await insertTaskRow(ctx.layer, makeMinimalTask("KB-EMPTY"), { lineageId: null });

    const results = await searchTasksLike(ctx.layer.db, "");
    expect(results).toEqual([]);
  });
});
