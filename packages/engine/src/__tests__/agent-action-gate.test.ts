import { describe, expect, it } from "vitest";
import { evaluateAgentActionGate, computeApprovalDedupeKey } from "../agent-action-gate.js";
import type { AgentPermissionPolicy } from "@fusion/core";

const unrestrictedPolicy: AgentPermissionPolicy = {
  presetId: "unrestricted",
  rules: {
    "git-write": "allow",
    "file-write-delete": "allow",
    "shell-command": "allow",
    "network-api": "allow",
    "task-agent-management": "allow",
  },
};

const approvalPolicy: AgentPermissionPolicy = {
  ...unrestrictedPolicy,
  presetId: "approval-required",
  rules: {
    "git-write": "require-approval",
    "file-write-delete": "require-approval",
    "shell-command": "require-approval",
    "network-api": "require-approval",
    "task-agent-management": "require-approval",
  },
};

describe("agent-action-gate", () => {
  it("classifies write/edit as file-write-delete", () => {
    const write = evaluateAgentActionGate({ agentId: "a1", toolName: "write", args: { path: "a.ts" }, permissionPolicy: unrestrictedPolicy });
    const edit = evaluateAgentActionGate({ agentId: "a1", toolName: "edit", args: { path: "a.ts" }, permissionPolicy: unrestrictedPolicy });
    expect(write.category).toBe("file-write-delete");
    expect(edit.category).toBe("file-write-delete");
  });

  it("classifies mutating git bash commands as git-write", () => {
    const commit = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git commit -m x" }, permissionPolicy: unrestrictedPolicy });
    const branchCreate = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git checkout -b feature" }, permissionPolicy: unrestrictedPolicy });
    expect(commit.category).toBe("git-write");
    expect(branchCreate.operation).toBe("git checkout -b");
  });

  it("classifies non-mutating git status/diff as shell-command (allow by policy)", () => {
    const status = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git status" }, permissionPolicy: unrestrictedPolicy });
    const diff = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git diff" }, permissionPolicy: unrestrictedPolicy });
    expect(status.category).toBe("shell-command");
    expect(diff.operation).toBe("git diff");
  });

  it("classifies git branch listing/read vs branch creation", () => {
    const listing = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git branch" }, permissionPolicy: unrestrictedPolicy });
    const showCurrent = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git branch --show-current" }, permissionPolicy: unrestrictedPolicy });
    const create = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git branch feature" }, permissionPolicy: unrestrictedPolicy });
    expect(listing.category).toBe("shell-command");
    expect(showCurrent.operation).toBe("git branch --show-current");
    expect(create.category).toBe("git-write");
  });

  it("classifies git remote -v as read-only", () => {
    const listing = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git remote -v" }, permissionPolicy: unrestrictedPolicy });
    const add = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "git remote add origin https://x" }, permissionPolicy: unrestrictedPolicy });
    expect(listing.category).toBe("shell-command");
    expect(add.category).toBe("git-write");
  });

  it("classifies generic bash commands as shell-command", () => {
    const result = evaluateAgentActionGate({ agentId: "a1", toolName: "bash", args: { command: "pnpm test" }, permissionPolicy: unrestrictedPolicy });
    expect(result.category).toBe("shell-command");
    expect(result.resourceType).toBe("command");
  });

  it("classifies explicit network and management tools", () => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_research_run", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("network-api");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_create", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task-agent-management");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_add_dep", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task-agent-management");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_delegate_task", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task-agent-management");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_update_agent_config", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task-agent-management");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_update_identity", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task-agent-management");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_spawn_agent", args: {}, permissionPolicy: unrestrictedPolicy }).category).toBe("task-agent-management");
  });

  it("keeps routine task bookkeeping tools exempt", () => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: approvalPolicy }).category).toBe("exempt");
    expect(evaluateAgentActionGate({ agentId: "a1", toolName: "fn_task_update", args: {}, permissionPolicy: approvalPolicy }).disposition).toBe("allow");
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
      category: "file-write-delete",
      resourceType: "file",
      resourceId: "a.ts",
      operation: "write",
    });
    expect(key).toBe("agent-1|FN-1|write|file-write-delete|file|a.ts|write");
  });
});
