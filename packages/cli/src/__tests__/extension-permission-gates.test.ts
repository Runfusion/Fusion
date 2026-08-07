/**
 * FNXC:ToolPermissionGates 2026-07-26-14:20:
 * Security-fix coverage for the host-extension tool permission gates. Root cause: all fn_*
 * extension tools are delivered into engine agent sessions via pi's extension loader and
 * never pass through the engine's gate wrappers, so destructive tools ran ungated for
 * agents (an agent deleted a live task). These tests prove BOTH directions:
 *  - Agent principals (explicit ctx.agentId or session-identity-registry cwd match) are
 *    hard-denied on the withheld list and policy-gated on the sensitive list.
 *  - Operator principals (no ctx.agentId, no registry entry) keep their exact prior
 *    behavior, and agents under the shipped default `unrestricted` preset stay
 *    friction-free on policy-gated tools (no approval row minted).
 * Expectations are HARDCODED — never derived from the constants under test.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import express from "express";
import { join } from "node:path";
import {
  AgentStore,
  ApprovalRequestStore,
  SecretsStore,
  registerFusionSessionIdentity,
  runWithFusionSessionIdentity,
  __clearFusionSessionIdentityRegistryForTests,
  type AgentPermissionPolicy,
} from "@fusion/core";
import {
  createPgExtensionHarness,
  createMockApi,
  registerExtension,
  requireTool,
  pgDescribe,
  type MockApi,
} from "./pg-extension-harness.js";
import { registerApprovalRoutes } from "../../../dashboard/src/routes/register-approval-routes.js";
import { request as requestRoute } from "../../../dashboard/src/test-request.js";
import { ChatManager, __resetChatState, __setCreateResolvedAgentSession } from "../../../dashboard/src/chat.js";

const { createPiAgentSessionMock, piFindModelMock } = vi.hoisted(() => ({
  createPiAgentSessionMock: vi.fn(),
  piFindModelMock: vi.fn((provider: string, id: string) => ({ provider, id })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  LegacyCredentialStorage: { create: () => ({ setFallbackResolver: vi.fn(), getApiKey: vi.fn(), get: vi.fn(), set: vi.fn(), has: vi.fn(), hasAuth: vi.fn(), getAll: vi.fn(() => ({})), list: vi.fn(), logout: vi.fn(), remove: vi.fn(), reload: vi.fn() }) },
  createAgentSession: createPiAgentSessionMock,
  createBashTool: vi.fn(() => ({ name: "bash" })),
  createCodingTools: vi.fn(() => []),
  createEditTool: () => ({ name: "edit" }),
  createExtensionRuntime: vi.fn(),
  createFindTool: () => ({ name: "find" }),
  createGrepTool: () => ({ name: "grep" }),
  createLsTool: () => ({ name: "ls" }),
  createReadOnlyTools: vi.fn(() => []),
  createReadTool: () => ({ name: "read" }),
  createWriteTool: () => ({ name: "write" }),
  DefaultResourceLoader: class { async reload() {} },
  DefaultPackageManager: class { async resolve() { return { extensions: [] }; } },
  discoverAndLoadExtensions: vi.fn(async () => ({ runtime: { pendingProviderRegistrations: [] }, errors: [] })),
  getAgentDir: () => "/mock-agent-dir",
  ModelRuntime: { create: async () => ({ getAuth: async () => ({ auth: { headers: {} } }), refresh: async () => {} }) },
  ModelRegistry: class { static create() { return new this(); } find(provider: string, id: string) { return piFindModelMock(provider, id); } getAll() { return []; } registerProvider() {} async refresh() {} async getApiKeyAndHeaders() { return { ok: true }; } },
  SessionManager: { inMemory: () => ({ getSessionId: () => undefined }) },
  SettingsManager: { create: () => ({}), inMemory: () => ({}) },
}));

const h = createPgExtensionHarness("fn-ext-perm-gates");

function buildApprovalStore(): ApprovalRequestStore {
  const layer = h.store().getAsyncLayer();
  if (!layer) throw new Error("harness store has no async layer");
  return new ApprovalRequestStore(null, { asyncLayer: layer });
}

async function buildAgentStore(): Promise<AgentStore> {
  const layer = h.store().getAsyncLayer();
  if (!layer) throw new Error("harness store has no async layer");
  const agentStore = new AgentStore({ rootDir: join(h.rootDir(), ".fusion"), asyncLayer: layer });
  await agentStore.init();
  return agentStore;
}

/**
 * FNXC:ToolPermissionGates 2026-07-26-14:20:
 * TaskStore.getSecretsStore constructs a MasterKeyManager against the real global dir,
 * which resolveGlobalDir hard-refuses under vitest. Pre-seed the store's public
 * `secretsStore` cache with a backend-mode SecretsStore using a fixed in-memory test key
 * so fn_secret_get exercises the real encrypt/reveal + approval paths without touching
 * ~/.fusion.
 */
