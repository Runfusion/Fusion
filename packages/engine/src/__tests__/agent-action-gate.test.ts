import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToExemptTools,
  computeApprovalDedupeKey,
  evaluateAgentActionGate,
  getExemptToolNames,
  reloadExemptTools,
  resolveGateOutcome,
} from "../agent-action-gate.js";
import type { AgentPermissionPolicy } from "@fusion/core";

const FN_3548_COORDINATION_TOOLS = [
  "fn_heartbeat_done",
  "fn_task_log",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_artifact_register",
  "fn_artifact_list",
  "fn_artifact_view",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_ask_question",
  "fn_send_message",
  "fn_read_messages",
  "fn_memory_search",
  "fn_memory_get",
  "fn_memory_append",
  "fn_read_evaluations",
  "fn_update_identity",
  "fn_reflect_on_performance",
] as const;

const unrestrictedPolicy: AgentPermissionPolicy = {
  presetId: "unrestricted",
  rules: {
    "git_write": "allow",
    "file_write_delete": "allow",
    "command_execution": "allow",
    "network_api": "allow",
    "task_agent_mutation": "allow",
    // FN-7728: review_gate_bypass is intentionally allow here so tests targeting this fixture's other
    // categories are unaffected; dedicated review_gate_bypass disposition coverage lives below.
    "review_gate_bypass": "allow",
    // FN-7737: file_scope is intentionally allow here (matches its uniform grant-all default); dedicated
    // file_scope disposition coverage lives below.
    "file_scope": "allow",
  },
};

const lockedDownPolicy: AgentPermissionPolicy = {
  presetId: "locked-down",
  rules: {
    "git_write": "block",
    "file_write_delete": "block",
    "command_execution": "block",
    "network_api": "block",
    "task_agent_mutation": "block",
    "review_gate_bypass": "block",
    "file_scope": "block",
  },
};

const approvalPolicy: AgentPermissionPolicy = {
  ...unrestrictedPolicy,
  presetId: "approval-required",
  rules: {
    "git_write": "require-approval",
    "file_write_delete": "require-approval",
    "command_execution": "require-approval",
    "network_api": "require-approval",
    "task_agent_mutation": "require-approval",
    "review_gate_bypass": "require-approval",
    "file_scope": "require-approval",
  },
};

