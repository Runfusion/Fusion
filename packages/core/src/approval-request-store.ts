import { randomUUID } from "node:crypto";
import type { Database } from "./db.js";
import { fromJson, toJsonNullable } from "./db.js";
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
} from "./types.js";

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
  targetContext: string | null;
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

export class ApprovalRequestStore {
  constructor(private db: Database) {}

  private rowToRequest(row: ApprovalRequestRow): ApprovalRequest {
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
        context: fromJson<Record<string, unknown>>(row.targetContext),
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

  private rowToAuditEvent(row: ApprovalRequestAuditEventRow): ApprovalRequestAuditEvent {
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

  private appendAuditEvent(
    requestId: string,
    eventType: ApprovalRequestAuditEventType,
    actor: ApprovalRequestActorSnapshot,
    createdAt: string,
    note?: string,
  ): ApprovalRequestAuditEvent {
    const event: ApprovalRequestAuditEvent = {
      id: `aprevt-${randomUUID().slice(0, 8)}`,
      requestId,
      eventType,
      actor,
      ...(note !== undefined ? { note } : {}),
      createdAt,
    };

    this.db.prepare(`
      INSERT INTO approval_request_audit_events (id, requestId, eventType, actorId, actorType, actorName, note, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.requestId,
      event.eventType,
      event.actor.actorId,
      event.actor.actorType,
      event.actor.actorName,
      event.note ?? null,
      event.createdAt,
    );

    return event;
  }

  create(input: ApprovalRequestCreateInput): ApprovalRequest {
    const now = new Date().toISOString();
    const request: ApprovalRequest = {
      id: `apr-${randomUUID().slice(0, 8)}`,
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

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO approval_requests (
          id, status,
          requesterActorId, requesterActorType, requesterActorName,
          targetActionCategory, targetActionOperation, targetActionSummary,
          targetResourceType, targetResourceId, targetContext,
          taskId, runId,
          requestedAt, decidedAt, completedAt,
          createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        request.id,
        request.status,
        request.requester.actorId,
        request.requester.actorType,
        request.requester.actorName,
        request.targetAction.category,
        request.targetAction.action,
        request.targetAction.summary,
        request.targetAction.resourceType,
        request.targetAction.resourceId,
        toJsonNullable(request.targetAction.context),
        request.taskId ?? null,
        request.runId ?? null,
        request.requestedAt,
        null,
        null,
        request.createdAt,
        request.updatedAt,
      );
      this.appendAuditEvent(request.id, "created", input.requester, now);
    });

    this.db.bumpLastModified();
    return request;
  }

  get(id: string): ApprovalRequest | null {
    const row = this.db.prepare(`SELECT * FROM approval_requests WHERE id = ?`).get(id) as ApprovalRequestRow | undefined;
    return row ? this.rowToRequest(row) : null;
  }

  list(input: ApprovalRequestListInput = {}): ApprovalRequest[] {
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (input.status) {
      where.push("status = ?");
      params.push(input.status);
    }
    if (input.requesterActorId) {
      where.push("requesterActorId = ?");
      params.push(input.requesterActorId);
    }
    if (input.taskId) {
      where.push("taskId = ?");
      params.push(input.taskId);
    }
    if (input.runId) {
      where.push("runId = ?");
      params.push(input.runId);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = input.limit ?? 100;
    const offset = input.offset ?? 0;
    const rows = this.db.prepare(`
      SELECT * FROM approval_requests
      ${whereSql}
      ORDER BY createdAt DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ApprovalRequestRow[];

    return rows.map((row) => this.rowToRequest(row));
  }

  getPendingCountsByActor(): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT requesterActorId AS actorId, COUNT(*) AS requestCount
      FROM approval_requests
      WHERE status = 'pending'
      GROUP BY requesterActorId
    `).all() as Array<{ actorId: string; requestCount: number }>;

    return new Map(rows.map((row) => [row.actorId, Number(row.requestCount)]));
  }

  findLatestByDedupeKey(input: { requesterActorId: string; taskId?: string; dedupeKey: string }): ApprovalRequest | null {
    const where = ["requesterActorId = ?"];
    const params: Array<string> = [input.requesterActorId];

    if (input.taskId !== undefined) {
      where.push("taskId = ?");
      params.push(input.taskId);
    }

    const rows = this.db.prepare(`
      SELECT * FROM approval_requests
      WHERE ${where.join(" AND ")}
      ORDER BY createdAt DESC, id DESC
    `).all(...params) as ApprovalRequestRow[];

    for (const row of rows) {
      const context = fromJson<Record<string, unknown>>(row.targetContext);
      if (context?.approvalDedupeKey === input.dedupeKey) {
        return this.rowToRequest(row);
      }
    }

    return null;
  }

  decide(requestId: string, status: "approved" | "denied", input: ApprovalRequestDecisionInput): ApprovalRequest {
    const existing = this.get(requestId);
    if (!existing) {
      throw new Error(`Approval request ${requestId} not found`);
    }
    if (!isValidApprovalRequestTransition(existing.status, status)) {
      throw new Error(`Invalid approval request transition: ${existing.status} -> ${status}`);
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE approval_requests
        SET status = ?, decidedAt = ?, updatedAt = ?
        WHERE id = ?
      `).run(status, now, now, requestId);
      this.appendAuditEvent(requestId, status, input.actor, now, input.note);
    });

    this.db.bumpLastModified();
    const updated = this.get(requestId);
    if (!updated) {
      throw new Error(`Approval request ${requestId} not found after update`);
    }
    return updated;
  }

  markCompleted(requestId: string, input: ApprovalRequestCompletionInput): ApprovalRequest {
    const existing = this.get(requestId);
    if (!existing) {
      throw new Error(`Approval request ${requestId} not found`);
    }
    if (!isValidApprovalRequestTransition(existing.status, "completed")) {
      throw new Error(`Invalid approval request transition: ${existing.status} -> completed`);
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE approval_requests
        SET status = 'completed', completedAt = ?, updatedAt = ?
        WHERE id = ?
      `).run(now, now, requestId);
      this.appendAuditEvent(requestId, "completed", input.actor, now, input.note);
    });

    this.db.bumpLastModified();
    const updated = this.get(requestId);
    if (!updated) {
      throw new Error(`Approval request ${requestId} not found after completion`);
    }
    return updated;
  }

  getAuditHistory(requestId: string): ApprovalRequestAuditEvent[] {
    const rows = this.db.prepare(`
      SELECT * FROM approval_request_audit_events
      WHERE requestId = ?
      ORDER BY createdAt ASC, rowid ASC
    `).all(requestId) as ApprovalRequestAuditEventRow[];

    return rows.map((row) => this.rowToAuditEvent(row));
  }
}
