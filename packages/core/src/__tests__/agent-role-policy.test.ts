import { describe, expect, it } from "vitest";
import {
  AgentTaskRoutingPolicyError,
  assertImplementationTaskBindAllowed,
  canAgentReceiveImplementationTasks,
  canAgentTakeImplementationTask,
  canAgentTakeImplementationTaskForBacklogPickup,
  canAgentTakeImplementationTaskForExplicitRouting,
  evaluateImplementationTaskBind,
  formatRoleMismatchReason,
  getAgentAssignmentPolicy,
  isAgentAutoAssignable,
  isEngineerRoleAgent,
  isExecutorRoleAgent,
  isImplementationTask,
} from "../agent-role-policy.js";

describe("agent-role-policy", () => {
  it("treats triage/todo/in-progress/in-review as implementation tasks", () => {
    expect(isImplementationTask({ column: "triage" })).toBe(true);
    expect(isImplementationTask({ column: "todo" })).toBe(true);
    expect(isImplementationTask({ column: "in-progress" })).toBe(true);
    expect(isImplementationTask({ column: "in-review" })).toBe(true);
  });

  it("does not treat done/archived as implementation tasks", () => {
    expect(isImplementationTask({ column: "done" })).toBe(false);
    expect(isImplementationTask({ column: "archived" })).toBe(false);
  });

  it("allows executor agents in both explicit routing and backlog pickup", () => {
    expect(isExecutorRoleAgent({ role: "executor" })).toBe(true);
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "executor" }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "executor" }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "executor" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTask({ role: "executor" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
  });

  it("allows durable engineer for explicit routing and opt-in backlog pickup only", () => {
    expect(isEngineerRoleAgent({ role: "engineer" })).toBe(true);
    // Explicit routing is independent from engineerBacklogAutoClaim: callers
    // pass this setting only to backlog pickup, never assignment/delegation.
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "engineer", runtimeConfig: { engineerBacklogAutoClaim: false } }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "engineer", runtimeConfig: { engineerBacklogAutoClaim: true } }, { column: "todo" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "engineer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTask({ role: "engineer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "engineer" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTask({ role: "engineer" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(true);
  });

  it("keeps reviewer and custom roles blocked from backlog pickup even when engineers opt in", () => {
    expect(isExecutorRoleAgent({ role: "reviewer" })).toBe(false);
    expect(
      canAgentTakeImplementationTaskForExplicitRouting({ role: "reviewer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "reviewer" }, { column: "todo" }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "reviewer" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(false);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "custom" }, { column: "todo" }, { allowEngineer: true }),
    ).toBe(false);
  });

  it("does not gate non-implementation columns by role", () => {
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "reviewer" }, { column: "done" }),
    ).toBe(true);
    expect(
      canAgentTakeImplementationTaskForBacklogPickup({ role: "custom" }, { column: "archived" }, { allowEngineer: true }),
    ).toBe(true);
  });

  it("formats mismatch reason with agent/task details", () => {
    const reason = formatRoleMismatchReason(
      { id: "agent-1", role: "reviewer" },
      { id: "FN-123", column: "todo" },
    );
    expect(reason).toContain("agent-1");
    expect(reason).toContain("reviewer");
    expect(reason).toContain("FN-123");
    expect(reason).toContain("requires an \"executor\"-role agent by default");
    expect(reason).toContain("durable \"engineer\" supported only for explicit routing");
  });
});