describe("agent-action-gate", () => {
  beforeEach(() => {
    reloadExemptTools();
  });
  it("classifies write/edit as file_write_delete", () => {
    const write = evaluateAgentActionGate({ agentId: "a1", toolName: "write", args: { path: "a.ts" }, permissionPolicy: unrestrictedPolicy });
    const edit = evaluateAgentActionGate({ agentId: "a1", toolName: "edit", args: { path: "a.ts" }, permissionPolicy: unrestrictedPolicy });
    expect(write.category).toBe("file_write_delete");
    expect(edit.category).toBe("file_write_delete");
  });

  it("classifies mutating git bash commands as git_write", () => {
    const commit = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git commit -m x" }, permissionPolicy: unrestrictedPolicy });
    const branchCreate = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git checkout -b feature" }, permissionPolicy: unrestrictedPolicy });
    expect(commit.category).toBe("git_write");
    expect(branchCreate.operation).toBe("git checkout -b");
  });

  it("classifies non-mutating git status/diff as command_execution (allow by policy)", () => {
    const status = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git status" }, permissionPolicy: unrestrictedPolicy });
    const diff = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git diff" }, permissionPolicy: unrestrictedPolicy });
    expect(status.category).toBe("command_execution");
    expect(diff.operation).toBe("git diff");
  });

  it("classifies git branch listing/read vs branch creation", () => {
    const listing = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git branch" }, permissionPolicy: unrestrictedPolicy });
    const showCurrent = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git branch --show-current" }, permissionPolicy: unrestrictedPolicy });
    const create = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git branch feature" }, permissionPolicy: unrestrictedPolicy });
    expect(listing.category).toBe("command_execution");
    expect(showCurrent.operation).toBe("git branch --show-current");
    expect(create.category).toBe("git_write");
  });

  it("classifies git remote -v as read-only", () => {
    const listing = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git remote -v" }, permissionPolicy: unrestrictedPolicy });
    const add = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git remote add origin https://x" }, permissionPolicy: unrestrictedPolicy });
    expect(listing.category).toBe("command_execution");
    expect(add.category).toBe("git_write");
  });

  it("classifies generic bash commands as command_execution", () => {
    const result = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "pnpm test" }, permissionPolicy: unrestrictedPolicy });
    expect(result.category).toBe("command_execution");
    expect(result.resourceType).toBe("command");
  });

  it("classifies namespaced MCP tools as governed network API actions", () => {
    const decision = evaluateAgentActionGate({
      agentId: "agent-1",
      taskId: "MAIN-008",
      toolName: "mcp__postiz__integrationlist",
      args: {},
      permissionPolicy: approvalPolicy,
    });

    expect(decision).toMatchObject({
      category: "network_api",
      disposition: "require-approval",
      operation: "mcp__postiz__integrationlist",
      resourceType: "mcp",
    });
  });

  it("keeps built-in research network tools as research resource type", () => {
    const decision = evaluateAgentActionGate({
      agentId: "agent-1",
      toolName: "fn_research_run",
      args: {},
      permissionPolicy: approvalPolicy,
    });
    expect(decision.category).toBe("network_api");
    expect(decision.resourceType).toBe("research");
  });

  it("executes an approved namespaced MCP operation once and never executes a denied one", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "real-shape-result" }] });
    const tool = { name: "mcp__postiz__integrationlist", label: "List integrations", description: "", parameters: {}, execute };
    const { wrapToolsWithActionGate } = await import("../pi.js");
    const requests = new Map<string, { id: string; status: "pending" | "approved" | "denied" | "completed" }>();
    const createApprovalRequest = vi.fn(async (decision: { approvalDedupeKey: string }) => {
      const request = { id: "apr-main-008", status: "pending" as const };
      requests.set(decision.approvalDedupeKey, request);
      return request;
    });
    const findApprovalByDedupeKey = vi.fn(async (key: string) => requests.get(key) ?? null);
    const markApprovalCompleted = vi.fn(async (id: string) => {
      for (const [key, request] of requests) {
        if (request.id === id) requests.set(key, { ...request, status: "completed" });
      }
    });
    const context = {
      agentId: "agent-main-008",
      agentName: "MAIN-008 agent",
      isEphemeral: false,
      taskId: "MAIN-008",
      permissionPolicy: approvalPolicy,
      createApprovalRequest,
      findApprovalByDedupeKey,
      pauseForApproval: vi.fn(),
      markApprovalCompleted,
    };

    const initial = wrapToolsWithActionGate([tool as any], context);
    const pending = await (initial[0] as any).execute("pending", {});
    expect(pending.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    const [dedupeKey, request] = [...requests.entries()][0]!;
    requests.set(dedupeKey, { ...request, status: "approved" });
    const resumed = wrapToolsWithActionGate([tool as any], context);
    await expect((resumed[0] as any).execute("approved", {})).resolves.toEqual({
      content: [{ type: "text", text: "real-shape-result" }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(markApprovalCompleted).toHaveBeenCalledWith("apr-main-008");
    expect(requests.get(dedupeKey)?.status).toBe("completed");

    execute.mockClear();
    requests.set(dedupeKey, { id: "apr-denied", status: "denied" });
    const denied = wrapToolsWithActionGate([tool as any], context);
    const rejection = await (denied[0] as any).execute("denied", {});
    expect(rejection.error).toMatch(/denied/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it("classifies explicit network and management tools", () => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_research_run", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("network_api");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_create", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_add_dep", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_delegate_task", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_update_agent_config", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_import_github", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_import_github_issue", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_import_gitlab_project_issues", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_ask_question", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_update_identity", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_spawn_agent", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
  });

  it("governs fn_task_update as task_agent_mutation under permission policy", () => {
    const approvalDecision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: approvalPolicy });
    const blockedDecision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: lockedDownPolicy });

    expect(approvalDecision.category).toBe("task_agent_mutation");
    expect(approvalDecision.disposition).toBe("require-approval");
    expect(blockedDecision.category).toBe("task_agent_mutation");
    expect(blockedDecision.disposition).toBe("block");
  });

  // FN-7728: fn_task_bypass_review must classify as its own review_gate_bypass category,
  // not task_agent_mutation, and must never fall through to the unrecognized-tool exempt fallback.
  it("classifies fn_task_bypass_review as review_gate_bypass, distinct from task_agent_mutation and exempt", () => {
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_bypass_review", args: {}, permissionPolicy: unrestrictedPolicy });
    expect(decision.category).toBe("review_gate_bypass");
    expect(decision.category).not.toBe("task_agent_mutation");
    expect(decision.category).not.toBe("exempt");
    expect(decision.resourceType).toBe("task");
  });

  it.each([
    ["allow" as const, "allow" as const],
    ["require-approval" as const, "require-approval" as const],
    ["block" as const, "block" as const],
  ])("honors review_gate_bypass disposition %s for fn_task_bypass_review", (ruleDisposition, expectedDisposition) => {
    const policy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: { ...unrestrictedPolicy.rules, review_gate_bypass: ruleDisposition },
    };
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_bypass_review", args: {}, permissionPolicy: policy });
    expect(decision.category).toBe("review_gate_bypass");
    expect(decision.disposition).toBe(expectedDisposition);
  });

  it("lets an exact toolRules.fn_task_bypass_review override win over the review_gate_bypass category rule", () => {
    const policy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: { ...unrestrictedPolicy.rules, review_gate_bypass: "block" },
      toolRules: { fn_task_bypass_review: "allow" },
    };
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_bypass_review", args: {}, permissionPolicy: policy });
    expect(decision.category).toBe("review_gate_bypass");
    expect(decision.disposition).toBe("allow");
    expect(decision.metadata).toMatchObject({
      permissionPolicyMatch: { type: "toolRule", toolName: "fn_task_bypass_review", disposition: "allow" },
    });
  });

  // FN-7737: fn_task_file_scope_add must classify as its own file_scope category,
  // not task_agent_mutation/file_write_delete, and must never fall through to the unrecognized-tool exempt fallback.
  it("classifies fn_task_file_scope_add as file_scope, distinct from task_agent_mutation/file_write_delete and exempt", () => {
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_file_scope_add", args: {}, permissionPolicy: unrestrictedPolicy });
    expect(decision.category).toBe("file_scope");
    expect(decision.category).not.toBe("task_agent_mutation");
    expect(decision.category).not.toBe("file_write_delete");
    expect(decision.category).not.toBe("exempt");
    expect(decision.resourceType).toBe("file");
  });

  it.each([
    ["allow" as const, "allow" as const],
    ["require-approval" as const, "require-approval" as const],
    ["block" as const, "block" as const],
  ])("honors file_scope disposition %s for fn_task_file_scope_add", (ruleDisposition, expectedDisposition) => {
    const policy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: { ...unrestrictedPolicy.rules, file_scope: ruleDisposition },
    };
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_file_scope_add", args: {}, permissionPolicy: policy });
    expect(decision.category).toBe("file_scope");
    expect(decision.disposition).toBe(expectedDisposition);
  });

  it("lets an exact toolRules.fn_task_file_scope_add override win over the file_scope category rule", () => {
    const policy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: { ...unrestrictedPolicy.rules, file_scope: "block" },
      toolRules: { fn_task_file_scope_add: "allow" },
    };
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_file_scope_add", args: {}, permissionPolicy: policy });
    expect(decision.category).toBe("file_scope");
    expect(decision.disposition).toBe("allow");
    expect(decision.metadata).toMatchObject({
      permissionPolicyMatch: { type: "toolRule", toolName: "fn_task_file_scope_add", disposition: "allow" },
    });
  });

  it("uses exact tool overrides before task-agent category rules", () => {
    const policy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: {
        ...unrestrictedPolicy.rules,
        task_agent_mutation: "allow",
      },
      toolRules: {
        fn_task_create: "block",
        fn_task_refine: "require-approval",
      },
    };

    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_create", args: {}, permissionPolicy: policy })).toMatchObject({
      category: "task_agent_mutation",
      disposition: "block",
      metadata: {
        permissionPolicyMatch: {
          type: "toolRule",
          toolName: "fn_task_create",
          disposition: "block",
        },
      },
    });
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: policy })).toMatchObject({
      category: "task_agent_mutation",
      disposition: "allow",
      metadata: {},
    });
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_refine", args: {}, permissionPolicy: policy })).toMatchObject({
      category: "task_agent_mutation",
      disposition: "require-approval",
      metadata: {
        permissionPolicyMatch: {
          type: "toolRule",
          toolName: "fn_task_refine",
          disposition: "require-approval",
        },
      },
    });
  });

  it.each(["fn_workflow_list", "fn_workflow_get", "fn_workflow_validate", "fn_trait_list"] as const)("allows workflow discovery tool %s as a known coordination exemption", (toolName) => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: lockedDownPolicy })).toMatchObject({
      category: "exempt",
      disposition: "allow",
      operation: toolName,
    });
  });

  it.each([
    "fn_workflow_create",
    "fn_workflow_update",
    "fn_workflow_delete",
    "fn_workflow_settings",
    "fn_workflow_select",
    "fn_task_promote",
  ] as const)("governs newly injected heartbeat mutating tool %s by task-agent policy", (toolName) => {
    const allowedDecision = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: unrestrictedPolicy });
    const approvalDecision = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: approvalPolicy });
    const blockedDecision = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: lockedDownPolicy });

    expect(allowedDecision.category).toBe("task_agent_mutation");
    expect(allowedDecision.disposition).toBe("allow");
    expect(approvalDecision.category).toBe("task_agent_mutation");
    expect(approvalDecision.disposition).toBe("require-approval");
    expect(blockedDecision.category).toBe("task_agent_mutation");
    expect(blockedDecision.disposition).toBe("block");
  });

  it("executes or withholds newly injected workflow tools according to AgentPermissionPolicy", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool = { name: "fn_workflow_delete", label: "Delete Workflow", description: "", parameters: {}, execute };
    const { wrapToolsWithActionGate } = await import("../pi.js");

    const unrestricted = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: unrestrictedPolicy,
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn(),
    });
    await expect((unrestricted[0] as any).execute("delete-allow", { workflow_id: "WF-1" })).resolves.toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);

    const locked = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: lockedDownPolicy,
      createApprovalRequest: vi.fn(),
      findApprovalByDedupeKey: vi.fn(),
    });
    const blocked = await (locked[0] as any).execute("delete-block", { workflow_id: "WF-1" });
    expect(blocked).toEqual(expect.objectContaining({
      isError: true,
      decision: expect.objectContaining({
        category: "task_agent_mutation",
        disposition: "block",
        toolName: "fn_workflow_delete",
      }),
    }));
    expect(execute).toHaveBeenCalledTimes(1);

    const createApprovalRequest = vi.fn().mockResolvedValue({ id: "apr-workflow-1" });
    const pauseForApproval = vi.fn();
    const approval = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: approvalPolicy,
      createApprovalRequest,
      findApprovalByDedupeKey: vi.fn().mockResolvedValue(null),
      pauseForApproval,
    });
    const pending = await (approval[0] as any).execute("delete-approval", { workflow_id: "WF-1" });
    expect(pending).toEqual(expect.objectContaining({
      isError: true,
      decision: expect.objectContaining({
        category: "task_agent_mutation",
        disposition: "require-approval",
        toolName: "fn_workflow_delete",
        metadata: expect.objectContaining({ approvalRequestId: "apr-workflow-1" }),
      }),
    }));
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(pauseForApproval).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  /*
  FNXC:AgentGating 2026-07-05-00:25:
  FN-7608 regression coverage: an identical gated `bash` call issued twice
  (same command — the original symptom was `pnpm install` re-issued while the
  first request sat pending) must NOT mint a second approval request, and
  BOTH the newly-created and reused-pending sub-cases must invoke
  pauseForApproval so the executor's session-abort wiring actually runs every
  time a gate resolves to wait-for-approval — not only on first creation.
  Uses a tiny in-memory fake backed by the real findLatestByDedupeKey
  contract shape (id + status) to drive resolveGateOutcome's dedupe reuse.
  */
  it("dedupes identical pending bash approvals and pauses on both the created and reused-pending path", async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true });
    const tool = { name: "bash", label: "Bash", description: "", parameters: {}, execute };
    const { wrapToolsWithActionGate } = await import("../pi.js");

    const requests = new Map<string, { id: string; status: "pending" | "approved" | "denied" }>();
    let nextId = 0;
    const createApprovalRequest = vi.fn(async (decision: { approvalDedupeKey: string }) => {
      const id = `apr-${++nextId}`;
      requests.set(decision.approvalDedupeKey, { id, status: "pending" });
      return { id };
    });
    const findApprovalByDedupeKey = vi.fn(async (dedupeKey: string) => requests.get(dedupeKey) ?? null);
    const pauseForApproval = vi.fn();

    const gated = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: approvalPolicy,
      createApprovalRequest,
      findApprovalByDedupeKey,
      pauseForApproval,
    });

    const first = await (gated[0] as any).execute("call-1", { command: "pnpm install" });
    expect(first.isError).toBe(true);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(pauseForApproval).toHaveBeenCalledTimes(1);
    const firstApprovalId = first.decision.metadata.approvalRequestId;
    expect(firstApprovalId).toBe("apr-1");

    // Second identical call: same dedupe key, request still pending -> must
    // reuse the existing request (no second createApprovalRequest call) but
    // must STILL invoke pauseForApproval so the session is suspended again.
    const second = await (gated[0] as any).execute("call-2", { command: "pnpm install" });
    expect(second.isError).toBe(true);
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);
    expect(pauseForApproval).toHaveBeenCalledTimes(2);
    expect(second.decision.metadata.approvalRequestId).toBe(firstApprovalId);
    expect(execute).not.toHaveBeenCalled();

    // A denied request must block and must never retry/execute.
    requests.set(second.decision.metadata.dedupeKey, { id: firstApprovalId, status: "denied" });
    const third = await (gated[0] as any).execute("call-3", { command: "pnpm install" });
    expect(third.isError).toBe(true);
    expect(third.error).toMatch(/denied/i);
    expect(execute).not.toHaveBeenCalled();
    expect(createApprovalRequest).toHaveBeenCalledTimes(1);

    // An approved request executes exactly once, then completes.
    requests.set(second.decision.metadata.dedupeKey, { id: firstApprovalId, status: "approved" });
    const markApprovalCompleted = vi.fn();
    const approvedGate = wrapToolsWithActionGate([tool as any], {
      agentId: "agent-1",
      agentName: "Agent",
      isEphemeral: false,
      taskId: "FN-1",
      permissionPolicy: approvalPolicy,
      createApprovalRequest,
      findApprovalByDedupeKey,
      pauseForApproval,
      markApprovalCompleted,
    });
    const fourth = await (approvedGate[0] as any).execute("call-4", { command: "pnpm install" });
    expect(fourth).toEqual({ ok: true });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(markApprovalCompleted).toHaveBeenCalledWith(firstApprovalId);
  });

  it.each([
    "fn_task_create",
    "fn_delegate_task",
    "fn_task_import_github",
    "fn_task_import_github_issue",
    "fn_task_import_gitlab_project_issues",
    "fn_task_import_gitlab_group_issues",
    "fn_task_import_gitlab_merge_requests",
  ] as const)("governs task creation/import tool %s as task_agent_mutation", (toolName) => {
    for (const args of [{}, undefined]) {
      expect(evaluateAgentActionGate({ agentId: "a1", toolName, args, permissionPolicy: approvalPolicy })).toMatchObject({
        category: "task_agent_mutation",
        disposition: "require-approval",
      });
      expect(evaluateAgentActionGate({ agentId: "a1", toolName, args, permissionPolicy: lockedDownPolicy })).toMatchObject({
        category: "task_agent_mutation",
        disposition: "block",
      });
    }
  });

  it.each(FN_3548_COORDINATION_TOOLS)("always allows newly exempt internal tool %s under locked-down policies", (toolName) => {
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: lockedDownPolicy });
    expect(decision.disposition).toBe("allow");
    expect(decision.category).toBe("exempt");
  });

  it("allows fn_ask_question as an action-gate coordination exemption under locked-down policy", () => {
    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_ask_question",
      args: {},
      permissionPolicy: lockedDownPolicy,
    })).toMatchObject({
      category: "exempt",
      disposition: "allow",
    });
  });

  it("keeps FN-3548 coordination tool list in exempt registry", () => {
    expect(getExemptToolNames()).toEqual(expect.arrayContaining([...FN_3548_COORDINATION_TOOLS]));
  });

  it("keeps bash and write blocked under locked-down policy", () => {
    const bashDecision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "bash",
      args: { command: "git commit -m x" },
      permissionPolicy: lockedDownPolicy,
    });
    const writeDecision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "write",
      args: { path: "a.ts", content: "x" },
      permissionPolicy: lockedDownPolicy,
    });

    expect(bashDecision.disposition).toBe("block");
    expect(writeDecision.disposition).toBe("block");
  });

  it("uses default exemptions without reload", () => {
    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "read",
      args: {},
      permissionPolicy: lockedDownPolicy,
    });

    expect(decision.category).toBe("exempt");
    expect(decision.disposition).toBe("allow");
  });

  it("reloadExemptTools can replace and restore exemptions", () => {
    reloadExemptTools(["custom_tool"]);
    const customDecision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "custom_tool",
      args: {},
      permissionPolicy: lockedDownPolicy,
    });
    expect(customDecision.category).toBe("exempt");
    expect(customDecision.disposition).toBe("allow");

    reloadExemptTools([]);
    const readBlocked = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "read",
      args: {},
      permissionPolicy: lockedDownPolicy,
    });
    expect(readBlocked.category).toBe("command_execution");
    expect(readBlocked.disposition).toBe("block");

    reloadExemptTools();
    const readRestored = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "read",
      args: {},
      permissionPolicy: lockedDownPolicy,
    });
    expect(readRestored.category).toBe("exempt");
    expect(readRestored.disposition).toBe("allow");
  });

  it("addToExemptTools exempts a custom tool", () => {
    addToExemptTools("my_new_tool");

    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "my_new_tool",
      args: {},
      permissionPolicy: lockedDownPolicy,
    });

    expect(decision.category).toBe("exempt");
    expect(decision.disposition).toBe("allow");
  });

  it("resolves disposition from policy", () => {
    const result = evaluateAgentActionGate({ agentId: "a1", toolName: "write", args: { path: "a.ts" }, permissionPolicy: approvalPolicy });
    expect(result.disposition).toBe("require-approval");
  });

  it("resolveGateOutcome waits when there is no latest request", () => {
    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "write",
      args: { path: "a.ts" },
      permissionPolicy: approvalPolicy,
    });
    expect(resolveGateOutcome(decision, null)).toEqual({ outcome: "wait-for-approval" });
  });

  it("resolveGateOutcome reuses pending request", () => {
    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "write",
      args: { path: "a.ts" },
      permissionPolicy: approvalPolicy,
    });
    expect(resolveGateOutcome(decision, { id: "apr-1", status: "pending" })).toEqual({
      outcome: "wait-for-approval",
      approvalRequestId: "apr-1",
    });
  });

  it("resolveGateOutcome executes once on approved request", () => {
    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "write",
      args: { path: "a.ts" },
      permissionPolicy: approvalPolicy,
    });
    expect(resolveGateOutcome(decision, { id: "apr-1", status: "approved" })).toEqual({
      outcome: "execute-once-then-complete",
      approvalRequestId: "apr-1",
    });
  });

  it("resolveGateOutcome blocks denied request", () => {
    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "write",
      args: { path: "a.ts" },
      permissionPolicy: approvalPolicy,
    });
    expect(resolveGateOutcome(decision, { id: "apr-1", status: "denied" })).toEqual({
      outcome: "block",
      approvalRequestId: "apr-1",
    });
  });

  it("resolveGateOutcome requires new approval after completion", () => {
    const decision = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "write",
      args: { path: "a.ts" },
      permissionPolicy: approvalPolicy,
    });
    expect(resolveGateOutcome(decision, { id: "apr-1", status: "completed" })).toEqual({ outcome: "wait-for-approval" });
  });

  it("computes deterministic dedupe key", () => {
    const key = computeApprovalDedupeKey({
      agentId: "agent-1",
      taskId: "FN-1",
      toolName: "write",
      category: "file_write_delete",
      resourceType: "file",
      resourceId: "a.ts",
      operation: "write",
    });
    expect(key).toBe("agent-1|FN-1|write|file_write_delete|file|a.ts|write");
  });
});
