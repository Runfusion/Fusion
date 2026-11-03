/**
 * RUFU-281 acceptance: target resolution must not smuggle a permission change.
 *
 * FNXC:CrossCardWriteAuth 2026-09-23-22:56:
 * Three of these tools gained the ability to write a card other than the session's own, which is a wider
 * reach than they had. The sanction for that reach is the read side's already-agreed boundary (RUFU-204 gave
 * `fn_task_logs_read` the same cross-card reach), not a new gate — so the classification each lane computes
 * has to be identical with and without a foreign `task_id` in the arguments. This test pins that equality per
 * tool and per lane, because a silent reclassification would be a permission change nobody approved.
 */
import { describe, expect, it } from "vitest";
import { evaluateAgentActionGate } from "../agents/agent-action-gate.js";
import { classifyPermanentAgentToolCall, resolvePermanentAgentToolDecision } from "../agents/permanent-agent-gating.js";
import { COORDINATION_EXEMPT_TOOLS, READONLY_FN_TOOLS } from "../execution/gating-classifications.js";
import type { AgentPermissionPolicy } from "@fusion/core";

const BOUND = "RUFU-269";
const OTHER = "RUFU-275";

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

/** Tools whose cross-card reach this task changed, plus the refuses trio that already had an ambient card. */
const TOOLS = [
  "fn_task_log",
  "fn_task_document_write",
  "fn_task_prompt_write",
  "fn_task_file_scope_add",
  "fn_task_update",
] as const;

describe("write-target resolution leaves gating classifications untouched", () => {
  it.each(TOOLS)("%s gets the same session-lane classification with or without a foreign task_id", (toolName) => {
    const withoutTarget = evaluateAgentActionGate({ agentId: "a1", toolName, args: {}, permissionPolicy: approvalRequiredPolicy });
    const withForeignTarget = evaluateAgentActionGate({
      agentId: "a1",
      toolName,
      args: { task_id: OTHER },
      permissionPolicy: approvalRequiredPolicy,
    });
    // Classification is what a permission change would show up in. `resourceId` is deliberately excluded:
    // the gate already names the target card per invocation for task-management tools (approval dedupe must
    // not let an approval for card A cover card B), so a differing resourceId is the pre-existing identity
    // rule doing its job, not a new grant.
    const classification = (decision: Record<string, unknown>) => ({
      category: decision.category,
      disposition: decision.disposition,
      operation: decision.operation,
      resourceType: decision.resourceType,
    });
    expect(classification(withForeignTarget as Record<string, unknown>), toolName)
      .toEqual(classification(withoutTarget as Record<string, unknown>));
  });

  it("keeps a task-management tool's per-target approval identity intact", () => {
    // A mutation that names a card is identified by that card, so an approval granted for one card cannot
    // silently authorise another. RUFU-281 had to preserve this, because refusing/honouring a target is
    // worthless if the gate then treats the write as the session's own card.
    const named = evaluateAgentActionGate({
      agentId: "a1",
      toolName: "fn_task_update",
      args: { task_id: OTHER },
      permissionPolicy: approvalRequiredPolicy,
    }) as Record<string, unknown>;
    expect(named).toMatchObject({ category: "task_agent_mutation", resourceType: "task", resourceId: OTHER });
  });

  it.each(TOOLS)("%s gets the same permanent-agent decision with or without a foreign task_id", (toolName) => {
    const withoutTarget = resolvePermanentAgentToolDecision({
      toolName,
      args: {},
      gating: { permissionPolicy: approvalRequiredPolicy },
    });
    const withForeignTarget = resolvePermanentAgentToolDecision({
      toolName,
      args: { task_id: OTHER },
      gating: { permissionPolicy: approvalRequiredPolicy },
    });
    expect(withForeignTarget).toEqual(withoutTarget);
    expect(classifyPermanentAgentToolCall(toolName)).toEqual(classifyPermanentAgentToolCall(toolName));
  });

  it("keeps the widened tools in the same classification sets they were in before", () => {
    // The two tools that gained cross-card write reach stay coordination-exempt: the reach is the read
    // side's sanctioned boundary, not a new mutation surface.
    for (const toolName of ["fn_task_log", "fn_task_document_write"]) {
      expect(READONLY_FN_TOOLS.has(toolName), toolName).toBe(true);
      expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes(toolName), toolName).toBe(true);
      expect(classifyPermanentAgentToolCall(toolName)).toEqual({ category: "none", recognized: true });
    }
    // A file-scope write stays gated exactly as it was; the seam did not relax it.
    expect((COORDINATION_EXEMPT_TOOLS as readonly string[]).includes("fn_task_file_scope_add")).toBe(false);
  });

  it("does not make the refusal look like a gate decision", async () => {
    // The refusal is a tool-result contract, not an approval prompt: it carries the write-target detail
    // namespace, so a caller cannot mistake it for an approval request.
    const { guardBoundWriteTarget } = await import("../task-write-target.js");
    const refusal = guardBoundWriteTarget(BOUND, { task_id: OTHER }, "fn_task_log");
    expect(refusal?.isError).toBe(true);
    expect(refusal?.details).toMatchObject({ writeTarget: "refused" });
    expect(refusal?.details).not.toHaveProperty("approval");
  });
});
