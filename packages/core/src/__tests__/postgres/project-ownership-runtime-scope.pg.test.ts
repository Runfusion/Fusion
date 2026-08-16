import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../__test-utils__/pg-test-harness.js";
import type { AsyncDataLayer } from "../../postgres/data-layer.js";
import * as schema from "../../postgres/schema/index.js";
import {
  decideApprovalRequest,
  getApprovalRequest,
  listApprovalRequests,
} from "../../async-stores/async-approval-request-store.js";
import { getChatMessage, getChatMessages } from "../../async-stores/async-chat-store.js";
import { getSecretMetadata, listSecrets } from "../../async-stores/async-secrets-store.js";
import { aggregatePluginActivations } from "../../plugins/plugin-activation-analytics.js";
import { getArtifact, listArtifacts, updateArtifactRow } from "../../task-store/async/async-comments-attachments.js";
import { queryRunAuditEvents } from "../../task-store/async/async-audit.js";
import { getBranchGroup, listBranchGroups, updateBranchGroup } from "../../task-store/async/async-branch-groups.js";
import { TaskStore } from "../../store.js";

pgDescribe("project ownership runtime scope", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_project_ownership_runtime_scope",
  });
  /*
  FNXC:MultiProjectIsolation 2026-08-15-22:10:
  Real wall-clock, not a literal: `decideApprovalRequest` rejects a pending request older than
  APPROVAL_REQUEST_PENDING_TTL_MS against Date.now(), so a hardcoded seed date expired the day
  after this file was written and turned the whole isolation case into a time bomb.
  */
  const now = new Date().toISOString();
  const bind = (projectId: string): AsyncDataLayer => ({ ...h.layer(), projectId });

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);

  it("isolates all drifted project tables for bound callers while preserving unbound reads", async () => {
    /*
    FNXC:MultiProjectIsolation 2026-08-12-14:15:
    FN-9000 requires QueryHandle helpers to accept a trailing optional projectId while layer helpers read layer.projectId. Owner-connected PostgreSQL bypasses RLS, so this two-project fixture makes every runtime predicate load-bearing: bound reads and mutations must keep the colliding foreign row untouched, while empty-string and undefined callers retain deliberate unbound compatibility.
    */
    const a = bind("ownership-a");
    const b = bind("ownership-b");
    const unbound = { ...h.layer(), projectId: undefined };
    const empty = { ...h.layer(), projectId: "" };

    // Seed the physical composite-key shape directly so every public read sees a colliding natural identity.
    await h.adminDb().insert(schema.project.artifacts).values([
      { projectId: a.projectId!, id: "art-1", type: "document", title: "Artifact A", authorId: "owner", authorType: "agent", createdAt: now, updatedAt: now },
      { projectId: b.projectId!, id: "art-1", type: "document", title: "Artifact B", authorId: "owner", authorType: "agent", createdAt: now, updatedAt: now },
    ]);
    await h.adminDb().insert(schema.project.secrets).values([
      { projectId: a.projectId!, id: "sec-1", key: "SHARED_SECRET", valueCiphertext: Buffer.from([1]), nonce: Buffer.from([1]), createdAt: now, updatedAt: now },
      { projectId: b.projectId!, id: "sec-1", key: "SHARED_SECRET", valueCiphertext: Buffer.from([2]), nonce: Buffer.from([2]), createdAt: now, updatedAt: now },
    ]);
    await h.adminDb().insert(schema.project.branchGroups).values([
      { projectId: a.projectId!, id: "bg-1", sourceType: "planning", sourceId: "shared-source", branchName: "feature/shared", createdAt: 1, updatedAt: 1 },
      { projectId: b.projectId!, id: "bg-1", sourceType: "planning", sourceId: "shared-source", branchName: "feature/shared", createdAt: 1, updatedAt: 1 },
    ]);
    await h.adminDb().insert(schema.project.pluginActivations).values([
      { projectId: a.projectId!, pluginId: "plugin-shared", source: "test", activatedAt: now },
      { projectId: b.projectId!, pluginId: "plugin-shared", source: "test", activatedAt: now },
    ]);
    /*
    FNXC:ChatProjectIsolation 2026-08-12-14:15:
    Keep the parent only in A: a message predicate alone would still expose B's
    colliding message, while the mandatory parent-session predicate rejects it.
    */
    await h.adminDb().insert(schema.project.chatSessions).values({
      id: "sess-1", agentId: "agent", projectId: a.projectId!, createdAt: now, updatedAt: now,
    });
    await h.adminDb().insert(schema.project.chatMessages).values([
      { projectId: a.projectId!, id: "msg-1", sessionId: "sess-1", role: "user", content: "Message A", createdAt: now },
      { projectId: b.projectId!, id: "msg-1", sessionId: "sess-1", role: "user", content: "Message B", createdAt: now },
    ]);
    await h.adminDb().insert(schema.project.runAuditEvents).values([
      { projectId: a.projectId!, id: "rae-older", timestamp: "2026-08-12T14:13:00.000Z", agentId: "agent", runId: "run-shared", domain: "test", mutationType: "shared", target: "A older" },
      { projectId: a.projectId!, id: "rae-1", timestamp: "2026-08-12T14:14:00.000Z", agentId: "agent", runId: "run-shared", domain: "test", mutationType: "shared", target: "A newest" },
      { projectId: b.projectId!, id: "rae-1", timestamp: "2026-08-12T14:16:00.000Z", agentId: "agent", runId: "run-shared", domain: "test", mutationType: "shared", target: "B newest" },
    ]);
    await h.adminDb().insert(schema.project.verificationCache).values([
      { projectId: a.projectId!, treeSha: "tree-shared", testCommand: "test", buildCommand: "build", recordedAt: now, taskId: "cache-a" },
      { projectId: b.projectId!, treeSha: "tree-shared", testCommand: "test", buildCommand: "build", recordedAt: now, taskId: "cache-b" },
    ]);
    await h.adminDb().insert(schema.project.approvalRequests).values([
      { projectId: a.projectId!, id: "ar-1", status: "pending", requesterActorId: "agent", requesterActorType: "agent", requesterActorName: "Agent A", targetActionCategory: "test", targetActionOperation: "shared", targetActionSummary: "A", targetResourceType: "task", targetResourceId: "shared", requestedAt: now, createdAt: now, updatedAt: now },
      { projectId: b.projectId!, id: "ar-1", status: "pending", requesterActorId: "agent", requesterActorType: "agent", requesterActorName: "Agent B", targetActionCategory: "test", targetActionOperation: "shared", targetActionSummary: "B", targetResourceType: "task", targetResourceId: "shared", requestedAt: now, createdAt: now, updatedAt: now },
    ]);

    // Cast only bridges Step 1's pre-threading signatures; the runtime calls intentionally carry the future trailing projectId.
    const artifact = getArtifact as unknown as (db: typeof a.db, id: string, projectId?: string) => ReturnType<typeof getArtifact>;
    const updateArtifact = updateArtifactRow as unknown as (layer: AsyncDataLayer, id: string, patch: { title?: string }, projectId?: string) => ReturnType<typeof updateArtifactRow>;
    const artifacts = listArtifacts as unknown as (db: typeof a.db, options: { authorId: string }, projectId?: string) => ReturnType<typeof listArtifacts>;
    const secret = getSecretMetadata as unknown as (db: typeof a.db, id: string, scope: "project", projectId?: string) => ReturnType<typeof getSecretMetadata>;
    const secrets = listSecrets as unknown as (db: typeof a.db, scope: "project", projectId?: string) => ReturnType<typeof listSecrets>;
    const branch = getBranchGroup as unknown as (db: typeof a.db, id: string, projectId?: string) => ReturnType<typeof getBranchGroup>;
    const branches = listBranchGroups as unknown as (db: typeof a.db, options: undefined, projectId?: string) => ReturnType<typeof listBranchGroups>;
    const updateBranch = updateBranchGroup as unknown as (db: typeof a.db, id: string, patch: { status: "finalized" }, projectId?: string) => ReturnType<typeof updateBranchGroup>;
    const chatMessage = getChatMessage as unknown as (db: typeof a.db, id: string, projectId?: string) => ReturnType<typeof getChatMessage>;
    const chatMessages = getChatMessages as unknown as (db: typeof a.db, sessionId: string, filter: undefined, projectId?: string) => ReturnType<typeof getChatMessages>;
    const audits = queryRunAuditEvents as unknown as (db: typeof a.db, filter: { runId: string; limit?: number }, projectId?: string) => ReturnType<typeof queryRunAuditEvents>;
    const approvals = getApprovalRequest as unknown as (db: typeof a.db, id: string, projectId?: string) => ReturnType<typeof getApprovalRequest>;
    const approvalList = listApprovalRequests as unknown as (db: typeof a.db, input: object, projectId?: string) => ReturnType<typeof listApprovalRequests>;

    expect((await artifact(a.db, "art-1", a.projectId))?.title).toBe("Artifact A");
    await updateArtifact(a, "art-1", { title: "Artifact A updated" }, a.projectId);
    expect((await h.adminDb().select({ title: schema.project.artifacts.title }).from(schema.project.artifacts).where(and(eq(schema.project.artifacts.projectId, b.projectId!), eq(schema.project.artifacts.id, "art-1"))))[0]?.title).toBe("Artifact B");
    expect((await artifacts(a.db, { authorId: "owner" }, a.projectId)).map((row) => row.id)).toEqual(["art-1"]);
    expect((await artifacts(unbound.db, { authorId: "owner" }, unbound.projectId)).map((row) => row.id)).toHaveLength(2);

    expect((await secret(a.db, "sec-1", "project", a.projectId))?.key).toBe("SHARED_SECRET");
    expect((await secrets(a.db, "project", a.projectId)).map((row) => row.id)).toEqual(["sec-1"]);
    expect((await secrets(empty.db, "project", empty.projectId)).map((row) => row.id)).toHaveLength(2);

    expect((await branch(a.db, "bg-1", a.projectId))?.branchName).toBe("feature/shared");
    await updateBranch(a.db, "bg-1", { status: "finalized" }, a.projectId);
    expect((await h.adminDb().select({ status: schema.project.branchGroups.status }).from(schema.project.branchGroups).where(and(eq(schema.project.branchGroups.projectId, b.projectId!), eq(schema.project.branchGroups.id, "bg-1"))))[0]?.status).toBe("open");
    expect((await branches(a.db, undefined, a.projectId)).map((row) => row.id)).toEqual(["bg-1"]);
    expect((await branches(unbound.db, undefined, unbound.projectId)).map((row) => row.id)).toHaveLength(2);

    expect((await chatMessage(a.db, "msg-1", a.projectId))?.content).toBe("Message A");
    expect((await chatMessages(a.db, "sess-1", undefined, a.projectId)).map((row) => row.content)).toEqual(["Message A"]);
    expect((await chatMessages(empty.db, "sess-1", undefined, empty.projectId)).map((row) => row.content)).toEqual(["Message A", "Message B"]);

    expect((await audits(a.db, { runId: "run-shared", limit: 1 }, a.projectId)).map((row) => row.target)).toEqual(["A newest"]);
    expect((await audits(unbound.db, { runId: "run-shared" }, unbound.projectId)).map((row) => row.target)).toHaveLength(3);

    expect((await aggregatePluginActivations(a)).activations).toBe(1);
    expect((await aggregatePluginActivations(bind("ownership-empty"))).unavailable).toBe(true);
    expect((await aggregatePluginActivations(unbound)).activations).toBe(2);

    expect((await approvals(a.db, "ar-1", a.projectId))?.requester.actorName).toBe("Agent A");
    await decideApprovalRequest(a, "ar-1", "approved", { actor: { actorId: "operator", actorType: "user", actorName: "Operator" } });
    expect((await approvals(b.db, "ar-1", b.projectId))?.status).toBe("pending");
    expect((await approvalList(a.db, {}, a.projectId)).map((row) => row.id)).toEqual(["ar-1"]);
    expect((await approvalList(unbound.db, {}, unbound.projectId)).map((row) => row.id)).toHaveLength(2);

    const storeA = new TaskStore(h.rootDir(), undefined, { asyncLayer: a });
    const storeB = new TaskStore(h.rootDir(), undefined, { asyncLayer: b });
    /*
    FNXC:BranchGroupProjectIsolation 2026-08-12-14:30:
    TaskStore wrappers are the load-bearing production path: helper-only coverage would not catch a missing layer.projectId argument at this boundary.
    */
    expect((await storeA.getBranchGroup("bg-1"))?.sourceId).toBe("shared-source");
    expect((await storeA.getBranchGroupBySource("planning", "shared-source"))?.id).toBe("bg-1");
    expect((await storeA.getBranchGroupByBranchName("feature/shared"))?.id).toBe("bg-1");
    expect((await storeA.listBranchGroups()).map((row) => row.id)).toEqual(["bg-1"]);
    await storeA.updateBranchGroup("bg-1", { branchName: "feature/a-runtime" });
    expect((await storeB.getBranchGroup("bg-1"))?.branchName).toBe("feature/shared");
    expect((await storeA.ensureBranchGroupForSource("planning", "shared-source", { branchName: "feature/a-runtime" })).id).toBe("bg-1");
    expect((await storeA.getVerificationCacheHit("tree-shared", "test", "build"))?.taskId).toBe("cache-a");
    expect((await storeB.getVerificationCacheHit("tree-shared", "test", "build"))?.taskId).toBe("cache-b");
    expect((await storeB.getVerificationCacheHit("tree-shared", "test", "build"))?.taskId).toBe("cache-b");
    expect(await h.adminDb().select({ taskId: schema.project.verificationCache.taskId }).from(schema.project.verificationCache).where(eq(schema.project.verificationCache.treeSha, "tree-shared"))).toHaveLength(2);

  });
});
