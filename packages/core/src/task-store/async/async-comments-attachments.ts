/**
 * Async Drizzle comments / attachments / documents helpers (U14).
 *
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-09:30:
 * Async equivalents of the sync SQLite task-document and artifact call sites
 * in store.ts (`upsertTaskDocument`, `getTaskDocument`, `getTaskDocumentRevisions`,
 * `registerArtifact`, `getArtifact`, `getArtifacts`). These helpers target the
 * PostgreSQL `project.task_documents`, `project.task_document_revisions`, and
 * `project.artifacts` tables via Drizzle.
 *
 * Document/artifact parent-task scoping (VAL-CROSS-015):
 *   Documents and artifacts scoped to a task are read-only when the task is
 *   archived. The upsert paths reject writes against archived tasks. The list
 *   paths filter by the parent task's live state (`deleted_at IS NULL` AND
 *   `column != 'archived'`) so rows scoped to an archived parent disappear
 *   from live views but are retained for restore.
 *
 * JSON columns (VAL-SCHEMA-004):
 *   The `metadata` columns are jsonb in PostgreSQL. Drizzle returns them
 *   already-parsed as JS values. On write, pass the JS value directly.
 *
 * Transition context (see library/taskstore-persistence-notes.md):
 *   `getDatabase()` still returns the sync `Database` until U15 flips it. The
 *   TaskStore facade keeps its sync document/artifact path (the gate depends
 *   on it). These helpers are the async target the migrating store and the
 *   PostgreSQL integration tests consume.
 */
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as schema from "../../postgres/schema/index.js";
import { projectScopeFor, recordRunAuditEventWithinTransaction, type AsyncDataLayer, type DbTransaction } from "../../postgres/data-layer.js";
import { ACTIVE_TASK_FILTER } from "./async-persistence.js";
import { projectPartition } from "./async-lifecycle.js";
import {
  ARCHIVED_TASK_DOCUMENT_ADDITION_BOUNDARY,
  ArchivedTaskDocumentPublicationRejectedError,
  assertTaskDocumentPreconditions,
  taskDocumentContentHash,
  validateArchivedTaskDocumentAddition,
} from "../../task-document-concurrency.js";
import type {
  Artifact,
  ArtifactCreateInput,
  ArtifactWithTask,
  ArchivedTaskDocumentAdditionInput,
  ArchivedTaskDocumentAdditionResult,
  TaskDocument,
  TaskDocumentCreateInput,
  TaskDocumentWithTask,
} from "../../types.js";
import type {
  ArtifactRow,
  TaskDocumentRow,
  TaskDocumentRevisionRow,
} from "../row-types.js";

/**
 * Convert a raw `task_documents` row into the public `TaskDocument` shape.
 * The `metadata` column is jsonb (already-parsed on read).
 */
