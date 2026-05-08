import { beforeEach, describe, expect, it } from "vitest";
import {
  addToExemptTools,
  computeApprovalDedupeKey,
  evaluateAgentActionGate,
  reloadExemptTools,
} from "../agent-action-gate.js";
import type { AgentPermissionPolicy } from "@fusion/core";

const unrestrictedPolicy: AgentPermissionPolicy = {
  presetId: "unrestricted",
  rules: {
    "git_write": "allow",
    "file_write_delete": "allow",
    "command_execution": "allow",
    "network_api": "allow",
    "task_agent_mutation": "allow",
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

  it("classifies explicit network and management tools", () => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_research_run", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("network_api");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_create", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_add_dep", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_delegate_task", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_update_agent_config", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_update_identity", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_spawn_agent", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task_agent_mutation");
  });

  it("keeps routine task bookkeeping tools exempt", () => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: approvalPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: approvalPolicy }).disposition).toBe("allow");
  });

  it.each([
    "fn_heartbeat_done",
    "fn_task_create",
    "fn_delegate_task",
    "fn_send_message",
    "fn_memory_append",
    "fn_update_identity",
    "fn_reflect_on_performance",
  ])("always allows newly exempt internal tool %s under locked-down policies", (toolName) => {
    const decision = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: lockedDownPolicy });
    expect(decision.disposition).toBe("allow");
    expect(decision.category).toBe("exempt");
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