/*
FNXC:AgentRouting 2026-07-12-12:40:
Issue #2015 regression matrix: an executor-ROLE liaison agent must be excludable from every routing path via
runtimeConfig.assignmentPolicy, and "none" must not be defeatable by executorRoleOverride.
*/
describe("agent assignment policy (issue #2015)", () => {
  const executor = { id: "a-exec", role: "executor" as const };
  const liaisonNone = { id: "a-liaison", role: "executor" as const, runtimeConfig: { assignmentPolicy: "none" } };
  const explicitOnly = { id: "a-explicit", role: "executor" as const, runtimeConfig: { assignmentPolicy: "explicit-only" } };
  const todoTask = { id: "FN-1", column: "todo" as const };
  const doneTask = { id: "FN-2", column: "done" as const };

  it("defaults to auto and parses configured values", () => {
    expect(getAgentAssignmentPolicy(executor)).toBe("auto");
    expect(getAgentAssignmentPolicy({ runtimeConfig: {} })).toBe("auto");
    expect(getAgentAssignmentPolicy({ runtimeConfig: { assignmentPolicy: "bogus" } })).toBe("auto");
    expect(getAgentAssignmentPolicy(liaisonNone)).toBe("none");
    expect(getAgentAssignmentPolicy(explicitOnly)).toBe("explicit-only");
    expect(isAgentAutoAssignable(executor)).toBe(true);
    expect(isAgentAutoAssignable(explicitOnly)).toBe(false);
    expect(isAgentAutoAssignable(liaisonNone)).toBe(false);
    expect(canAgentReceiveImplementationTasks(executor)).toBe(true);
    expect(canAgentReceiveImplementationTasks(explicitOnly)).toBe(true);
    expect(canAgentReceiveImplementationTasks(liaisonNone)).toBe(false);
  });

  it("policy 'none' blocks implementation tasks on every path, including overrides", () => {
    expect(canAgentTakeImplementationTaskForExplicitRouting(liaisonNone, todoTask)).toBe(false);
    expect(canAgentTakeImplementationTask(liaisonNone, todoTask)).toBe(false);
    expect(evaluateImplementationTaskBind(liaisonNone, todoTask, { explicitRouting: true }).allowed).toBe(false);
    expect(evaluateImplementationTaskBind(liaisonNone, todoTask, { explicitRouting: true, executorRoleOverride: true }).allowed).toBe(false);
    expect(evaluateImplementationTaskBind(liaisonNone, todoTask, { executorRoleOverride: true }).allowed).toBe(false);
    expect(() => assertImplementationTaskBindAllowed(liaisonNone, todoTask, { explicitRouting: true, executorRoleOverride: true }))
      .toThrow(AgentTaskRoutingPolicyError);
  });

  it("policy 'explicit-only' blocks automatic routing but allows explicit routing", () => {
    expect(canAgentTakeImplementationTask(explicitOnly, todoTask)).toBe(false);
    expect(canAgentTakeImplementationTaskForBacklogPickup(explicitOnly, todoTask, { allowEngineer: true })).toBe(false);
    expect(evaluateImplementationTaskBind(explicitOnly, todoTask, {}).allowed).toBe(false);
    expect(canAgentTakeImplementationTaskForExplicitRouting(explicitOnly, todoTask)).toBe(true);
    expect(evaluateImplementationTaskBind(explicitOnly, todoTask, { explicitRouting: true }).allowed).toBe(true);
  });

  it("policy never gates non-implementation columns", () => {
    expect(evaluateImplementationTaskBind(liaisonNone, doneTask, {}).allowed).toBe(true);
    expect(canAgentTakeImplementationTask(liaisonNone, doneTask)).toBe(true);
  });

  it("evaluator preserves role semantics for auto-policy agents", () => {
    expect(evaluateImplementationTaskBind(executor, todoTask, {}).allowed).toBe(true);
    expect(evaluateImplementationTaskBind({ id: "a-cust", role: "custom" }, todoTask, { explicitRouting: true }).allowed).toBe(false);
    expect(evaluateImplementationTaskBind({ id: "a-cust", role: "custom" }, todoTask, { explicitRouting: true, executorRoleOverride: true }).allowed).toBe(true);
    expect(evaluateImplementationTaskBind({ id: "a-eng", role: "engineer" }, todoTask, { explicitRouting: true }).allowed).toBe(true);
    expect(evaluateImplementationTaskBind({ id: "a-eng", role: "engineer" }, todoTask, {}).allowed).toBe(false);
    expect(evaluateImplementationTaskBind({ id: "a-eng", role: "engineer" }, todoTask, { allowEngineer: true }).allowed).toBe(true);
  });

  it("mismatch reason names the policy when it is the blocker", () => {
    const reason = formatRoleMismatchReason(liaisonNone, todoTask);
    expect(reason).toContain("assignmentPolicy \"none\"");
    expect(formatRoleMismatchReason(explicitOnly, todoTask)).toContain("explicit routing only");
  });
});
