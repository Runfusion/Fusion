import type { AgentPermissionPolicy } from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  buildAgentGatedActionSummary,
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

  it.each(["fn_workflow_list", "fn_workflow_get", "fn_workflow_validate", "fn_trait_list"] as const)("classifies %s as recognized readonly", (toolName) => {
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

  // FN-7728: fn_task_bypass_review must classify identically here (review_gate_bypass) as in
  // agent-action-gate.ts's evaluateAgentActionGate, and must never fall through to task_agent_mutation
  // or the unrecognized-tool "none"/require-approval fallback.
  it("classifies fn_task_bypass_review as review_gate_bypass, distinct from task_agent_mutation", () => {
    expect(classifyPermanentAgentToolCall("fn_task_bypass_review")).toEqual({ category: "review_gate_bypass", recognized: true });
  });

  it.each([
    ["allow" as const, "allow" as const],
    ["require-approval" as const, "require-approval" as const],
    ["block" as const, "block" as const],
  ])("honors review_gate_bypass disposition %s for fn_task_bypass_review", (ruleDisposition, expectedDisposition) => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_bypass_review",
      gating: {
        permissionPolicy: {
          presetId: "custom",
          rules: { review_gate_bypass: ruleDisposition },
        },
      },
    });
    expect(decision).toMatchObject({ category: "review_gate_bypass", recognized: true, disposition: expectedDisposition });
  });

  it("lets an exact toolRules.fn_task_bypass_review override win over the review_gate_bypass category rule", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_bypass_review",
      gating: {
        permissionPolicy: {
          presetId: "custom",
          rules: { review_gate_bypass: "block" },
          toolRules: { fn_task_bypass_review: "allow" },
        },
      },
    });
    expect(decision).toMatchObject({ category: "review_gate_bypass", recognized: true, disposition: "allow" });
  });

  // FN-7737: fn_task_file_scope_add must classify identically here (file_scope) as in
  // agent-action-gate.ts's evaluateAgentActionGate, and must never fall through to task_agent_mutation
  // or the unrecognized-tool "none" fallback.
  it("classifies fn_task_file_scope_add as file_scope, distinct from task_agent_mutation", () => {
    expect(classifyPermanentAgentToolCall("fn_task_file_scope_add")).toEqual({ category: "file_scope", recognized: true });
  });

  it.each([
    ["allow" as const, "allow" as const],
    ["require-approval" as const, "require-approval" as const],
    ["block" as const, "block" as const],
  ])("honors file_scope disposition %s for fn_task_file_scope_add", (ruleDisposition, expectedDisposition) => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_file_scope_add",
      gating: {
        permissionPolicy: {
          presetId: "custom",
          rules: { file_scope: ruleDisposition },
        },
      },
    });
    expect(decision).toMatchObject({ category: "file_scope", recognized: true, disposition: expectedDisposition });
  });

  it("lets an exact toolRules.fn_task_file_scope_add override win over the file_scope category rule", () => {
    const decision = resolvePermanentAgentToolDecision({
      toolName: "fn_task_file_scope_add",
      gating: {
        permissionPolicy: {
          presetId: "custom",
          rules: { file_scope: "block" },
          toolRules: { fn_task_file_scope_add: "allow" },
        },
      },
    });
    expect(decision).toMatchObject({ category: "file_scope", recognized: true, disposition: "allow" });
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

// FN-7609: approval cards must show the real gated payload instead of a
// generic "Agent gated action for <tool>" placeholder.
describe("buildAgentGatedActionSummary", () => {
  it("renders the trimmed shell command for bash calls", () => {
    expect(buildAgentGatedActionSummary("bash", { command: "  pnpm test --run  " })).toBe("Run: pnpm test --run");
  });

  it("truncates very long shell commands to a sane cap", () => {
    const longCommand = `echo ${"x".repeat(300)}`;
    const summary = buildAgentGatedActionSummary("bash", { command: longCommand });
    expect(summary.startsWith("Run: echo ")).toBe(true);
    expect(summary.length).toBeLessThanOrEqual(210);
    expect(summary.endsWith("\u2026")).toBe(true);
  });

  it("renders a compact args summary for fn_* tools", () => {
    const summary = buildAgentGatedActionSummary("fn_task_update", { id: "FN-1", status: "done" });
    expect(summary).toBe("fn_task_update {id: FN-1, status: done}");
  });

  it("falls back to a generic summary when no args are meaningful", () => {
    expect(buildAgentGatedActionSummary("fn_task_list", {})).toBe("Agent gated action for fn_task_list");
    expect(buildAgentGatedActionSummary("fn_task_list", undefined)).toBe("Agent gated action for fn_task_list");
  });

  it("falls back to a generic summary for bash calls with no command", () => {
    expect(buildAgentGatedActionSummary("bash", {})).toBe("Agent gated action for bash");
  });
});