function rowToTaskDocument(row: TaskDocumentRow): TaskDocument {
  const metadata =
    typeof row.metadata === "string"
      ? safeJsonParse(row.metadata)
      : (row.metadata as Record<string, unknown> | null);
  return {
    id: row.id,
    taskId: row.taskId,
    key: row.key,
    content: row.content,
    revision: row.revision,
    contentHash: taskDocumentContentHash(row.content),
    author: row.author,
    metadata: metadata ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function safeJsonParse(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Convert a raw `artifacts` row into the public `Artifact` shape.
 * The `metadata` column is jsonb (already-parsed on read).
 */
function rowToArtifact(row: ArtifactRow): Artifact {
  const metadata =
    typeof row.metadata === "string"
      ? safeJsonParse(row.metadata)
      : (row.metadata as Record<string, unknown> | null);
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    description: row.description ?? undefined,
    mimeType: row.mimeType ?? undefined,
    sizeBytes: row.sizeBytes ?? undefined,
    uri: row.uri ?? undefined,
    content: row.content ?? undefined,
    authorId: row.authorId,
    authorType: row.authorType,
    taskId: row.taskId ?? undefined,
    metadata: metadata ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-09:35:
 * Check whether a task is live (exists, not soft-deleted, not archived). This
 * is the document/artifact write gate — upserts are rejected against archived
 * or soft-deleted tasks. Returns the task's column if live, or `null` if the
 * task is absent, archived, or soft-deleted.
 */
/*
FNXC:WorkflowLifecycleColumns 2026-07-31-04:10:
The sentinel is only as correct as the lane test that PRODUCES it.

A dozen call sites across five files compare this function's result against the string "archived",
and every one of those comparisons is right precisely because this function manufactures it. Keyed on
the literal, a live row in a renamed archived lane (`vault`, not soft-deleted) was reported as LIVE —
so documents stayed readable and writable, artifacts listed, and log writes were accepted on a card
the board shows as archived. Fixing the twelve comparisons individually would have been wrong twice
over: they are sentinels, and the defect is here.

`archivedColumns` is threaded from the store-level impls, which are the only layer that can resolve
it — this function holds a `db` handle. Omitted, the legacy id answers, which is the behaviour every
caller had before.
*/
export async function getLiveTaskColumn(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
  projectId?: string,
  archivedColumns?: ReadonlySet<string>,
): Promise<string | null> {
  /*
  FNXC:PostgresArchiveSafety 2026-07-14-21:48:
  PostgreSQL async log, comment, document, and artifact paths must distinguish an archived or soft-deleted parent from a missing task within the bound project. Task IDs repeat across projects, so the state gate must never borrow another project's live or archived row.
  */
  const rows = await db
    .select({ column: schema.project.tasks.column, deletedAt: schema.project.tasks.deletedAt })
    .from(schema.project.tasks)
    .where(and(
      eq(schema.project.tasks.projectId, projectPartition(projectId)),
      eq(schema.project.tasks.id, taskId),
    ))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  /*
  FNXC:WorkflowResolvedColumns 2026-07-31-23:51 (DELIBERATE-LITERAL — FALLBACK ARM, not pending work):
  `archivedColumns` is the resolved path; the literal is reached only when a caller supplies no
  resolved set. `archived-column-gate-parity.test.ts` opens by naming THIS FILE as the worked example
  of why the archived gate cannot be converted one encoding at a time — the SQL halves in this same
  module still compare the raw string, so converting the TypeScript arm alone is the split brain it
  describes. Marked so the census stops offering it as available; the comparison is unchanged and that
  guard's scan is marker-blind, so its audited inventory is untouched.
  */
  const isArchivedLane = archivedColumns ? archivedColumns.has(row.column) : row.column === "archived";
  if (isArchivedLane || row.deletedAt != null) return "archived";
  return row.column;
}

/*
FNXC:WorkflowLifecycleColumns 2026-07-30-23:40:
The ARCHIVED-lane checks that read a task row, as opposed to the sentinel ones that do not.

`packages/core/src/task-store/async-comments-attachments.ts` holds both classes spelled identically,
which is why they were miscounted once already (#2877 review). The comparisons downstream of
`getLiveTaskColumn` test that function's MANUFACTURED "archived" and must stay literal. These two test
`task.column` straight off a row `select`, so they are board lanes and a renamed archived column is
simply not recognised:

  - `upsertTaskDocument` fails to reject, so an ARCHIVED card's documents stay WRITABLE;
  - `publishArchivedTaskDocumentAddition` fails to accept, rejecting a legitimate archived-document
    publication as `parent-not-archived` / `archived-state-inconsistent` — a false rejection of valid
    operator work, which is the sharper of the two.

Both take an `AsyncDataLayer` and cannot resolve anything themselves; their store-level impls can, so
the lane set arrives as a parameter. Optional with the legacy id as the default, so a caller that
resolves nothing keeps today's behaviour exactly.
*/
const LEGACY_ARCHIVED_LANES: ReadonlySet<string> = new Set(["archived"]);

/** Board columns that mean "archived"; omit to keep the built-in id. */
export type ArchivedLanes = ReadonlySet<string> | undefined;

const isArchivedLane = (column: string | null | undefined, lanes: ArchivedLanes): boolean =>
  column != null && (lanes ?? LEGACY_ARCHIVED_LANES).has(column);

// ── Task documents ───────────────────────────────────────────────────

/**
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-09:40:
 * Read a task document by (taskId, key). Direct named reads include retained
 * archived documents; missing parents and keys return `null`. Editable list
 * surfaces remain live-only through `listTaskDocuments`.
 */
export async function getTaskDocument(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
  key: string,
  projectId?: string,

  archivedColumns?: ReadonlySet<string>,): Promise<TaskDocument | null> {
  const column = await getLiveTaskColumn(db, taskId, projectId, archivedColumns);
  if (column === null) return null;

  const rows = await db
    .select()
    .from(schema.project.taskDocuments)
    .where(
      and(
        eq(schema.project.taskDocuments.projectId, projectPartition(projectId)),
        eq(schema.project.taskDocuments.taskId, taskId),
        eq(schema.project.taskDocuments.key, key),
      ),
    )
    .limit(1);
  const row = rows[0] as TaskDocumentRow | undefined;
  return row ? rowToTaskDocument(row) : null;
}

/**
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-09:45:
 * Create or update a task document while archiving the previous revision.
 * This is the async equivalent of `upsertTaskDocument`. The upsert is rejected
 * against archived or soft-deleted tasks (documents are read-only on archived
 * tasks). The revision-archive (insert into `task_document_revisions`) and the
 * document update run in a single transaction so the revision history is
 * consistent with the current document state.
 *
 * @param layer The async data layer (the upsert runs in its own transaction).
 * @param taskId The parent task id.
 * @param input The document create/update input.
 * @returns The upserted document.
 */
export async function upsertTaskDocument(
  layer: AsyncDataLayer,
  taskId: string,
  input: TaskDocumentCreateInput,
  archivedColumns?: ReadonlySet<string>,
): Promise<TaskDocument> {
  return layer.transactionImmediate(async (tx) => {
    const projectId = projectPartition(layer.projectId);
    /*
    FNXC:TaskDocumentCAS 2026-07-20-11:06:
    Every writer locks the active project's parent task row before reading a document. This serializes both existing-row updates and absent-row creates for every (project_id, task_id, key), so a precondition check, prior-snapshot archive, and replacement are one PostgreSQL transaction. A mismatch throws before history/current mutation; the facade consequently emits no task update and performs no citation scan.
    */
    const taskRows = await tx
      .select({ column: schema.project.tasks.column, deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, taskId),
      ))
      .limit(1)
      .for("update");
    const task = taskRows[0];
    if (isArchivedLane(task?.column, archivedColumns) || task?.deletedAt != null) {
      throw new Error(`Task ${taskId} is archived — documents are read-only`);
    }
    if (!task) throw new Error(`Task ${taskId} not found`);

    const now = new Date().toISOString();
    const author = input.author ?? "user";

    // Read after taking the parent lock, then compare before any mutation.
    const existingRows = await tx
      .select()
      .from(schema.project.taskDocuments)
      .where(
        and(
          eq(schema.project.taskDocuments.projectId, projectId),
          eq(schema.project.taskDocuments.taskId, taskId),
          eq(schema.project.taskDocuments.key, input.key),
        ),
      )
      .limit(1);
    const existing = existingRows[0] as TaskDocumentRow | undefined;

    assertTaskDocumentPreconditions(
      { projectId, taskId, key: input.key },
      { expectedRevision: input.expectedRevision, expectedContentHash: input.expectedContentHash },
      existing ? { revision: existing.revision, content: existing.content } : null,
    );

    if (existing) {
      // Archive the previous revision.
      await tx.insert(schema.project.taskDocumentRevisions).values({
        projectId,
        taskId,
        key: input.key,
        content: existing.content,
        revision: existing.revision,
        author: existing.author,
        metadata: existing.metadata ?? null,
        createdAt: now,
      });

      // Update the current document.
      await tx
        .update(schema.project.taskDocuments)
        .set({
          content: input.content,
          revision: existing.revision + 1,
          author,
          metadata: input.metadata ?? null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.project.taskDocuments.projectId, projectId),
            eq(schema.project.taskDocuments.taskId, taskId),
            eq(schema.project.taskDocuments.key, input.key),
          ),
        );
    } else {
      // Insert a new document.
      await tx.insert(schema.project.taskDocuments).values({
        projectId,
        id: randomUUID(),
        taskId,
        key: input.key,
        content: input.content,
        revision: 1,
        author,
        metadata: input.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Read back the upserted document.
    const rows = await tx
      .select()
      .from(schema.project.taskDocuments)
      .where(
        and(
          eq(schema.project.taskDocuments.projectId, projectId),
          eq(schema.project.taskDocuments.taskId, taskId),
          eq(schema.project.taskDocuments.key, input.key),
        ),
      )
      .limit(1);
    const row = rows[0] as TaskDocumentRow | undefined;
    if (!row) {
      throw new Error(`Failed to upsert document ${input.key} for task ${taskId}`);
    }
    return rowToTaskDocument(row);
  });
}

/**
 * FNXC:ArchivedTaskDocumentPublication 2026-07-20-15:36:
 * This is the sole PostgreSQL mutation allowed for a retained archived document. It locks the project-scoped parent and current document, requires the tombstone and cold archive snapshot to agree, checks both FX-004 CAS values before writing, archives the exact prior current row, and appends a fixed two-newline boundary plus caller bytes. Audit commits in the same transaction and stores no correction or reason prose. No task, archive, mission, citation, event, or scheduler row is touched.
 */
export async function publishArchivedTaskDocumentAddition(
  layer: AsyncDataLayer,
  taskId: string,
  input: ArchivedTaskDocumentAdditionInput,
  archivedColumns?: ReadonlySet<string>,
): Promise<ArchivedTaskDocumentAdditionResult> {
  validateArchivedTaskDocumentAddition(input);
  return layer.transactionImmediate(async (tx) => {
    const projectId = projectPartition(layer.projectId);
    const taskRows = await tx
      .select({ column: schema.project.tasks.column, deletedAt: schema.project.tasks.deletedAt })
      .from(schema.project.tasks)
      .where(and(
        eq(schema.project.tasks.projectId, projectId),
        eq(schema.project.tasks.id, taskId),
      ))
      .limit(1)
      .for("update");
    const task = taskRows[0];
    if (!task) {
      throw new ArchivedTaskDocumentPublicationRejectedError("parent-not-found", projectId, taskId, input.key);
    }
    if (!isArchivedLane(task.column, archivedColumns) && task.deletedAt == null) {
      throw new ArchivedTaskDocumentPublicationRejectedError("parent-not-archived", projectId, taskId, input.key);
    }

    const archiveRows = await tx
      .select({ id: schema.archive.archivedTasks.id })
      .from(schema.archive.archivedTasks)
      .where(and(
        eq(schema.archive.archivedTasks.projectId, projectId),
        eq(schema.archive.archivedTasks.id, taskId),
      ))
      .limit(1)
      .for("key share");
    if (!isArchivedLane(task.column, archivedColumns) || task.deletedAt == null || !archiveRows[0]) {
      throw new ArchivedTaskDocumentPublicationRejectedError("archived-state-inconsistent", projectId, taskId, input.key);
    }

    const existingRows = await tx
      .select()
      .from(schema.project.taskDocuments)
      .where(and(
        eq(schema.project.taskDocuments.projectId, projectId),
        eq(schema.project.taskDocuments.taskId, taskId),
        eq(schema.project.taskDocuments.key, input.key),
      ))
      .limit(1)
      .for("update");
    const existing = existingRows[0] as TaskDocumentRow | undefined;
    if (!existing) {
      throw new ArchivedTaskDocumentPublicationRejectedError("document-not-found", projectId, taskId, input.key);
    }

    assertTaskDocumentPreconditions(
      { projectId, taskId, key: input.key },
      { expectedRevision: input.expectedRevision, expectedContentHash: input.expectedContentHash },
      { revision: existing.revision, content: existing.content },
    );

    const now = new Date().toISOString();
    const content = existing.content + ARCHIVED_TASK_DOCUMENT_ADDITION_BOUNDARY + input.appendContent;
    const nextRevision = existing.revision + 1;
    await tx.insert(schema.project.taskDocumentRevisions).values({
      projectId,
      taskId,
      key: input.key,
      content: existing.content,
      revision: existing.revision,
      author: existing.author,
      metadata: existing.metadata ?? null,
      createdAt: now,
    });
    await tx
      .update(schema.project.taskDocuments)
      .set({ content, revision: nextRevision, author: input.author, updatedAt: now })
      .where(and(
        eq(schema.project.taskDocuments.projectId, projectId),
        eq(schema.project.taskDocuments.taskId, taskId),
        eq(schema.project.taskDocuments.key, input.key),
      ));
    await recordRunAuditEventWithinTransaction(tx, {
      taskId,
      agentId: input.author,
      runId: `archived-document-publication:${randomUUID()}`,
      domain: "database",
      mutationType: "task-document:archived-addition-published",
      target: `${taskId}:${input.key}`,
      metadata: {
        projectId,
        key: input.key,
        previousRevision: existing.revision,
        revision: nextRevision,
        reasonProvided: true,
        outcome: "published",
      },
    });

    const rows = await tx
      .select()
      .from(schema.project.taskDocuments)
      .where(and(
        eq(schema.project.taskDocuments.projectId, projectId),
        eq(schema.project.taskDocuments.taskId, taskId),
        eq(schema.project.taskDocuments.key, input.key),
      ))
      .limit(1);
    const row = rows[0] as TaskDocumentRow | undefined;
    if (!row) throw new Error(`Failed to publish archived document addition for ${taskId}/${input.key}`);
    return {
      document: rowToTaskDocument(row),
      previousRevision: existing.revision,
      previousContentHash: taskDocumentContentHash(existing.content),
      appendedContentHash: taskDocumentContentHash(content),
    };
  });
}

/**
 * List all documents for a LIVE parent task (archived/soft-deleted parents
 * return an empty list). This is the async equivalent of the sync
 * `hasActiveTask`-gated document list.
 */
export async function listTaskDocuments(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
  projectId?: string,

  archivedColumns?: ReadonlySet<string>,): Promise<TaskDocument[]> {
  const column = await getLiveTaskColumn(db, taskId, projectId, archivedColumns);
  /*
  FNXC:LifecycleColumnCensus 2026-07-30-21:10 DELIBERATE-LITERAL: a SENTINEL, not a board lane.
  
  This compares `getLiveTaskColumn`'s RETURN VALUE. That helper normalizes: it manufactures the string
  "archived" for an archived row AND for a soft-deleted one, and returns null for a missing task —
  which is why the neighbouring line tests null separately. It is a protocol value, not a column id.
  
  STILL TRUE NOW THAT THE HELPER RESOLVES LANES. `getLiveTaskColumn` now takes the board's archived
  lanes, which was the one genuinely-owed conversion this family pointed at (#2820). That changes which
  rows it CLASSIFIES as archived; it does not change the SENTINEL it returns, which still collapses
  archived and soft-deleted into one string. Converting this comparison would therefore keep passing on
  the built-in board and start FAILING on a renamed one — a soft-deleted task would read as not-archived.
  */
  if (column === null || column === "archived") return [];

  const rows = await db
    .select()
    .from(schema.project.taskDocuments)
    .where(and(
      eq(schema.project.taskDocuments.projectId, projectPartition(projectId)),
      eq(schema.project.taskDocuments.taskId, taskId),
    ));
  return (rows as TaskDocumentRow[]).map((row) => rowToTaskDocument(row));
}

/**
 * List archived revisions for a task document, newest first. Direct history
 * reads include retained archived parents while missing parents remain empty.
 */
export async function getTaskDocumentRevisions(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
  key: string,
  projectId?: string,

  archivedColumns?: ReadonlySet<string>,): Promise<TaskDocumentRevisionRow[]> {
  const column = await getLiveTaskColumn(db, taskId, projectId, archivedColumns);
  if (column === null) return [];

  const rows = await db
    .select()
    .from(schema.project.taskDocumentRevisions)
    .where(
      and(
        eq(schema.project.taskDocumentRevisions.projectId, projectPartition(projectId)),
        eq(schema.project.taskDocumentRevisions.taskId, taskId),
        eq(schema.project.taskDocumentRevisions.key, key),
      ),
    )
    .orderBy(desc(schema.project.taskDocumentRevisions.createdAt));
  return rows as unknown as TaskDocumentRevisionRow[];
}

/**
 * FNXC:PostgresCutover 2026-07-04:
 * Delete a task document and all of its archived revisions. This is the async
 * equivalent of the sync `deleteTaskDocument`: it verifies the document exists
 * (throwing the same "not found" error otherwise), then removes the revisions
 * and the document row inside a single transaction so a partial delete can
 * never leave orphaned revisions. Archived-task documents are retained for
 * restore and remain read-only, so deletion uses the same parent-state gate as
 * upsert.
 *
 * @param layer The async data layer (the delete runs in its own transaction).
 * @param taskId The parent task id.
 * @param key The document key.
 */
export async function deleteTaskDocument(
  layer: AsyncDataLayer,
  taskId: string,
  key: string,

  archivedColumns?: ReadonlySet<string>,): Promise<void> {
  return layer.transactionImmediate(async (tx) => {
    const state = await getLiveTaskColumn(tx, taskId, layer.projectId, archivedColumns);
    /*
    FNXC:LifecycleColumnCensus 2026-07-30-21:10 DELIBERATE-LITERAL: a SENTINEL, not a board lane.
    
    This compares `getLiveTaskColumn`'s RETURN VALUE. That helper normalizes: it manufactures the string
    "archived" for an archived row AND for a soft-deleted one, and returns null for a missing task —
    which is why the neighbouring line tests null separately. It is a protocol value, not a column id.
    
    STILL TRUE NOW THAT THE HELPER RESOLVES LANES. `getLiveTaskColumn` now takes the board's archived
    lanes, which was the one genuinely-owed conversion this family pointed at (#2820). That changes which
    rows it CLASSIFIES as archived; it does not change the SENTINEL it returns, which still collapses
    archived and soft-deleted into one string. Converting this comparison would therefore keep passing on
    the built-in board and start FAILING on a renamed one — a soft-deleted task would read as not-archived.
    */
    if (state === "archived") throw new Error(`Task ${taskId} is archived — documents are read-only`);
    if (state === null) throw new Error(`Task ${taskId} not found`);
    const existing = await tx
      .select({ id: schema.project.taskDocuments.id })
      .from(schema.project.taskDocuments)
      .where(
        and(
          eq(schema.project.taskDocuments.taskId, taskId),
          eq(schema.project.taskDocuments.key, key),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`Document ${key} not found for task ${taskId}`);
    }

    await tx
      .delete(schema.project.taskDocumentRevisions)
      .where(
        and(
          eq(schema.project.taskDocumentRevisions.taskId, taskId),
          eq(schema.project.taskDocumentRevisions.key, key),
        ),
      );
    await tx
      .delete(schema.project.taskDocuments)
      .where(
        and(
          eq(schema.project.taskDocuments.taskId, taskId),
          eq(schema.project.taskDocuments.key, key),
        ),
      );
  });
}

// ── Artifacts ────────────────────────────────────────────────────────

/**
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-09:50:
 * Insert an artifact row. The binary payload is written to disk by the caller
 * (the store's artifact-registry path); this helper only persists the metadata
 * row. The upsert is rejected against archived tasks (the gate mirrors
 * `upsertTaskDocument`). This is the async equivalent of `insertArtifactRow`.
 *
 * @param layer The async data layer (the insert runs in its own transaction
 *   so the row insert and any cleanup-on-failure are consistent).
 * @param input The artifact create input.
 * @param stored The stored-binary metadata (uri, sizeBytes) from the caller's
 *   disk-write step.
 * @returns The registered artifact.
 */
export async function insertArtifactRow(
  layer: AsyncDataLayer,
  input: ArtifactCreateInput,
  stored: { uri?: string; sizeBytes?: number },

  archivedColumns?: ReadonlySet<string>,): Promise<Artifact> {
  return layer.transactionImmediate(async (tx) => {
    // Gate: if taskId is set, the parent must be live.
    if (input.taskId) {
      const column = await getLiveTaskColumn(tx, input.taskId, layer.projectId, archivedColumns);
      /*
      FNXC:LifecycleColumnCensus 2026-07-30-21:10 DELIBERATE-LITERAL: a SENTINEL, not a board lane.
      
      This compares `getLiveTaskColumn`'s RETURN VALUE. That helper normalizes: it manufactures the string
      "archived" for an archived row AND for a soft-deleted one, and returns null for a missing task —
      which is why the neighbouring line tests null separately. It is a protocol value, not a column id.
      
      STILL TRUE NOW THAT THE HELPER RESOLVES LANES. `getLiveTaskColumn` now takes the board's archived
      lanes, which was the one genuinely-owed conversion this family pointed at (#2820). That changes which
      rows it CLASSIFIES as archived; it does not change the SENTINEL it returns, which still collapses
      archived and soft-deleted into one string. Converting this comparison would therefore keep passing on
      the built-in board and start FAILING on a renamed one — a soft-deleted task would read as not-archived.
      */
      if (column === "archived") {
        throw new Error(`Task ${input.taskId} is archived — artifacts are read-only`);
      }
      if (column === null) {
        throw new Error(`Task ${input.taskId} not found`);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    await tx.insert(schema.project.artifacts).values({
      id,
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      mimeType: input.mimeType ?? null,
      sizeBytes: stored.sizeBytes ?? input.sizeBytes ?? null,
      uri: stored.uri ?? input.uri ?? null,
      content: input.data ? null : input.content ?? null,
      authorId: input.authorId,
      authorType: input.authorType,
      taskId: input.taskId ?? null,
      metadata: input.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const rows = await tx
      .select()
      .from(schema.project.artifacts)
      .where(and(
        eq(schema.project.artifacts.id, id),
        projectScopeFor(schema.project.artifacts.projectId, layer.projectId),
      ))
      .limit(1);
    const row = rows[0] as ArtifactRow | undefined;
    if (!row) throw new Error(`Failed to register artifact ${id}`);
    return rowToArtifact(row);
  });
}

/**
 * FNXC:ArtifactRegistry 2026-07-11 (merge port from main):
 * In-place edit of an inline-content artifact (title/description/content).
 * Binary artifacts (rows with a uri) keep content non-editable; archived-task
 * artifacts stay read-only, mirroring insertArtifactRow's gate. Runs in a
 * transaction so the read-validate-write cycle is consistent.
 */
export async function updateArtifactRow(
  layer: AsyncDataLayer,
  id: string,
  updates: { title?: string; description?: string; content?: string },

  archivedColumns?: ReadonlySet<string>,): Promise<Artifact> {
  return layer.transactionImmediate(async (tx) => {
    const existing = await getArtifact(tx, id, layer.projectId);
    if (!existing) {
      throw new Error(`Artifact ${id} not found`);
    }
    if (existing.taskId) {
      const column = await getLiveTaskColumn(tx, existing.taskId, layer.projectId, archivedColumns);
      /*
      FNXC:LifecycleColumnCensus 2026-07-30-21:10 DELIBERATE-LITERAL: a SENTINEL, not a board lane.
      
      This compares `getLiveTaskColumn`'s RETURN VALUE. That helper normalizes: it manufactures the string
      "archived" for an archived row AND for a soft-deleted one, and returns null for a missing task —
      which is why the neighbouring line tests null separately. It is a protocol value, not a column id.
      
      STILL TRUE NOW THAT THE HELPER RESOLVES LANES. `getLiveTaskColumn` now takes the board's archived
      lanes, which was the one genuinely-owed conversion this family pointed at (#2820). That changes which
      rows it CLASSIFIES as archived; it does not change the SENTINEL it returns, which still collapses
      archived and soft-deleted into one string. Converting this comparison would therefore keep passing on
      the built-in board and start FAILING on a renamed one — a soft-deleted task would read as not-archived.
      */
      if (column === "archived") {
        throw new Error(`Task ${existing.taskId} is archived — artifacts are read-only`);
      }
      if (column === null) throw new Error(`Task ${existing.taskId} not found`);
    }
    if (updates.content !== undefined && existing.uri) {
      throw new Error(`Artifact ${id} stores a binary payload; its content is not editable`);
    }

    const now = new Date().toISOString();
    await tx
      .update(schema.project.artifacts)
      .set({
        title: updates.title !== undefined ? updates.title : existing.title,
        description: updates.description !== undefined ? updates.description : existing.description ?? null,
        content: updates.content !== undefined ? updates.content : existing.content ?? null,
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.artifacts.id, id),
        projectScopeFor(schema.project.artifacts.projectId, layer.projectId),
      ));

    const updated = await getArtifact(tx, id, layer.projectId);
    if (!updated) {
      throw new Error(`Failed to update artifact ${id}`);
    }
    return updated;
  });
}

/**
 * Read an artifact by id (metadata-only; does not read the binary payload).
 * Returns `null` if not found.
 */
export async function getArtifact(
  db: AsyncDataLayer["db"] | DbTransaction,
  id: string,
  projectId?: string,
): Promise<Artifact | null> {
  const rows = await db
    .select()
    .from(schema.project.artifacts)
    .where(and(
      eq(schema.project.artifacts.id, id),
      projectScopeFor(schema.project.artifacts.projectId, projectId),
    ))
    .limit(1);
  const row = rows[0] as ArtifactRow | undefined;
  return row ? rowToArtifact(row) : null;
}

/**
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-09:55:
 * List artifacts for a LIVE parent task, newest-first. Artifacts scoped to an
 * archived or soft-deleted task are NOT surfaced (they are retained for
 * restore but hidden from live views). This is the async equivalent of
 * `getArtifacts`.
 */
export async function getArtifacts(
  db: AsyncDataLayer["db"] | DbTransaction,
  taskId: string,
  projectId?: string,

  archivedColumns?: ReadonlySet<string>,): Promise<Artifact[]> {
  const column = await getLiveTaskColumn(db, taskId, projectId, archivedColumns);
  /*
  FNXC:LifecycleColumnCensus 2026-07-30-21:10 DELIBERATE-LITERAL: a SENTINEL, not a board lane.
  
  This compares `getLiveTaskColumn`'s RETURN VALUE. That helper normalizes: it manufactures the string
  "archived" for an archived row AND for a soft-deleted one, and returns null for a missing task —
  which is why the neighbouring line tests null separately. It is a protocol value, not a column id.
  
  STILL TRUE NOW THAT THE HELPER RESOLVES LANES. `getLiveTaskColumn` now takes the board's archived
  lanes, which was the one genuinely-owed conversion this family pointed at (#2820). That changes which
  rows it CLASSIFIES as archived; it does not change the SENTINEL it returns, which still collapses
  archived and soft-deleted into one string. Converting this comparison would therefore keep passing on
  the built-in board and start FAILING on a renamed one — a soft-deleted task would read as not-archived.
  */
  if (column === null || column === "archived") return [];

  const rows = await db
    .select()
    .from(schema.project.artifacts)
    .where(and(
      eq(schema.project.artifacts.taskId, taskId),
      projectScopeFor(schema.project.artifacts.projectId, projectId),
    ))
    .orderBy(desc(schema.project.artifacts.createdAt));
  return (rows as ArtifactRow[]).map((row) => rowToArtifact(row));
}

/**
 * FNXC:TaskStoreCommentsAttachments 2026-06-24-10:00:
 * FNXC:Artifacts 2026-06-27-12:00:
 * Cross-agent registry query: filter artifacts across tasks, authors, and
 * media types. This is the async equivalent of the sync `listArtifactsImpl`
 * (branch-group-ops.ts) and backs the dashboard `/api/artifacts` list in PG
 * backend mode (previously the sync `store.db` path 500'd).
 *
 * A LEFT JOIN to `tasks` keeps task-less registry artifacts visible while
 * excluding artifacts whose parent task is soft-deleted, and surfaces the
 * parent task's title/description/column (the `ArtifactWithTask` shape). Parity
 * with the sync query: it filters only on `deletedAt IS NULL` (mirroring
 * `TaskStore.ACTIVE_TASKS_WHERE`), so artifacts on archived-but-not-deleted
 * tasks remain visible — a LEFT JOIN miss leaves `deletedAt` NULL and is kept,
 * matching the sync `a.taskId IS NULL OR t.deletedAt IS NULL`.
 *
 * The query is metadata-only (does not select `content`) so large inline
 * payloads are not loaded on list paths. `search` matches title/description
 * (case-insensitive ILIKE), mirroring the sync filter.
 */
export async function listArtifacts(
  db: AsyncDataLayer["db"] | DbTransaction,
  options?: {
    type?: string;
    authorId?: string;
    taskId?: string;
    limit?: number;
    offset?: number;
    search?: string;
  },
  projectId?: string,
): Promise<ArtifactWithTask[]> {
  const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
  const offset = Math.max(0, options?.offset ?? 0);

  const conditions = [projectScopeFor(schema.project.artifacts.projectId, projectId)];
  if (options?.type) {
    conditions.push(eq(schema.project.artifacts.type, options.type));
  }
  if (options?.authorId) {
    conditions.push(eq(schema.project.artifacts.authorId, options.authorId));
  }
  if (options?.taskId) {
    conditions.push(eq(schema.project.artifacts.taskId, options.taskId));
  }
  // Live-parent filter: task-less artifacts (LEFT JOIN miss => deletedAt NULL)
  // and artifacts whose parent task is not soft-deleted are included.
  conditions.push(isNull(schema.project.tasks.deletedAt));
  if (options?.search && options.search.trim() !== "") {
    const query = `%${options.search.trim()}%`;
    conditions.push(
      or(
        ilike(schema.project.artifacts.title, query),
        ilike(schema.project.artifacts.description, query),
      )!,
    );
  }

  // Select metadata-only (no content column) plus the joined task fields.
  const rows = await db
    .select({
      id: schema.project.artifacts.id,
      type: schema.project.artifacts.type,
      title: schema.project.artifacts.title,
      description: schema.project.artifacts.description,
      mimeType: schema.project.artifacts.mimeType,
      sizeBytes: schema.project.artifacts.sizeBytes,
      uri: schema.project.artifacts.uri,
      authorId: schema.project.artifacts.authorId,
      authorType: schema.project.artifacts.authorType,
      taskId: schema.project.artifacts.taskId,
      metadata: schema.project.artifacts.metadata,
      createdAt: schema.project.artifacts.createdAt,
      updatedAt: schema.project.artifacts.updatedAt,
      taskTitle: schema.project.tasks.title,
      taskDescription: schema.project.tasks.description,
      taskColumn: schema.project.tasks.column,
    })
    .from(schema.project.artifacts)
    .leftJoin(
      schema.project.tasks,
      and(
        eq(schema.project.artifacts.taskId, schema.project.tasks.id),
        eq(schema.project.artifacts.projectId, schema.project.tasks.projectId),
      ),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.project.artifacts.createdAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => {
    const artifact = rowToArtifact(row as unknown as ArtifactRow);
    return {
      ...artifact,
      ...(row.taskTitle != null ? { taskTitle: row.taskTitle } : {}),
      ...(row.taskDescription != null ? { taskDescription: row.taskDescription } : {}),
      ...(row.taskColumn != null ? { taskColumn: row.taskColumn } : {}),
    };
  });
}

/**
 * FNXC:Documents 2026-06-27-12:05:
 * Cross-task document registry query backing the dashboard `/api/documents`
 * list in PG backend mode (previously the sync `store.db` JOIN 500'd). Async
 * equivalent of the sync `getAllDocumentsImpl` (workflow-task-create-ops.ts): INNER JOIN
 * `task_documents` to `tasks`, filtered to live (non-soft-deleted) parent tasks
 * (`ACTIVE_TASK_FILTER` mirrors `TaskStore.ACTIVE_TASKS_WHERE`), newest-updated
 * first, returning the `TaskDocumentWithTask` shape (doc + joined task
 * title/description/column). `searchQuery` matches the document key/content or
 * the task title (case-insensitive ILIKE), mirroring the sync filter.
 */
export async function getAllDocuments(
  db: AsyncDataLayer["db"] | DbTransaction,
  options?: { searchQuery?: string; limit?: number; offset?: number },
): Promise<TaskDocumentWithTask[]> {
  const limit = Math.min(Math.max(1, options?.limit ?? 200), 1000);
  const offset = Math.max(0, options?.offset ?? 0);

  const conditions = [ACTIVE_TASK_FILTER];
  if (options?.searchQuery && options.searchQuery.trim() !== "") {
    const query = `%${options.searchQuery.trim()}%`;
    conditions.push(
      or(
        ilike(schema.project.taskDocuments.key, query),
        ilike(schema.project.taskDocuments.content, query),
        ilike(schema.project.tasks.title, query),
      )!,
    );
  }

  const rows = await db
    .select({
      id: schema.project.taskDocuments.id,
      taskId: schema.project.taskDocuments.taskId,
      key: schema.project.taskDocuments.key,
      content: schema.project.taskDocuments.content,
      revision: schema.project.taskDocuments.revision,
      author: schema.project.taskDocuments.author,
      metadata: schema.project.taskDocuments.metadata,
      createdAt: schema.project.taskDocuments.createdAt,
      updatedAt: schema.project.taskDocuments.updatedAt,
      taskTitle: schema.project.tasks.title,
      taskDescription: schema.project.tasks.description,
      taskColumn: schema.project.tasks.column,
    })
    .from(schema.project.taskDocuments)
    .innerJoin(
      schema.project.tasks,
      eq(schema.project.taskDocuments.taskId, schema.project.tasks.id),
    )
    .where(and(...conditions))
    .orderBy(desc(schema.project.taskDocuments.updatedAt))
    .limit(limit)
    .offset(offset);

  return rows.map((row) => {
    const doc = rowToTaskDocument(row as unknown as TaskDocumentRow);
    return {
      ...doc,
      ...(row.taskTitle != null ? { taskTitle: row.taskTitle } : {}),
      taskDescription: row.taskDescription,
      taskColumn: row.taskColumn,
    };
  });
}
