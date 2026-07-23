/**
 * Async Drizzle ApprovalRequestStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:ApprovalRequestStore 2026-06-24-07:30:
 * Async equivalents of the sync SQLite ApprovalRequestStore call sites in
 * approval-request-store.ts. These helpers target the PostgreSQL
 * `project.approval_requests` and `project.approval_request_audit_events`
 * tables via Drizzle.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   The `targetContext` column is jsonb in PostgreSQL, so Drizzle returns it
 *   already-parsed as a JS value. The audit-event insert and the status update
 *   run in a single transaction so the audit row commits/rolls back atomically
 *   with the state transition (matching the sync transactionImmediate pattern).
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   flip. These helpers are the async target the PostgreSQL integration tests
 *   consume.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "../postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "../postgres/data-layer.js";
import {
  isValidApprovalRequestTransition,
  normalizeApprovalRequestActionCategory,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
  type ApprovalRequestAuditEvent,
  type ApprovalRequestAuditEventType,
  type ApprovalRequestCompletionInput,
  type ApprovalRequestCreateInput,
  type ApprovalRequestDecisionInput,
  type ApprovalRequestListInput,
  type ApprovalRequestStatus,
} from "../types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

interface ApprovalRequestRow {
  id: string;
  status: ApprovalRequestStatus;
  requesterActorId: string;
  requesterActorType: ApprovalRequestActorSnapshot["actorType"];
  requesterActorName: string;
  targetActionCategory: string;
  targetActionOperation: string;
  targetActionSummary: string;
  targetResourceType: string;
  targetResourceId: string;
  targetContext: Record<string, unknown> | null;
  taskId: string | null;
  runId: string | null;
  requestedAt: string;
  decidedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ApprovalRequestAuditEventRow {
  id: string;
  requestId: string;
  eventType: ApprovalRequestAuditEventType;
  actorId: string;
  actorType: ApprovalRequestActorSnapshot["actorType"];
  actorName: string;
  note: string | null;
  createdAt: string;
}

function rowToRequest(row: ApprovalRequestRow): ApprovalRequest {
  return {
    id: row.id,
    status: row.status,
    requester: {
      actorId: row.requesterActorId,
      actorType: row.requesterActorType,
      actorName: row.requesterActorName,
    },
    targetAction: {
      category: normalizeApprovalRequestActionCategory(
        row.targetActionCategory as Parameters<typeof normalizeApprovalRequestActionCategory>[0],
      ),
      action: row.targetActionOperation,
      summary: row.targetActionSummary,
      resourceType: row.targetResourceType,
      resourceId: row.targetResourceId,
      context: row.targetContext ?? {},
    },
    taskId: row.taskId ?? undefined,
    runId: row.runId ?? undefined,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToAuditEvent(row: ApprovalRequestAuditEventRow): ApprovalRequestAuditEvent {
  return {
    id: row.id,
    requestId: row.requestId,
    eventType: row.eventType,
    actor: {
      actorId: row.actorId,
      actorType: row.actorType,
      actorName: row.actorName,
    },
    note: row.note ?? undefined,
    createdAt: row.createdAt,
  };
}

/**
 * Append an audit event row inside the given transaction handle.
 *
 * FNXC:ApprovalAnalyticsIsolation 2026-07-14-01:04:
 * Audit events must carry the bound layer's project ID at write time because request IDs alone do not provide a reliable tenant ownership join for Command Center intervention analytics.
 */
async function appendAuditEvent(
  tx: DbTransaction,
  projectId: string,
  requestId: string,
  eventType: ApprovalRequestAuditEventType,
  actor: ApprovalRequestActorSnapshot,
  createdAt: string,
  note?: string,
): Promise<ApprovalRequestAuditEvent> {
  const id = `aprevt-${eventType}-${requestId}-${createdAt}`;
  const event: ApprovalRequestAuditEvent = {
    id,
    requestId,
    eventType,
    actor,
    ...(note !== undefined ? { note } : {}),
    createdAt,
  };
  await tx.insert(schema.project.approvalRequestAuditEvents).values({
    projectId,
    id,
    requestId,
    eventType,
    actorId: actor.actorId,
    actorType: actor.actorType,
    actorName: actor.actorName,
    note: note ?? null,
    createdAt,
  });
  return event;
}

/**
 * FNXC:ApprovalRequestStore 2026-06-24-07:35:
 * Create an approval request + audit event atomically. The request insert and
 * the "created" audit event run in a single transaction so they commit/rollback
 * together.
 */
