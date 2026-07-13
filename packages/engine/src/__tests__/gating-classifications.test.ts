import { describe, expect, it } from "vitest";
import { evaluateAgentActionGate } from "../agent-action-gate.js";
import {
  ACTION_GATE_NETWORK_API_TOOLS,
  ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS,
  COMMAND_EXECUTION_FN_TOOLS,
  COORDINATION_EXEMPT_TOOLS,
  FILE_SCOPE_FN_TOOLS,
  FILE_WRITE_DELETE_FN_TOOLS,
  NETWORK_API_TOOLS,
  PERMANENT_AGENT_TASK_MUTATION_TOOLS,
  READONLY_FN_TOOLS,
  TASK_AGENT_MUTATION_TOOLS,
  classifyGitCommand,
  isGitWriteCommand,
} from "../gating-classifications.js";
import { classifyPermanentAgentToolCall, resolvePermanentAgentToolDecision } from "../permanent-agent-gating.js";
import type { AgentPermissionPolicy } from "@fusion/core";

const unrestrictedPolicy: AgentPermissionPolicy = {
  presetId: "unrestricted",
  rules: {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
    review_gate_bypass: "allow",
    file_scope: "allow",
  },
};

const approvalRequiredPolicy: AgentPermissionPolicy = {
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

const blockedPolicy: AgentPermissionPolicy = {
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

const FN_7111_GOVERNED_TOOLS = [
  ["fn_workflow_select", "task_agent_mutation"],
  ["fn_workflow_create", "task_agent_mutation"],
  ["fn_workflow_update", "task_agent_mutation"],
  ["fn_workflow_delete", "task_agent_mutation"],
  ["fn_workflow_settings", "task_agent_mutation"],
  ["fn_task_update", "task_agent_mutation"],
  ["fn_task_promote", "task_agent_mutation"],
  ["fn_task_refine", "task_agent_mutation"],
  ["fn_run_verification", "command_execution"],
  ["fn_acquire_repo_worktree", "command_execution"],
  ["fn_research_cancel", "network_api"],
] as const;

const gitCases = [
  ["git status", false, "git status"],
  ["git diff", false, "git diff"],
  ["git log --oneline", false, "git log"],
  ["git show HEAD", false, "git show"],
  ["git add .", true, "git add"],
  ["git commit -m x", true, "git commit"],
  ["git branch", false, "git branch"],
  ["git branch --show-current", false, "git branch --show-current"],
  ["git branch feature", true, "git branch"],
  ["git branch -d feature", true, "git branch"],
  ["git switch main", false, "git switch"],
  ["git switch -c feature", true, "git switch -c"],
  ["git checkout main", false, "git checkout"],
  ["git checkout -b feature", true, "git checkout -b"],
  ["git pull", false, "git pull"],
  ["git pull --rebase", true, "git pull --rebase"],
  ["git restore file.ts", false, "git restore"],
  ["git restore --staged file.ts", true, "git restore --staged"],
  ["git remote -v", false, "git remote -v"],
  ["git remote add origin x", true, "git remote"],
  ["git remote set-url origin y", true, "git remote"],
  ["git worktree list", false, "git worktree"],
  ["git worktree add ../x", true, "git worktree add"],
  ["git worktree remove ../x", true, "git worktree remove"],
  ["echo hi && git status", false, "git status"],
  ["echo hi; git commit -m x", true, "git commit"],
  ["echo hi | git diff", false, "git diff"],
  ["echo hi\ngit checkout -b t", true, "git checkout -b"],
] as const;

const ACTION_MUTATION_PERMANENT_READONLY_TOOLS = new Set([
  "fn_delegate_task",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_import_gitlab_project_issues",
  "fn_task_import_gitlab_group_issues",
  "fn_task_import_gitlab_merge_requests",
]);

const policyMatrix = [
  [unrestrictedPolicy, "allow"],
  [approvalRequiredPolicy, "require-approval"],
  [blockedPolicy, "block"],
] as const;

const permanentReadonlySiblingTaskCreationTools = [
  "fn_delegate_task",
  "fn_task_import_github",
  "fn_task_import_github_issue",
  "fn_task_import_gitlab_project_issues",
  "fn_task_import_gitlab_group_issues",
  "fn_task_import_gitlab_merge_requests",
] as const;

describe("gating-classifications parity", () => {
  it("locks coordination exempt membership", () => {
    expect([...COORDINATION_EXEMPT_TOOLS].sort()).toMatchInlineSnapshot(`
      [
        "find",
        "fn_agent_org_chart",
        "fn_agent_show",
        "fn_artifact_list",
        "fn_artifact_register",
        "fn_artifact_view",
        "fn_ask_question",
        "fn_goal_list",
        "fn_goal_show",
        "fn_heartbeat_done",
        "fn_list_agents",
        "fn_memory_append",
        "fn_memory_get",
        "fn_memory_search",
        "fn_post_room_message",
        "fn_read_evaluations",
        "fn_read_messages",
        "fn_reflect_on_performance",
        "fn_send_message",
        "fn_task_document_read",
        "fn_task_document_write",
        "fn_task_done",
        "fn_task_get",
        "fn_task_list",
        "fn_task_log",
        "fn_task_search",
        "fn_task_show",
        "fn_trait_list",
        "fn_update_identity",
        "fn_workflow_get",
        "fn_workflow_list",
        "fn_workflow_validate",
        "grep",
        "ls",
        "read",
      ]
    `);
  });

  it("classifies fn_ask_question in both gate source sets", () => {
    expect(READONLY_FN_TOOLS.has("fn_ask_question")).toBe(true);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_ask_question")).toBe(true);
  });

  it("ensures coordination exempt tools are recognized and allowed in permanent gating", () => {
    for (const toolName of COORDINATION_EXEMPT_TOOLS) {
      const classification = classifyPermanentAgentToolCall(toolName);
      const decision = resolvePermanentAgentToolDecision({
        toolName,
        gating: { permissionPolicy: blockedPolicy },
      });
      expect(classification.recognized).toBe(true);
      expect(decision.disposition).toBe("allow");
      expect(decision.category).toBe("none");
    }
  });

  it.each([...ACTION_MUTATION_PERMANENT_READONLY_TOOLS])("keeps action-mutating tool %s readonly in permanent gating", (toolName) => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: blockedPolicy })).toMatchObject({
      category: "task_agent_mutation",
      disposition: "block",
    });
    expect(resolvePermanentAgentToolDecision({ toolName, args: {}, gating: { permissionPolicy: blockedPolicy } })).toMatchObject({
      category: "none",
      disposition: "allow",
      recognized: true,
    });
  });

  it("governs fn_task_create as task_agent_mutation in both gate paths", () => {
    expect(READONLY_FN_TOOLS.has("fn_task_create")).toBe(false);
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_task_create")).toBe(true);
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_task_create")).toBe(true);
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_task_create")).toBe(true);
    expect(classifyPermanentAgentToolCall("fn_task_create")).toEqual({
      category: "task_agent_mutation",
      recognized: true,
    });

    for (const [permissionPolicy, disposition] of policyMatrix) {
      expect(resolvePermanentAgentToolDecision({
        toolName: "fn_task_create",
        args: {},
        gating: { permissionPolicy },
      })).toMatchObject({
        category: "task_agent_mutation",
        disposition,
        recognized: true,
      });
      expect(evaluateAgentActionGate({
        agentId: "a1",
        toolName: "fn_task_create",
        args: {},
        permissionPolicy,
      })).toMatchObject({
        category: "task_agent_mutation",
        disposition,
      });
    }
  });

  // FN-7728 (Surface Enumeration: gate paths): fn_task_bypass_review must classify as review_gate_bypass
  // identically in BOTH evaluateAgentActionGate and the permanent-agent gate, never task_agent_mutation,
  // never the unrecognized-tool exempt fallback, and honor allow/require-approval/block plus toolRules override.
  it("governs fn_task_bypass_review as review_gate_bypass in both gate paths, distinct from task_agent_mutation", () => {
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_task_bypass_review")).toBe(false);
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_task_bypass_review")).toBe(false);
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_task_bypass_review")).toBe(false);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_task_bypass_review")).toBe(false);
    expect(READONLY_FN_TOOLS.has("fn_task_bypass_review")).toBe(false);
    expect(classifyPermanentAgentToolCall("fn_task_bypass_review")).toEqual({
      category: "review_gate_bypass",
      recognized: true,
    });

    for (const [permissionPolicy, disposition] of policyMatrix) {
      expect(resolvePermanentAgentToolDecision({
        toolName: "fn_task_bypass_review",
        args: {},
        gating: { permissionPolicy },
      })).toMatchObject({
        category: "review_gate_bypass",
        disposition,
        recognized: true,
      });
      expect(evaluateAgentActionGate({
        agentId: "a1",
        toolName: "fn_task_bypass_review",
        args: {},
        permissionPolicy,
      })).toMatchObject({
        category: "review_gate_bypass",
        disposition,
      });
    }
  });

  it("applies exact tool overrides consistently for governed review-gate bypass", () => {
    const permissionPolicy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: {
        ...unrestrictedPolicy.rules,
        review_gate_bypass: "allow",
      },
      toolRules: { fn_task_bypass_review: "block" },
    };

    expect(resolvePermanentAgentToolDecision({
      toolName: "fn_task_bypass_review",
      args: {},
      gating: { permissionPolicy },
    })).toMatchObject({ category: "review_gate_bypass", disposition: "block", recognized: true });
    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_bypass_review",
      args: {},
      permissionPolicy,
    })).toMatchObject({ category: "review_gate_bypass", disposition: "block" });
  });

  // FN-7737 (Surface Enumeration: gate paths): fn_task_file_scope_add must classify as file_scope
  // identically in BOTH evaluateAgentActionGate and the permanent-agent gate, never task_agent_mutation
  // or file_write_delete, never the unrecognized-tool exempt fallback, and honor allow/require-approval/block
  // plus toolRules override.
  it("governs fn_task_file_scope_add as file_scope in both gate paths, distinct from task_agent_mutation/file_write_delete", () => {
    expect(TASK_AGENT_MUTATION_TOOLS.has("fn_task_file_scope_add")).toBe(false);
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has("fn_task_file_scope_add")).toBe(false);
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has("fn_task_file_scope_add")).toBe(false);
    expect(FILE_WRITE_DELETE_FN_TOOLS.has("fn_task_file_scope_add")).toBe(false);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_task_file_scope_add")).toBe(false);
    expect(READONLY_FN_TOOLS.has("fn_task_file_scope_add")).toBe(false);
    expect(FILE_SCOPE_FN_TOOLS.has("fn_task_file_scope_add")).toBe(true);
    expect(classifyPermanentAgentToolCall("fn_task_file_scope_add")).toEqual({
      category: "file_scope",
      recognized: true,
    });

    for (const [permissionPolicy, disposition] of policyMatrix) {
      expect(resolvePermanentAgentToolDecision({
        toolName: "fn_task_file_scope_add",
        args: {},
        gating: { permissionPolicy },
      })).toMatchObject({
        category: "file_scope",
        disposition,
        recognized: true,
      });
      expect(evaluateAgentActionGate({
        agentId: "a1",
        toolName: "fn_task_file_scope_add",
        args: {},
        permissionPolicy,
      })).toMatchObject({
        category: "file_scope",
        disposition,
      });
    }
  });

  it("applies exact tool overrides consistently for governed file_scope", () => {
    const permissionPolicy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: {
        ...unrestrictedPolicy.rules,
        file_scope: "allow",
      },
      toolRules: { fn_task_file_scope_add: "block" },
    };

    expect(resolvePermanentAgentToolDecision({
      toolName: "fn_task_file_scope_add",
      args: {},
      gating: { permissionPolicy },
    })).toMatchObject({ category: "file_scope", disposition: "block", recognized: true });
    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_file_scope_add",
      args: {},
      permissionPolicy,
    })).toMatchObject({ category: "file_scope", disposition: "block" });
  });

  it("applies exact tool overrides consistently for governed task creation", () => {
    const permissionPolicy: AgentPermissionPolicy = {
      ...unrestrictedPolicy,
      presetId: "custom",
      rules: {
        ...unrestrictedPolicy.rules,
        task_agent_mutation: "allow",
      },
      toolRules: { fn_task_create: "block" },
    };

    expect(resolvePermanentAgentToolDecision({
      toolName: "fn_task_create",
      args: {},
      gating: { permissionPolicy },
    })).toMatchObject({ category: "task_agent_mutation", disposition: "block", recognized: true });
    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_create",
      args: {},
      permissionPolicy,
    })).toMatchObject({ category: "task_agent_mutation", disposition: "block" });

    expect(resolvePermanentAgentToolDecision({
      toolName: "fn_task_update",
      args: {},
      gating: { permissionPolicy },
    })).toMatchObject({ category: "task_agent_mutation", disposition: "allow", recognized: true });
    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_update",
      args: {},
      permissionPolicy,
    })).toMatchObject({ category: "task_agent_mutation", disposition: "allow" });
  });

  it("keeps coordination-exempt tools allowed even when an exact rule is present", () => {
    const permissionPolicy: AgentPermissionPolicy = {
      ...blockedPolicy,
      toolRules: { fn_task_done: "block", fn_heartbeat_done: "block" },
    };

    expect(evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_done",
      args: {},
      permissionPolicy,
    })).toMatchObject({ category: "exempt", disposition: "allow" });
    expect(resolvePermanentAgentToolDecision({
      toolName: "fn_heartbeat_done",
      args: {},
      gating: { permissionPolicy },
    })).toMatchObject({ category: "none", disposition: "allow", recognized: true });
  });

  it.each(permanentReadonlySiblingTaskCreationTools)("keeps sibling task creation tool %s permanent-readonly", (toolName) => {
    expect(READONLY_FN_TOOLS.has(toolName)).toBe(true);
    expect(ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has(toolName)).toBe(true);
    expect(PERMANENT_AGENT_TASK_MUTATION_TOOLS.has(toolName)).toBe(false);
    expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category: "none", recognized: true });
    expect(resolvePermanentAgentToolDecision({ toolName, args: {}, gating: { permissionPolicy: blockedPolicy } })).toMatchObject({
      category: "none",
      disposition: "allow",
      recognized: true,
    });
  });

  it("includes goal retrieval tools on readonly path only", () => {
    expect(READONLY_FN_TOOLS.has("fn_goal_list")).toBe(true);
    expect(READONLY_FN_TOOLS.has("fn_goal_show")).toBe(true);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_goal_list")).toBe(true);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_goal_show")).toBe(true);
    expect(READONLY_FN_TOOLS.has("fn_goal_create")).toBe(false);
    expect(READONLY_FN_TOOLS.has("fn_goal_archive")).toBe(false);
  });

  it("classifies fn_web_fetch as network_api in both action and permanent sets", () => {
    expect(ACTION_GATE_NETWORK_API_TOOLS.has("fn_web_fetch")).toBe(true);
    expect(NETWORK_API_TOOLS.has("fn_web_fetch")).toBe(true);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_web_fetch")).toBe(false);
  });

  it("classifies worktrunk_install as network_api in both action and permanent sets", () => {
    expect(ACTION_GATE_NETWORK_API_TOOLS.has("worktrunk_install")).toBe(true);
    expect(NETWORK_API_TOOLS.has("worktrunk_install")).toBe(true);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("worktrunk_install")).toBe(false);
  });

  it.each(FN_7111_GOVERNED_TOOLS)("governs FN-7111 tool %s as %s across action policies", (toolName, category) => {
    expect(evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: unrestrictedPolicy })).toMatchObject({
      category,
      disposition: "allow",
    });
    expect(evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: approvalRequiredPolicy })).toMatchObject({
      category,
      disposition: "require-approval",
    });
    expect(evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: blockedPolicy })).toMatchObject({
      category,
      disposition: "block",
    });
  });

  it.each(FN_7111_GOVERNED_TOOLS)("blocks FN-7111 mutating tool %s under locked-down policy in both gate paths", (toolName, category) => {
    const action = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: blockedPolicy });
    const permanent = resolvePermanentAgentToolDecision({
      toolName,
      args: {},
      gating: { permissionPolicy: blockedPolicy },
    });

    expect(action).toMatchObject({ category, disposition: "block" });
    expect(permanent).toMatchObject({ category, disposition: "block", recognized: true });
  });

  it.each(["fn_workflow_list", "fn_workflow_get", "fn_workflow_validate", "fn_trait_list"] as const)("recognizes %s as read-only coordination instead of an unknown fallback", (toolName) => {
    const permanent = classifyPermanentAgentToolCall(toolName);
    const action = evaluateAgentActionGate({
      agentId: "a1",
      toolName,
      args: {},
      permissionPolicy: blockedPolicy,
    });

    expect(READONLY_FN_TOOLS.has(toolName)).toBe(true);
    expect(permanent).toEqual({ category: "none", recognized: true });
    expect(action).toMatchObject({ category: "exempt", disposition: "allow", operation: toolName });
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes(toolName)).toBe(true);
  });

  it.each(["fn_task_search", "fn_task_get", "fn_task_list", "fn_task_show"] as const)("classifies task read tool %s as read-only", (toolName) => {
    expect(READONLY_FN_TOOLS.has(toolName)).toBe(true);
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes(toolName)).toBe(true);
    expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category: "none", recognized: true });
    expect(evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: blockedPolicy })).toMatchObject({
      category: "exempt",
      disposition: "allow",
      operation: toolName,
    });
  });

  it("keeps fn_* category equivalence mappings across gates", () => {
    const fnTools = new Set<string>();
    for (const source of [
      READONLY_FN_TOOLS,
      TASK_AGENT_MUTATION_TOOLS,
      ACTION_GATE_NETWORK_API_TOOLS,
      FILE_WRITE_DELETE_FN_TOOLS,
      NETWORK_API_TOOLS,
      COMMAND_EXECUTION_FN_TOOLS,
    ]) {
      for (const toolName of source) {
        if (toolName.startsWith("fn_")) fnTools.add(toolName);
      }
    }

    for (const toolName of fnTools) {
      const action = evaluateAgentActionGate({
        agentId: "a1",
        toolName,
        args: {},
        permissionPolicy: blockedPolicy,
      });
      const permanent = classifyPermanentAgentToolCall(toolName);

      const actionKind = action.category === "task_agent_mutation"
        ? "mutating"
        : action.category === "network_api"
          ? "network"
          : action.category === "file_write_delete"
            ? "file-write"
            : action.category === "command_execution"
              ? "command"
              : "readonly";

      const permanentKind = permanent.category === "task_agent_mutation"
        ? "mutating"
        : permanent.category === "network_api"
          ? "network"
          : permanent.category === "file_write_delete"
            ? "file-write"
            : permanent.category === "command_execution"
              ? "command"
              : "readonly";

      if (COMMAND_EXECUTION_FN_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "command", permanentKind: "command" });
        continue;
      }
      if (FILE_WRITE_DELETE_FN_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "readonly", permanentKind: "file-write" });
        continue;
      }
      if (NETWORK_API_TOOLS.has(toolName) && !ACTION_GATE_NETWORK_API_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "readonly", permanentKind: "network" });
        continue;
      }
      if (TASK_AGENT_MUTATION_TOOLS.has(toolName) && !ACTION_GATE_TASK_AGENT_MANAGEMENT_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "readonly", permanentKind: "mutating" });
        continue;
      }
      if (ACTION_MUTATION_PERMANENT_READONLY_TOOLS.has(toolName)) {
        expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: "mutating", permanentKind: "readonly" });
        continue;
      }

      expect({ toolName, actionKind, permanentKind }).toEqual({ toolName, actionKind: permanentKind, permanentKind });
    }
  });

  it.each(gitCases)("classifyGitCommand handles %s", (command, write, operation) => {
    expect(classifyGitCommand(command)).toEqual({ write, operation });
  });

  it("classifyGitCommand returns null when no git command is present", () => {
    expect(classifyGitCommand("pnpm test")).toBeNull();
  });

  it.each(gitCases)("isGitWriteCommand agrees with classifyGitCommand for %s", (command) => {
    expect(isGitWriteCommand(command)).toBe(classifyGitCommand(command)?.write ?? false);
  });
});
