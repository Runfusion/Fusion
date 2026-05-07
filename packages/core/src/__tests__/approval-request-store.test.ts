import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "../db.js";
import { ApprovalRequestStore } from "../approval-request-store.js";
import {
  APPROVAL_REQUEST_AUDIT_EVENT_TYPES,
  APPROVAL_REQUEST_STATUSES,
  AGENT_PERMISSION_POLICY_ACTION_CATEGORIES,
  isValidApprovalRequestTransition,
  type ApprovalRequest,
  type ApprovalRequestActorSnapshot,
} from "../types.js";

const REQUESTER: ApprovalRequestActorSnapshot = {
  actorId: "agent-1",
  actorType: "agent",
  actorName: "Executor",
};

const APPROVER: ApprovalRequestActorSnapshot = {
  actorId: "user:dashboard",
  actorType: "user",
  actorName: "Dashboard User",
};

describe("approval request domain contract", () => {
  it("exposes stable v1 status and audit-event vocabularies", () => {
    expect(APPROVAL_REQUEST_STATUSES).toEqual(["pending", "approved", "denied", "completed"]);
    expect(APPROVAL_REQUEST_AUDIT_EVENT_TYPES).toEqual(["created", "approved", "denied", "completed"]);
  });

  it("reuses shared action-category vocabulary for target actions", () => {
    expect(AGENT_PERMISSION_POLICY_ACTION_CATEGORIES.length).toBeGreaterThan(0);
  });

  it("enforces the lifecycle transition matrix", () => {
    expect(isValidApprovalRequestTransition("pending", "approved")).toBe(true);
    expect(isValidApprovalRequestTransition("pending", "denied")).toBe(true);
    expect(isValidApprovalRequestTransition("approved", "completed")).toBe(true);
    expect(isValidApprovalRequestTransition("pending", "completed")).toBe(false);
    expect(isValidApprovalRequestTransition("approved", "denied")).toBe(false);
    expect(isValidApprovalRequestTransition("denied", "approved")).toBe(false);
    expect(isValidApprovalRequestTransition("denied", "completed")).toBe(false);
    expect(isValidApprovalRequestTransition("completed", "approved")).toBe(false);
  });

  it("captures immutable actor snapshots and target-action context", () => {
    const request: ApprovalRequest = {
      id: "apr-001",
      status: "pending",
      requester: REQUESTER,
      targetAction: {
        category: AGENT_PERMISSION_POLICY_ACTION_CATEGORIES[0],
        action: "git commit",
        summary: "Create commit for task changes",
        resourceType: "repository",
        resourceId: "kb",
        context: { taskId: "FN-3546" },
      },
      taskId: "FN-3546",
      runId: "run-1",
      requestedAt: "2026-05-05T00:00:00.000Z",
      createdAt: "2026-05-05T00:00:00.000Z",
      updatedAt: "2026-05-05T00:00:00.000Z",
    };

    expect(request.requester.actorName).toBe("Executor");
    expect(request.targetAction.context).toEqual({ taskId: "FN-3546" });
  });
});

describe("ApprovalRequestStore", () => {
  let tempDir: string;
  let db: Database;
  let store: ApprovalRequestStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "kb-approval-request-test-"));
    db = new Database(tempDir, { inMemory: true });
    db.init();
    store = new ApprovalRequestStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createSampleRequest(taskId = "FN-3546") {
    return store.create({
      requester: REQUESTER,
      targetAction: {
        category: AGENT_PERMISSION_POLICY_ACTION_CATEGORIES[0],
        action: "git commit",
        summary: "Commit current task changes",
        resourceType: "repository",
        resourceId: "kb",
        context: { branch: "fn/fn-3546" },
      },
      taskId,
      runId: "run-abc",
    });
  }

  it("creates request rows with full actor and target action payload", () => {
    const created = createSampleRequest();
    const fetched = store.get(created.id);

    expect(fetched).toBeTruthy();
    expect(fetched?.status).toBe("pending");
    expect(fetched?.requester).toEqual(REQUESTER);
    expect(fetched?.targetAction.context).toEqual({ branch: "fn/fn-3546" });
    expect(fetched?.taskId).toBe("FN-3546");
    expect(fetched?.runId).toBe("run-abc");
  });

  it("supports pending -> approved and approved -> completed with audit trail", () => {
    const created = createSampleRequest();
    const approved = store.decide(created.id, "approved", { actor: APPROVER, note: "Looks good" });
    const completed = store.markCompleted(created.id, { actor: REQUESTER, note: "Action executed" });

    expect(approved.status).toBe("approved");
    expect(approved.decidedAt).toBeTruthy();
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBeTruthy();

    const history = store.getAuditHistory(created.id);
    expect(history.map((e) => e.eventType)).toEqual(["created", "approved", "completed"]);
    expect(history[1]?.note).toBe("Looks good");
  });

  it("supports pending -> denied", () => {
    const created = createSampleRequest();
    const denied = store.decide(created.id, "denied", { actor: APPROVER, note: "Not allowed" });

    expect(denied.status).toBe("denied");
    expect(denied.decidedAt).toBeTruthy();
    expect(store.getAuditHistory(created.id).map((e) => e.eventType)).toEqual(["created", "denied"]);
  });

  it("rejects invalid transitions", () => {
    const created = createSampleRequest();

    expect(() => store.markCompleted(created.id, { actor: REQUESTER })).toThrow(
      "Invalid approval request transition: pending -> completed",
    );

    store.decide(created.id, "approved", { actor: APPROVER });
    expect(() => store.decide(created.id, "denied", { actor: APPROVER })).toThrow(
      "Invalid approval request transition: approved -> denied",
    );
  });

  it("lists and filters approval requests", () => {
    const first = createSampleRequest("FN-100");
    const second = createSampleRequest("FN-200");
    store.decide(second.id, "approved", { actor: APPROVER });

    const pending = store.list({ status: "pending" });
    const approved = store.list({ status: "approved" });
    const byTask = store.list({ taskId: "FN-100" });

    expect(pending.map((r) => r.id)).toContain(first.id);
    expect(approved.map((r) => r.id)).toContain(second.id);
    expect(byTask.map((r) => r.id)).toEqual([first.id]);
  });

  it("persists requests and audit history across restart/migration", () => {
    db.close();

    const diskDir = mkdtempSync(join(tmpdir(), "kb-approval-request-disk-"));
    try {
      const dbA = new Database(diskDir);
      dbA.init();
      const storeA = new ApprovalRequestStore(dbA);
      const created = storeA.create({
        requester: REQUESTER,
        targetAction: {
          category: AGENT_PERMISSION_POLICY_ACTION_CATEGORIES[0],
          action: "git push",
          summary: "Push branch",
          resourceType: "branch",
          resourceId: "fn/fn-3546",
        },
      });
      storeA.decide(created.id, "approved", { actor: APPROVER });
      dbA.close();

      const dbB = new Database(diskDir);
      dbB.init();
      const storeB = new ApprovalRequestStore(dbB);

      const fetched = storeB.get(created.id);
      expect(fetched?.status).toBe("approved");
      expect(storeB.getAuditHistory(created.id).map((e) => e.eventType)).toEqual(["created", "approved"]);
      dbB.close();
    } finally {
      rmSync(diskDir, { recursive: true, force: true });
    }

    db = new Database(tempDir, { inMemory: true });
    db.init();
    store = new ApprovalRequestStore(db);
  });
});