export async function createApprovalRequest(
  layer: AsyncDataLayer,
  input: ApprovalRequestCreateInput & { id: string },
): Promise<ApprovalRequest> {
  const now = new Date().toISOString();
  const projectId = layer.projectId ?? "";
  const request: ApprovalRequest = {
    id: input.id,
    status: "pending",
    requester: input.requester,
    targetAction: {
      ...input.targetAction,
      category: normalizeApprovalRequestActionCategory(input.targetAction.category),
    },
    taskId: input.taskId,
    runId: input.runId,
    requestedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  await layer.transactionImmediate(async (tx) => {
    await tx.insert(schema.project.approvalRequests).values({
      id: request.id,
      status: request.status,
      requesterActorId: request.requester.actorId,
      requesterActorType: request.requester.actorType,
      requesterActorName: request.requester.actorName,
      targetActionCategory: request.targetAction.category,
      targetActionOperation: request.targetAction.action,
      targetActionSummary: request.targetAction.summary,
      targetResourceType: request.targetAction.resourceType,
      targetResourceId: request.targetAction.resourceId,
      targetContext: request.targetAction.context,
      taskId: request.taskId ?? null,
      runId: request.runId ?? null,
      requestedAt: request.requestedAt,
      decidedAt: null,
      completedAt: null,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    });
    await appendAuditEvent(tx, projectId, request.id, "created", input.requester, now);
  });
  return request;
}

/**
 * Get a single approval request by id.
 */
export async function getApprovalRequest(
  handle: QueryHandle,
  id: string,
): Promise<ApprovalRequest | null> {
  const rows = await handle
    .select()
    .from(schema.project.approvalRequests)
    .where(eq(schema.project.approvalRequests.id, id));
  return rows[0] ? rowToRequest(rows[0] as ApprovalRequestRow) : null;
}

/**
 * FNXC:ApprovalRequestStore 2026-06-24-07:40:
 * List approval requests with optional filters. Ordered by createdAt DESC.
 */
export async function listApprovalRequests(
  handle: QueryHandle,
  input: ApprovalRequestListInput = {},
): Promise<ApprovalRequest[]> {
  const conditions: ReturnType<typeof eq>[] = [];
  if (input.status) conditions.push(eq(schema.project.approvalRequests.status, input.status));
  if (input.requesterActorId) conditions.push(eq(schema.project.approvalRequests.requesterActorId, input.requesterActorId));
  if (input.taskId) conditions.push(eq(schema.project.approvalRequests.taskId, input.taskId));
  if (input.runId) conditions.push(eq(schema.project.approvalRequests.runId, input.runId));
  const limit = input.limit ?? 100;
  const offset = input.offset ?? 0;
  const query = handle
    .select()
    .from(schema.project.approvalRequests)
    .orderBy(desc(schema.project.approvalRequests.createdAt), desc(schema.project.approvalRequests.id))
    .limit(limit)
    .offset(offset);
  const rows = conditions.length > 0 ? await query.where(and(...conditions)) : await query;
  return rows.map((row) => rowToRequest(row as ApprovalRequestRow));
}

/**
 * FNXC:ApprovalRequestStore 2026-06-24-07:45:
 * Decide (approve/deny) an approval request. The status update and the audit
 * event run in a single transaction. Throws on invalid transition.
 */
export async function decideApprovalRequest(
  layer: AsyncDataLayer,
  requestId: string,
  status: "approved" | "denied",
  input: ApprovalRequestDecisionInput,
): Promise<ApprovalRequest> {
  const existing = await getApprovalRequest(layer.db, requestId);
  if (!existing) throw new Error(`Approval request ${requestId} not found`);
  if (!isValidApprovalRequestTransition(existing.status, status)) {
    throw new Error(`Invalid approval request transition: ${existing.status} -> ${status}`);
  }
  const now = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    await tx
      .update(schema.project.approvalRequests)
      .set({ status, decidedAt: now, updatedAt: now })
      .where(eq(schema.project.approvalRequests.id, requestId));
    await appendAuditEvent(tx, layer.projectId ?? "", requestId, status, input.actor, now, input.note);
  });
  return (await getApprovalRequest(layer.db, requestId))!;
}

/**
 * Mark an approval request as completed. The status update and the audit
 * event run in a single transaction. Throws on invalid transition.
 */
export async function markApprovalRequestCompleted(
  layer: AsyncDataLayer,
  requestId: string,
  input: ApprovalRequestCompletionInput,
): Promise<ApprovalRequest> {
  const existing = await getApprovalRequest(layer.db, requestId);
  if (!existing) throw new Error(`Approval request ${requestId} not found`);
  if (!isValidApprovalRequestTransition(existing.status, "completed")) {
    throw new Error(`Invalid approval request transition: ${existing.status} -> completed`);
  }
  const now = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    await tx
      .update(schema.project.approvalRequests)
      .set({ status: "completed", completedAt: now, updatedAt: now })
      .where(eq(schema.project.approvalRequests.id, requestId));
    await appendAuditEvent(tx, layer.projectId ?? "", requestId, "completed", input.actor, now, input.note);
  });
  return (await getApprovalRequest(layer.db, requestId))!;
}

/**
 * Get the audit history for a request, ordered by createdAt ASC.
 */
export async function getApprovalAuditHistory(
  handle: QueryHandle,
  requestId: string,
): Promise<ApprovalRequestAuditEvent[]> {
  const rows = await handle
    .select()
    .from(schema.project.approvalRequestAuditEvents)
    .where(eq(schema.project.approvalRequestAuditEvents.requestId, requestId))
    .orderBy(
      sql`${schema.project.approvalRequestAuditEvents.createdAt} ASC, ${schema.project.approvalRequestAuditEvents.id} ASC`,
    );
  return rows.map((row) => rowToAuditEvent(row as ApprovalRequestAuditEventRow));
}
