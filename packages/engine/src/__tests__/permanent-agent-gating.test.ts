import type { AgentPermissionPolicy } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  classifyPermanentAgentToolCall,
  resolvePermanentAgentToolDecision,
} from "../permanent-agent-gating.js";

const unrestrictedPolicy: AgentPermissionPolicy = {
  presetId: "unrestricted",
  rules: {
    git_write: "allow",
    file_write_delete: "allow",
    command_execution: "allow",
    network_api: "allow",
    task_agent_mutation: "allow",
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

const FN_3548_COORDINATION_TOOLS = [
  "fn_heartbeat_done",
  "fn_task_log",
  "fn_task_document_write",
  "fn_task_document_read",
  "fn_artifact_register",
  "fn_artifact_list",
  "fn_artifact_view",
  "fn_delegate_task",
  "fn_list_agents",
  "fn_agent_show",
  "fn_agent_org_chart",
  "fn_ask_question",
  "fn_send_message",
  "fn_read_messages",
  "fn_post_room_message",
  "fn_memory_search",
  "fn_memory_get",
  "fn_memory_append",
  "fn_read_evaluations",
  "fn_update_identity",
  "fn_reflect_on_performance",
] as const;

describe("permanent-agent-gating", () => {
  it("classifies builtin coding tools", () => {
    expect(classifyPermanentAgentToolCall("write").category).toBe("file_write_delete");
    expect(classifyPermanentAgentToolCall("edit").category).toBe("file_write_delete");
    expect(classifyPermanentAgentToolCall("read").category).toBe("none");
    expect(classifyPermanentAgentToolCall("grep").category).toBe("none");
    expect(classifyPermanentAgentToolCall("bash", { command: "echo hi" }).category).toBe("command_execution");
    expect(classifyPermanentAgentToolCall("bash", { command: "git commit -m test" }).category).toBe("git_write");
  });

  it("classifies shared fn tools by behavior", () => {
    expect(classifyPermanentAgentToolCall("fn_task_create").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_delegate_task").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_update_agent_config").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_task_import_github").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_task_import_github_issue").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_update_identity").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_task_document_write").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_artifact_register").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_artifact_list").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_artifact_view").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_memory_append").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_research_run").category).toBe("network_api");
    expect(classifyPermanentAgentToolCall("fn_research_cancel").category).toBe("network_api");
    expect(classifyPermanentAgentToolCall("worktrunk_install").category).toBe("network_api");
    expect(classifyPermanentAgentToolCall("fn_task_update").category).toBe("task_agent_mutation");
    expect(classifyPermanentAgentToolCall("fn_task_show").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_research_get").category).toBe("none");
    expect(classifyPermanentAgentToolCall("fn_heartbeat_done")).toEqual({ category: "none", recognized: true });
    expect(classifyPermanentAgentToolCall("fn_ask_question")).toEqual({ category: "none", recognized: true });
    expect(classifyPermanentAgentToolCall("fn_send_message")).toEqual({ category: "none", recognized: true });
    expect(classifyPermanentAgentToolCall("fn_read_messages")).toEqual({ category: "none", recognized: true });
  });

  it.each(FN_7111_GOVERNED_TOOLS)("classifies FN-7111 governed tool %s as recognized %s", (toolName, category) => {
    expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category, recognized: true });
  });

  it.each(FN_7111_GOVERNED_TOOLS)("blocks FN-7111 governed tool %s under locked-down policy", (toolName, category) => {
    const decision = resolvePermanentAgentToolDecision({
      toolName,
      gating: {
        permissionPolicy: {
          presetId: "locked-down",
          rules: {
            git_write: "block",
            file_write_delete: "block",
            command_execution: "block",
            network_api: "block",
            task_agent_mutation: "block",
          },
        },
      },
    });

    expect(decision).toMatchObject({ category, recognized: true, disposition: "block" });
  });

  it.each(["fn_workflow_list", "fn_workflow_get", "fn_trait_list"] as const)("classifies %s as recognized readonly", (toolName) => {
    expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category: "none", recognized: true });
  });

  it("uses only canonical action-category names", () => {
    const categories = [
      classifyPermanentAgentToolCall("bash", { command: "git commit -m x" }).category,
      classifyPermanentAgentToolCall("write").category,
      classifyPermanentAgentToolCall("bash", { command: "echo hi" }).category,
      classifyPermanentAgentToolCall("fn_research_run").category,
      classifyPermanentAgentToolCall("fn_update_agent_config").category,
      classifyPermanentAgentToolCall("read").category,
    ];

    expect(new Set(categories)).toEqual(
      new Set(["git_write", "file_write_delete", "command_execution", "network_api", "task_agent_mutation", "none"]),
    );
  });

  it("uses unknown-tool fallback to approval-required", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "plugin_custom_tool",
      gating: {
        permissionPolicy: {
          presetId: "approval-required",
          rules: { command_execution: "block" },
        },
      },
    });

    expect(decision.category).toBe("none");
    expect(decision.recognized).toBe(false);
    expect(decision.disposition).toBe("require-approval");
  });

  it("allows recognized readonly heartbeat tools under permission policy", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_heartbeat_done",
      gating: {
        permissionPolicy: {
          presetId: "approval-required",
          rules: {},
        },
      },
    });

    expect(decision.disposition).toBe("allow");
  });

  it.each([unrestrictedPolicy, approvalRequiredPolicy, blockedPolicy])(
    "allows fn_ask_question under %s permanent-agent policy",
    (permissionPolicy) => {
      expect(resolvePermanentAgentToolDecision({
        toolName: "fn_ask_question",
        gating: { permissionPolicy },
      })).toMatchObject({
        category: "none",
        disposition: "allow",
        recognized: true,
      });
    },
  );

  it.each(FN_3548_COORDINATION_TOOLS)("classifies FN-3548 coordination tool %s as recognized none", (toolName) => {
    expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category: "none", recognized: true });
  });

  it.each(FN_3548_COORDINATION_TOOLS)("allows FN-3548 coordination tool %s under locked-down policy", (toolName) => {
    const decision = resolvePermanentAgentToolDecision({
      toolName,
      gating: {
        permissionPolicy: {
          presetId: "locked-down",
          rules: {
            git_write: "block",
            file_write_delete: "block",
            command_execution: "block",
            network_api: "block",
            task_agent_mutation: "block",
          },
        },
      },
    });

    expect(decision.disposition).toBe("allow");
    expect(decision.category).toBe("none");
    expect(decision.recognized).toBe(true);
  });

  it("resolves disposition from policy for sensitive categories", () => {
    const blockDecision = resolvePermanentAgentToolDecision({
      toolName: "write",
      gating: {
        permissionPolicy: {
          presetId: "locked-down",
          rules: {
            file_write_delete: "block",
          },
        },
      },
    });
    expect(blockDecision.disposition).toBe("block");

    const approvalDecision = resolvePermanentAgentToolDecision({
      toolName: "fn_update_agent_config",
      gating: {
        permissionPolicy: {
          presetId: "approval-required",
          rules: {
            task_agent_mutation: "require-approval",
          },
        },
      },
    });
    expect(approvalDecision.disposition).toBe("require-approval");
  });
});
