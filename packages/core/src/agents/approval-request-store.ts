import { randomUUID } from "node:crypto";
import { count, eq, desc, and } from "drizzle-orm";
import type { Database } from "../db/db.js";
import { fromJson } from "../db/db.js";
import type { AsyncDataLayer } from "../postgres/data-layer.js";
import * as asyncApprovalRequestStore from "../async-stores/async-approval-request-store.js";
import * as schema from "../postgres/schema/index.js";
import { appendAgentActivityEvent } from "../task-store/async/async-agent-activity.js";
import { resolveAgentActivityAttribution } from "../task-store/agent-activity-outbox.js";
import {
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
  /**
   * FNXC:ApprovalRequestStore 2026-06-24-21:15:
   * When non-null, the store is in backend (PostgreSQL) mode and all data
   * access delegates to the async helpers. The sync db is unused in this mode.
   */
  private readonly asyncLayer: AsyncDataLayer | null;

  constructor(
    private db: Database | null,
    options?: { asyncLayer?: AsyncDataLayer | null },
  ) {
    this.asyncLayer = options?.asyncLayer ?? null;
  }

  /** True when the store is backed by PostgreSQL (AsyncDataLayer present). */
  private get backendMode(): boolean {
    return this.asyncLayer !== null;
  }

  /**
   * FNXC:ApprovalRequestStore 2026-06-24-21:20:
   * Asserts the sync SQLite database is available. In backend mode this is
   * never called (the async branch returns first); in SQLite mode the db is
   * always provided at construction.
   */
  private syncDb(): Database {
    if (!this.db) {
      throw new Error("ApprovalRequestStore: sync Database is null (backend mode requires asyncLayer)");
    }
    return this.db;
  }

  /*
  FNXC:ApprovalRedemption 2026-07-26-16:40:
  In backend (PostgreSQL) mode `targetContext` is a jsonb column that Drizzle
  returns ALREADY PARSED, while legacy rows may still store a JSON string.
  Feeding the parsed object through the string-only `fromJson` made
  `findLatestByDedupeKey` never match in PG mode, so every gate retry minted a
  duplicate approval request and approved-grant reuse silently never worked in
  production. Normalize both shapes here.

  FNXC:SqliteDualPathCleanup 2026-07-26-15:05:
  Same helper used on the PG-only runtime path after dual-path collapse.
  */
  private static normalizeTargetContext(value: unknown): Record<string, unknown> | undefined {
    if (value === null || value === undefined) return undefined;
    if (typeof value === "string") return fromJson<Record<string, unknown>>(value);
    if (typeof value === "object") return value as Record<string, unknown>;
    return undefined;
  }

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
        context: ApprovalRequestStore.normalizeTargetContext(row.targetContext),
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

    this.syncDb().prepare(`
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

  async create(input: ApprovalRequestCreateInput): Promise<ApprovalRequest> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-27-06:15:
    Dual-path collapse left a local ApprovalRequest construction that was discarded
    while a second random id was generated for the PG insert. Use one id and let
    createApprovalRequest materialize the full row.
    */
    const id = `apr-${randomUUID().slice(0, 8)}`;
    const created = await asyncApprovalRequestStore.createApprovalRequest(this.asyncLayer!, { ...input, id });
    // FNXC:AgentActivityStream 2026-08-09-12:59: Record the observed registered tool identifier when the producer supplies one; the closed schema rewrites plugin or unknown values to `unlisted` without persisting arguments or prose.
    if (input.requester.actorId) try {
      const context = input.targetAction.context;
      const toolName = typeof context?.toolName === "string"
        ? context.toolName
        : typeof context?.tool === "string"
          ? context.tool
          : input.targetAction.action;
      await appendAgentActivityEvent(this.asyncLayer!, { type: "approval:requested", attributionClaim: resolveAgentActivityAttribution([{ id: input.requester.actorId, provenance: "roster" }], "executor"), taskId: input.taskId, occurredAt: created.requestedAt, discriminator: id, metadata: { requestId: id, category: input.targetAction.category, toolName } });
    } catch { /* monitoring must not break approval creation */ }
    return created;
}

  async get(id: string): Promise<ApprovalRequest | null> {
        return asyncApprovalRequestStore.getApprovalRequest(this.asyncLayer!.db, id);
}

  async list(input: ApprovalRequestListInput = {}): Promise<ApprovalRequest[]> {
        return asyncApprovalRequestStore.listApprovalRequests(this.asyncLayer!.db, input);
}

  async getPendingCountsByActor(): Promise<Map<string, number>> {
        const table = schema.project.approvalRequests;
    const rows = await this.asyncLayer!.db
      .select({
        actorId: table.requesterActorId,
        requestCount: count(),
      })
      .from(table)
      .where(eq(table.status, "pending"))
      .groupBy(table.requesterActorId);
    return new Map(rows.map((row) => [row.actorId, Number(row.requestCount)]));
}

  async findLatestByDedupeKey(input: { requesterActorId: string; taskId?: string; dedupeKey: string }): Promise<ApprovalRequest | null> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-15:05:
    Production path is PostgreSQL-only. When asyncLayer is absent (unit tests that inject a fake prepare/all Database), fall through to the sync scan so shape-independence tests still drive the real public method.
    */
    if (this.backendMode) {
      const table = schema.project.approvalRequests;
      const conditions = [eq(table.requesterActorId, input.requesterActorId)];
      if (input.taskId !== undefined) {
        conditions.push(eq(table.taskId, input.taskId));
      }
      const rows = await this.asyncLayer!.db
        .select()
        .from(table)
        .where(and(...conditions))
        .orderBy(desc(table.createdAt), desc(table.id));
      for (const row of rows as ApprovalRequestRow[]) {
        // FNXC:ApprovalRedemption 2026-07-26-16:40: jsonb rows arrive parsed; see normalizeTargetContext.
        const context = ApprovalRequestStore.normalizeTargetContext(row.targetContext);
        if (context?.approvalDedupeKey === input.dedupeKey) {
          return this.rowToRequest(row);
        }
      }
      return null;
    }

    const where = ["requesterActorId = ?"];
    const params: Array<string> = [input.requesterActorId];
    if (input.taskId !== undefined) {
      where.push("taskId = ?");
      params.push(input.taskId);
    }

    const rows = this.syncDb().prepare(`
      SELECT * FROM approval_requests
      WHERE ${where.join(" AND ")}
      ORDER BY createdAt DESC, id DESC
    `).all(...params) as ApprovalRequestRow[];

    for (const row of rows) {
      const context = ApprovalRequestStore.normalizeTargetContext(row.targetContext);
      if (context?.approvalDedupeKey === input.dedupeKey) {
        return this.rowToRequest(row);
      }
    }
    return null;
}

  async decide(requestId: string, status: "approved" | "denied", input: ApprovalRequestDecisionInput): Promise<ApprovalRequest> {
        return asyncApprovalRequestStore.decideApprovalRequest(this.asyncLayer!, requestId, status, input);
}

  async markCompleted(requestId: string, input: ApprovalRequestCompletionInput): Promise<ApprovalRequest> {
        return asyncApprovalRequestStore.markApprovalRequestCompleted(this.asyncLayer!, requestId, input);
}

  async getAuditHistory(requestId: string): Promise<ApprovalRequestAuditEvent[]> {
        return asyncApprovalRequestStore.getApprovalAuditHistory(this.asyncLayer!.db, requestId);
}
}