function injectSecretsStore(): SecretsStore {
  const layer = h.store().getAsyncLayer();
  if (!layer) throw new Error("harness store has no async layer");
  const noopDb = {
    prepare: () => {
      throw new Error("sync DB not available in backend-mode test");
    },
    bumpLastModified: () => {},
  };
  const secretsStore = new SecretsStore(
    noopDb as never,
    noopDb as never,
    async () => Buffer.alloc(32, 7),
    { asyncLayer: layer },
  );
  h.store().secretsStore = secretsStore;
  return secretsStore;
}

/** Hardcoded full-rules policy literals (never derived from core preset constants). */
const LOCKED_DOWN_POLICY: AgentPermissionPolicy = {
  presetId: "locked-down",
  rules: {
    git_write: "block",
    file_write_delete: "block",
    command_execution: "block",
    network_api: "block",
    task_agent_mutation: "block",
    review_gate_bypass: "block",
    file_scope: "block",
  },
};

const APPROVAL_REQUIRED_POLICY: AgentPermissionPolicy = {
  presetId: "approval-required",
  rules: {
    git_write: "require-approval",
    file_write_delete: "require-approval",
    command_execution: "require-approval",
    network_api: "require-approval",
    task_agent_mutation: "require-approval",
    review_gate_bypass: "require-approval",
    file_scope: "require-approval",
  },
};

function freshApi(): MockApi {
  const api = createMockApi();
  registerExtension(api);
  return api;
}

/**
 * Build only the production approval registrar around the same PostgreSQL-backed
 * store used by the host extension. This keeps the reachability fixture in-process
 * while exercising the real HTTP decision authorization and persistence path.
 */
function createApprovalDecisionApp() {
  const app = express();
  const router = express.Router();
  app.use(express.json());
  registerApprovalRoutes({
    router,
    store: h.store(),
    runtimeLogger: { info() {}, warn() {}, error() {}, child() { return this; } } as any,
    planningLogger: {} as any,
    chatLogger: {} as any,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => h.store(),
    getProjectContext: async () => ({ store: h.store(), engine: undefined, projectId: undefined }),
    getProjectPluginLoader: async () => undefined,
    prioritizeProjectsForCurrentDirectory: (projects: any[]) => projects,
    emitRemoteRouteDiagnostic() {},
    emitAuthSyncAuditLog() {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => { throw new Error("not used by approval routes"); },
    resolveRoutineStore: () => { throw new Error("not used by approval routes"); },
    resolveRoutineRunner: () => { throw new Error("not used by approval routes"); },
    registerDispose() {},
    dispose() {},
    rethrowAsApiError(error: unknown): never { throw error; },
  } as any);
  app.use(router);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(typeof error?.status === "number" ? error.status : 500).json({ error: error?.message ?? "Internal server error" });
  });
  return app;
}

pgDescribe("extension tool permission gates", () => {
  beforeAll(h.beforeAll);
  beforeEach(async () => {
    await h.beforeEach();
    __clearFusionSessionIdentityRegistryForTests();
  });
  afterEach(async () => {
    __clearFusionSessionIdentityRegistryForTests();
    await h.afterEach();
  });
  afterAll(h.afterAll);

  // ── Withheld list ────────────────────────────────────────────────

  it("fn_task_delete: denied for agent principal (task untouched), allowed for operator", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_task_delete");
    const task = await h.store().createTask({ description: "withheld delete target" });

    const denied = await tool.execute("c1", { id: task.id }, undefined, undefined, { cwd, agentId: "agent-rogue" });
    expect(denied.isError).toBe(true);
    expect(denied.details?.deniedFor).toBe("agent-principal");
    expect(denied.details?.tool).toBe("fn_task_delete");
    expect(denied.details?.agentId).toBe("agent-rogue");
    expect(denied.content[0]?.text).toContain("withheld from agent sessions");

    // The store delete was never invoked: the task row is still live.
    const stillAlive = await h.store().getTask(task.id, { includeDeleted: true });
    expect(stillAlive.deletedAt ?? null).toBeNull();

    // Operator (no agentId, no registry entry) proceeds unchanged.
    const ok = await tool.execute("c2", { id: task.id }, undefined, undefined, { cwd });
    expect(ok.isError).toBeUndefined();
    expect(ok.content[0]?.text).toBe(`Deleted ${task.id}`);
    const deleted = await h.store().getTask(task.id, { includeDeleted: true });
    expect(deleted.deletedAt).toBeTruthy();
  });

  it("fn_task_delete: registry-registered session is denied without ctx.agentId; ambiguous fails closed", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_task_delete");
    const task = await h.store().createTask({ description: "registry-denied delete target" });

    const dispose = registerFusionSessionIdentity(cwd, { agentId: "agent-registered" });
    const denied = await tool.execute("c1", { id: task.id }, undefined, undefined, { cwd });
    expect(denied.isError).toBe(true);
    expect(denied.details?.deniedFor).toBe("agent-principal");
    expect(denied.details?.agentId).toBe("agent-registered");

    // Two live registrations for one cwd = ambiguous = still denied (fail closed), no agentId attributed.
    const dispose2 = registerFusionSessionIdentity(cwd, { agentId: "agent-second" });
    const ambiguous = await tool.execute("c2", { id: task.id }, undefined, undefined, { cwd });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.details?.deniedFor).toBe("agent-principal");
    expect(ambiguous.details?.agentId).toBeUndefined();

    dispose();
    dispose2();

    // After both sessions dispose, the same cwd is an operator again.
    const ok = await tool.execute("c3", { id: task.id }, undefined, undefined, { cwd });
    expect(ok.isError).toBeUndefined();
  });

  it("every withheld tool hard-denies an agent principal before doing any work", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    // Hardcoded tool/param pairs — params are irrelevant because the guard runs first.
    const calls: Array<[string, Record<string, unknown>]> = [
      ["fn_task_bypass_review", { id: "FN-1", reason: "nope" }],
      ["fn_mission_delete", { id: "M-1" }],
      ["fn_milestone_delete", { milestoneId: "MS-1" }],
      ["fn_slice_delete", { sliceId: "SL-1" }],
      ["fn_feature_delete", { featureId: "F-1" }],
      ["fn_workflow_delete", { workflow_id: "WF-1" }],
      ["fn_experiment_finalize", { sessionId: "EXP-1" }],
      ["fn_skills_install", { source: "owner/repo" }],
    ];
    for (const [name, params] of calls) {
      const tool = requireTool(api, name);
      const result = await tool.execute("c", params, undefined, undefined, { cwd, agentId: "agent-rogue" });
      expect(result.isError, `${name} should be withheld`).toBe(true);
      expect(result.details?.deniedFor, name).toBe("agent-principal");
      expect(result.details?.tool, name).toBe(name);
      expect(result.details?.agentId, name).toBe("agent-rogue");
    }
  });

  // ── Policy-gated list ────────────────────────────────────────────

  it("default (unrestricted) preset: agent fn_task_pause proceeds with NO approval row", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_task_pause");
    const agentStore = await buildAgentStore();
    const worker = await agentStore.createAgent({ name: "Default Worker", role: "executor" });
    const task = await h.store().createTask({ description: "default-policy pause target" });

    const result = await tool.execute("c1", { id: task.id }, undefined, undefined, { cwd, agentId: worker.id });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(`Paused ${task.id}`);
    const paused = await h.store().getTask(task.id);
    expect(paused.paused).toBe(true);

    // DEFAULT PRESET PATH must stay friction-free: no approval request was minted.
    const requests = await buildApprovalStore().list();
    expect(requests).toHaveLength(0);
  });

  it("locked-down agent policy blocks fn_task_pause", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_task_pause");
    const agentStore = await buildAgentStore();
    const locked = await agentStore.createAgent({
      name: "Locked Worker",
      role: "executor",
      permissionPolicy: LOCKED_DOWN_POLICY,
    });
    const task = await h.store().createTask({ description: "locked-down pause target" });

    const result = await tool.execute("c1", { id: task.id }, undefined, undefined, { cwd, agentId: locked.id });
    expect(result.isError).toBe(true);
    expect(result.details?.deniedFor).toBe("agent-permission-policy");
    expect(result.details?.disposition).toBe("block");
    expect(result.details?.agentId).toBe(locked.id);

    const untouched = await h.store().getTask(task.id);
    expect(untouched.paused ?? false).toBe(false);

    // Operator remains unaffected by the agent-row policy.
    const operatorResult = await tool.execute("c2", { id: task.id }, undefined, undefined, { cwd });
    expect(operatorResult.isError).toBeUndefined();
    expect(operatorResult.content[0]?.text).toBe(`Paused ${task.id}`);
  });

  it("approval-required policy: mints agent-attributed request, reuses pending, redeems approval once", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_task_pause");
    const agentStore = await buildAgentStore();
    const gatedAgent = await agentStore.createAgent({
      name: "Gated Worker",
      role: "executor",
      permissionPolicy: APPROVAL_REQUIRED_POLICY,
    });
    const task = await h.store().createTask({ description: "approval-required pause target" });
    const approvals = buildApprovalStore();

    const first = await tool.execute("c1", { id: task.id }, undefined, undefined, { cwd, agentId: gatedAgent.id });
    expect(first.isError).toBeUndefined();
    expect(first.details?.outcome).toBe("pending_approval");
    const requestId = first.details?.approvalRequestId as string;
    expect(requestId).toBeTruthy();

    const request = await approvals.get(requestId);
    expect(request?.status).toBe("pending");
    expect(request?.requester.actorType).toBe("agent");
    expect(request?.requester.actorId).toBe(gatedAgent.id);
    expect(request?.requester.actorName).toBe("Gated Worker");
    expect(request?.targetAction.category).toBe("task_agent_mutation");

    // Second call while pending reuses the same request — no duplicate row.
    const second = await tool.execute("c2", { id: task.id }, undefined, undefined, { cwd, agentId: gatedAgent.id });
    expect(second.details?.outcome).toBe("pending_approval");
    expect(second.details?.approvalRequestId).toBe(requestId);
    expect(await approvals.list()).toHaveLength(1);

    // Task was never paused while the request is pending.
    expect((await h.store().getTask(task.id)).paused ?? false).toBe(false);

    // Operator approves → the next call consumes the grant exactly once and proceeds.
    await approvals.decide(requestId, "approved", {
      actor: { actorId: "user", actorType: "user", actorName: "Operator" },
    });
    const third = await tool.execute("c3", { id: task.id }, undefined, undefined, { cwd, agentId: gatedAgent.id });
    expect(third.isError).toBeUndefined();
    expect(third.content[0]?.text).toBe(`Paused ${task.id}`);
    expect((await h.store().getTask(task.id)).paused).toBe(true);
    expect((await approvals.get(requestId))?.status).toBe("completed");

    // Grant is consumed: a fourth call mints a NEW pending request instead of re-running.
    const fourth = await tool.execute("c4", { id: task.id }, undefined, undefined, { cwd, agentId: gatedAgent.id });
    expect(fourth.details?.outcome).toBe("pending_approval");
    expect(fourth.details?.approvalRequestId).not.toBe(requestId);
  });

  // ── Provisioning caller honesty ──────────────────────────────────

  it("fn_agent_create: operator stays privileged and unchanged; agent caller takes the approval path with a real requester snapshot", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const createTool = requireTool(api, "fn_agent_create");
    const agentStore = await buildAgentStore();
    const boss = await agentStore.createAgent({ name: "Boss Agent", role: "executor" });

    // Operator behavior is hardcoded-unchanged: privileged caller, immediate create.
    const operatorResult = await createTool.execute(
      "c1",
      { name: "Operator Made", role: "executor" },
      undefined,
      undefined,
      { cwd },
    );
    expect(operatorResult.details?.outcome).toBe("created");
    expect(operatorResult.details?.matchedRule).toBe("privileged-caller");

    // Agent caller is NOT privileged: default trusted-only mode requires approval,
    // and the request is attributed to the real agent, not "CLI User".
    const agentResult = await createTool.execute(
      "c2",
      { name: "Agent Made", role: "executor" },
      undefined,
      undefined,
      { cwd, agentId: boss.id },
    );
    expect(agentResult.details?.outcome).toBe("pending_approval");
    expect(agentResult.details?.matchedRule).toBe("approval-mode-trusted-only");
    const request = await buildApprovalStore().get(agentResult.details?.approvalRequestId as string);
    expect(request?.requester.actorType).toBe("agent");
    expect(request?.requester.actorId).toBe(boss.id);
    expect(request?.requester.actorName).toBe("Boss Agent");
    expect(request?.targetAction.category).toBe("agent_provisioning");
  });

  it("fn_agent_delete: agent caller approval request carries the agent requester snapshot; operator delete-approval keeps CLI User", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const deleteTool = requireTool(api, "fn_agent_delete");
    const agentStore = await buildAgentStore();
    const boss = await agentStore.createAgent({ name: "Boss Agent", role: "executor" });
    const victim = await agentStore.createAgent({ name: "Victim Agent", role: "executor" });

    // Agent caller → non-privileged → alwaysApproveDelete default → approval with real snapshot.
    const agentResult = await deleteTool.execute(
      "c1",
      { agent_id: victim.id },
      undefined,
      undefined,
      { cwd, agentId: boss.id },
    );
    expect(agentResult.details?.outcome).toBe("pending_approval");
    const agentRequest = await buildApprovalStore().get(agentResult.details?.approvalRequestId as string);
    expect(agentRequest?.requester.actorType).toBe("agent");
    expect(agentRequest?.requester.actorId).toBe(boss.id);
    expect(agentRequest?.requester.actorName).toBe("Boss Agent");

    // Operator remains privileged and deletes immediately (hardcoded prior behavior).
    const operatorResult = await deleteTool.execute("c2", { agent_id: victim.id }, undefined, undefined, { cwd });
    expect(operatorResult.details?.outcome).toBe("deleted");
  });

  // ── fn_secret_get approval lifecycle ─────────────────────────────

  it("fn_secret_get: approved row is redeemed once (reveal + completed), then a fresh request is minted", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_secret_get");
    const secretsStore = injectSecretsStore();
    await secretsStore.createSecret({
      scope: "project",
      key: "API_TOKEN",
      plaintextValue: "s3cret-value",
      accessPolicy: "prompt",
    });
    const approvals = buildApprovalStore();
    const agentCtx = { cwd, agentId: "agent-secrets", agentName: "Secrets Agent" };

    // First call mints a pending request with the secrets_access category (dashboard audit hook contract).
    const first = await tool.execute("c1", { key: "API_TOKEN" }, undefined, undefined, agentCtx);
    expect(first.details?.outcome).toBe("pending_approval");
    const requestId = first.details?.approvalRequestId as string;
    const request = await approvals.get(requestId);
    expect(request?.targetAction.category).toBe("secrets_access");
    expect(request?.requester.actorId).toBe("agent-secrets");

    // While pending: no re-mint.
    const stillPending = await tool.execute("c2", { key: "API_TOKEN" }, undefined, undefined, agentCtx);
    expect(stillPending.details?.outcome).toBe("pending_approval");
    expect(stillPending.details?.approvalRequestId).toBe(requestId);
    expect(await approvals.list()).toHaveLength(1);

    // Approve → redemption: the secret is revealed and the grant is consumed (completed).
    await approvals.decide(requestId, "approved", {
      actor: { actorId: "user", actorType: "user", actorName: "Operator" },
    });
    const redeemed = await tool.execute("c3", { key: "API_TOKEN" }, undefined, undefined, agentCtx);
    expect(redeemed.isError).toBeUndefined();
    expect(redeemed.details?.value).toBe("s3cret-value");
    expect(redeemed.details?.approvalRequestId).toBe(requestId);
    expect((await approvals.get(requestId))?.status).toBe("completed");

    // Grant already redeemed → the next call mints a brand-new request.
    const afterRedeem = await tool.execute("c4", { key: "API_TOKEN" }, undefined, undefined, agentCtx);
    expect(afterRedeem.details?.outcome).toBe("pending_approval");
    expect(afterRedeem.details?.approvalRequestId).not.toBe(requestId);
  });

  it("fn_secret_get: denied row stays denied without minting a new request", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_secret_get");
    const secretsStore = injectSecretsStore();
    await secretsStore.createSecret({
      scope: "project",
      key: "DENIED_TOKEN",
      plaintextValue: "never-shown",
      accessPolicy: "prompt",
    });
    const approvals = buildApprovalStore();
    const agentCtx = { cwd, agentId: "agent-denied", agentName: "Denied Agent" };

    const first = await tool.execute("c1", { key: "DENIED_TOKEN" }, undefined, undefined, agentCtx);
    const requestId = first.details?.approvalRequestId as string;
    await approvals.decide(requestId, "denied", {
      actor: { actorId: "user", actorType: "user", actorName: "Operator" },
    });

    const second = await tool.execute("c2", { key: "DENIED_TOKEN" }, undefined, undefined, agentCtx);
    expect(second.details?.outcome).toBe("denied");
    expect(second.details?.approvalRequestId).toBe(requestId);
    expect(second.details?.value).toBeUndefined();
    // No new request was minted for the denied grant.
    expect(await approvals.list()).toHaveLength(1);
  });

  it("fn_secret_get: a registered durable chat agent is persisted when pi omits immediate agentId", async () => {
    const cwd = h.rootDir();
    const tool = requireTool(freshApi(), "fn_secret_get");
    const secretsStore = injectSecretsStore();
    await secretsStore.createSecret({ scope: "project", key: "CHAT_TOKEN", plaintextValue: "not-in-approval", accessPolicy: "prompt" });
    const dispose = registerFusionSessionIdentity(cwd, { agentId: "agent-1a009724", agentName: "Dashboard Chat Agent", purpose: "chat" });
    try {
      const result = await tool.execute("chat-call", { key: "CHAT_TOKEN" }, undefined, undefined, { cwd });
      const request = await buildApprovalStore().get(result.details?.approvalRequestId as string);
      expect(request?.requester).toMatchObject({
        actorId: "agent-1a009724",
        actorType: "agent",
        actorName: "Dashboard Chat Agent",
      });
    } finally {
      dispose();
    }
  });

  it("fn_secret_get: dashboard-chat pi invocation reaches real operator approve and deny routes", async () => {
    const cwd = h.rootDir();
    const tool = requireTool(freshApi(), "fn_secret_get");
    const secretsStore = injectSecretsStore();
    const app = createApprovalDecisionApp();

    /*
    FNXC:SecretsAccessApproval 2026-08-05-22:33:
    This is the production-reachability regression fixture for dashboard chat.
    Chat supplies the durable agent to createResolvedAgentSession, pi wraps the
    prompt with this invocation identity, and the real host extension receives
    an ExtensionContext with no agentId. That chain must persist the named agent
    so the server-derived operator can approve or deny rather than self-collide.
    */
    const requestFor = async (key: string) => {
      await secretsStore.createSecret({ scope: "project", key, plaintextValue: "not-in-approval", accessPolicy: "prompt" });
      const result = await runWithFusionSessionIdentity(
        [cwd],
        { agentId: "agent-1a009724", agentName: "Dashboard Chat Agent", purpose: "chat" },
        () => tool.execute(`chat-${key}`, { key }, undefined, undefined, { cwd }),
      );
      const requestId = result.details?.approvalRequestId as string;
      const approval = await buildApprovalStore().get(requestId);
      expect(approval?.requester).toMatchObject({
        actorId: "agent-1a009724",
        actorType: "agent",
        actorName: "Dashboard Chat Agent",
      });
      return requestId;
    };

    const approvedId = await requestFor("CHAT_APPROVE_TOKEN");
    const approved = await requestRoute(app, "POST", `/approvals/${approvedId}/decision`, JSON.stringify({ decision: "approve" }), {
      "content-type": "application/json",
    });
    expect(approved.status).toBe(200);
    expect((await buildApprovalStore().get(approvedId))?.status).toBe("approved");

    const deniedId = await requestFor("CHAT_DENY_TOKEN");
    const denied = await requestRoute(app, "POST", `/approvals/${deniedId}/decision`, JSON.stringify({ decision: "deny" }), {
      "content-type": "application/json",
    });
    expect(denied.status).toBe(200);
    expect((await buildApprovalStore().get(deniedId))?.status).toBe("denied");
  });

  it("fn_secret_get: production dashboard chat keeps its durable principal through a host secret call", async () => {
    const cwd = h.rootDir();
    const tool = requireTool(freshApi(), "fn_secret_get");
    const secretsStore = injectSecretsStore();
    const app = createApprovalDecisionApp();
    const chatStore = {
      getSession: vi.fn(() => ({ id: "chat-secret", agentId: "agent-1a009724", status: "active" })),
      addMessage: vi.fn((message) => ({ id: `message-${message.role}`, ...message })),
      getMessages: vi.fn(() => []),
      setInFlightGeneration: vi.fn(async () => undefined),
      updateSession: vi.fn(async () => undefined),
      recordTokenUsage: vi.fn(async () => undefined),
    };
    const agentStore = {
      init: vi.fn(async () => undefined),
      getAgent: vi.fn(async () => ({
        id: "agent-1a009724",
        name: "Dashboard Chat Agent",
        role: "executor",
        runtimeConfig: {},
      })),
    };
    const secretResults: Array<Awaited<ReturnType<typeof tool.execute>>> = [];

    /*
    FNXC:SecretsAccessApproval 2026-08-05-23:27:
    This production-shaped fixture begins at ChatManager and invokes the real
    createFnAgent prompt wrapper rather than manually creating an identity scope.
    It verifies that dashboard durable-agent lookup reaches pi before fn_secret_get
    receives an immediate context that deliberately omits agentId, then proves the
    server-derived operator can both approve and deny separate requests.
    */
    createPiAgentSessionMock.mockImplementation(async () => ({
      session: {
        state: { messages: [{ role: "assistant", content: "Requesting secret access" }] },
        subscribe: vi.fn(),
        dispose: vi.fn(),
        setThinkingLevel: vi.fn(),
        prompt: vi.fn(async (message: string) => {
          const key = message.includes("deny") ? "DASHBOARD_CHAT_DENY_TOKEN" : "DASHBOARD_CHAT_APPROVE_TOKEN";
          // The host extension receives only cwd; createFnAgent's prompt wrapper
          // must supply the durable principal for this real tool invocation.
          secretResults.push(await tool.execute("dashboard-chat-secret", { key }, undefined, undefined, { cwd }));
        }),
      },
    }));
    __setCreateResolvedAgentSession(async (options: any) => {
      const { createFnAgent } = await import("../../../engine/src/pi.js");
      return createFnAgent({ ...options, tools: "coding" }) as any;
    });

    try {
      await Promise.all([
        secretsStore.createSecret({ scope: "project", key: "DASHBOARD_CHAT_APPROVE_TOKEN", plaintextValue: "not-in-approval", accessPolicy: "prompt" }),
        secretsStore.createSecret({ scope: "project", key: "DASHBOARD_CHAT_DENY_TOKEN", plaintextValue: "not-in-approval", accessPolicy: "prompt" }),
      ]);
      const manager = new ChatManager(chatStore as any, cwd, agentStore as any, undefined, undefined, undefined, h.store());
      await manager.sendMessage("chat-secret", "Read the prompt-gated secret");
      await manager.sendMessage("chat-secret", "Read and deny the prompt-gated secret");

      expect(createPiAgentSessionMock).toHaveBeenCalledTimes(2);
      const [approvedRequestId, deniedRequestId] = secretResults.map((result) => result.details?.approvalRequestId);
      expect(approvedRequestId).toEqual(expect.any(String));
      expect(deniedRequestId).toEqual(expect.any(String));
      for (const requestId of [approvedRequestId, deniedRequestId]) {
        const approval = await buildApprovalStore().get(requestId as string);
        expect(approval?.requester).toMatchObject({
          actorId: "agent-1a009724",
          actorType: "agent",
          actorName: "Dashboard Chat Agent",
        });
      }

      const approved = await requestRoute(app, "POST", `/approvals/${approvedRequestId}/decision`, JSON.stringify({ decision: "approve" }), {
        "content-type": "application/json",
      });
      expect(approved.status).toBe(200);
      expect((await buildApprovalStore().get(approvedRequestId as string))?.status).toBe("approved");

      const denied = await requestRoute(app, "POST", `/approvals/${deniedRequestId}/decision`, JSON.stringify({ decision: "deny" }), {
        "content-type": "application/json",
      });
      expect(denied.status).toBe(200);
      expect((await buildApprovalStore().get(deniedRequestId as string))?.status).toBe("denied");
    } finally {
      __resetChatState();
    }
  });

  it("fn_secret_get: direct human CLI remains a user requester after a session disposes", async () => {
    const cwd = h.rootDir();
    const tool = requireTool(freshApi(), "fn_secret_get");
    const secretsStore = injectSecretsStore();
    await secretsStore.createSecret({ scope: "project", key: "CLI_TOKEN", plaintextValue: "not-in-approval", accessPolicy: "prompt" });
    const dispose = registerFusionSessionIdentity(cwd, { agentId: "agent-disposed" });
    dispose();

    const result = await tool.execute("cli-call", { key: "CLI_TOKEN" }, undefined, undefined, { cwd });
    const request = await buildApprovalStore().get(result.details?.approvalRequestId as string);
    expect(request?.requester).toEqual({ actorId: "user", actorType: "user", actorName: "CLI User" });
  });

  it("fn_secret_get: concurrent same-root registrations fail closed without minting a shared approval", async () => {
    const cwd = h.rootDir();
    const tool = requireTool(freshApi(), "fn_secret_get");
    const secretsStore = injectSecretsStore();
    await secretsStore.createSecret({ scope: "project", key: "AMBIGUOUS_TOKEN", plaintextValue: "not-in-approval", accessPolicy: "prompt" });
    const disposeA = registerFusionSessionIdentity(cwd, { agentId: "agent-a" });
    const disposeB = registerFusionSessionIdentity(cwd, { agentId: "agent-b" });
    try {
      const result = await tool.execute("ambiguous-call", { key: "AMBIGUOUS_TOKEN" }, undefined, undefined, { cwd });
      expect(result.isError).toBe(true);
      expect(result.details?.error).toBe("ambiguous-caller-identity");
      expect(await buildApprovalStore().list()).toHaveLength(0);
    } finally {
      disposeA();
      disposeB();
    }
  });

  // ── fn_task_retry move source ────────────────────────────────────

  it("fn_task_retry moves with the user/hard-cancel move source", async () => {
    const cwd = h.rootDir();
    const api = freshApi();
    const tool = requireTool(api, "fn_task_retry");
    const task = await h.store().createTask({ description: "retry source target", column: "triage" });
    await h.store().updateTask(task.id, { status: "failed", error: "boom" });

    const moves: Array<{ to: string; source: string }> = [];
    const onMoved = (data: { to: string; source: string }) => {
      moves.push({ to: data.to, source: data.source });
    };
    h.store().on("task:moved", onMoved as never);
    try {
      const result = await tool.execute("c1", { id: task.id }, undefined, undefined, { cwd });
      expect(result.isError).toBeUndefined();
    } finally {
      h.store().off("task:moved", onMoved as never);
    }

    const todoMove = moves.find((m) => m.to === "todo");
    expect(todoMove).toBeTruthy();
    expect(todoMove?.source).toBe("user");
    expect((await h.store().getTask(task.id)).column).toBe("todo");
  });
});
