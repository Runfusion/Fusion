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
  evaluateReviewTaskBind,
  evaluateWakeCapabilityBind,
  hasWorkflowRoleCapability,
  isReviewOwnedTask,
} from "../agents/agent-role-policy.js";

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

  it("accepts a canonical multi-role executor regardless of legacy role projection", () => {
    const multiRoleAgent = { roles: ["reviewer", "executor"] as const, role: "reviewer" as const };
    expect(isExecutorRoleAgent(multiRoleAgent)).toBe(true);
    expect(canAgentTakeImplementationTaskForExplicitRouting(multiRoleAgent, { column: "todo" })).toBe(true);
    expect(canAgentTakeImplementationTaskForBacklogPickup(multiRoleAgent, { column: "todo" })).toBe(true);
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

/*
FNXC:LaneCapabilityVocabulary 2026-09-26-18:46 (RUFU-272):
The renamed-board no-op closure at the predicate level. The defect: `isImplementationTask` answered by
legacy-id membership alone, so on a board naming its lanes `backlog`/`building` every agent read as
bind-compatible with every task. The fix threads an OPTIONAL caller-resolved lane set through every
policy surface. These cases pin the three contract properties: (1) omitted = legacy behavior unchanged,
(2) supplied = the renamed lane becomes admission-bearing, (3) supplied NEVER SUBTRACTS — the legacy
four stay implementation-class regardless of what the resolved set contains.
*/
describe("resolved implementation-column vocabulary (RUFU-272)", () => {
  const executor = { id: "a-exec", role: "executor" as const };
  const custom = { id: "a-custom", role: "custom" as const };
  const renamedTask = { id: "FN-9", column: "building" as const };
  const legacyTask = { id: "FN-1", column: "todo" as const };
  const resolved = new Set(["backlog", "building"]);

  it("omitting the resolved set keeps legacy-only classification byte-for-byte", () => {
    expect(isImplementationTask(renamedTask)).toBe(false);
    expect(evaluateImplementationTaskBind(custom, renamedTask, { explicitRouting: true }).allowed).toBe(true);
    expect(canAgentTakeImplementationTaskForExplicitRouting(custom, renamedTask)).toBe(true);
    expect(canAgentTakeImplementationTaskForBacklogPickup(custom, renamedTask)).toBe(true);
  });

  it("a supplied set makes the renamed lane admission-bearing", () => {
    expect(isImplementationTask(renamedTask, resolved)).toBe(true);
    expect(evaluateImplementationTaskBind(custom, renamedTask, { explicitRouting: true, implementationColumns: resolved }).allowed).toBe(false);
    expect(canAgentTakeImplementationTaskForExplicitRouting(custom, renamedTask, resolved)).toBe(false);
    expect(canAgentTakeImplementationTaskForBacklogPickup(custom, renamedTask, { implementationColumns: resolved })).toBe(false);
    // A capable agent still passes on the renamed lane.
    expect(evaluateImplementationTaskBind(executor, renamedTask, { explicitRouting: true, implementationColumns: resolved }).allowed).toBe(true);
  });

  it("the supplied set never subtracts legacy columns (union-with-legacy contract)", () => {
    // Resolved set deliberately OMITS `todo` (e.g. an IR whose hold lane is named differently).
    expect(isImplementationTask(legacyTask, resolved)).toBe(true);
    expect(evaluateImplementationTaskBind(custom, legacyTask, { explicitRouting: true, implementationColumns: resolved }).allowed).toBe(false);
    // And an empty resolved set (trait-less v1-upgrade IR) behaves exactly like omitting it.
    expect(isImplementationTask(legacyTask, new Set())).toBe(true);
    expect(isImplementationTask(renamedTask, new Set())).toBe(false);
  });

  it("policy 'none' still refuses on a renamed lane once the vocabulary is resolved", () => {
    const liaisonNone = { id: "a-liaison", role: "executor" as const, runtimeConfig: { assignmentPolicy: "none" } };
    expect(evaluateImplementationTaskBind(liaisonNone, renamedTask, { explicitRouting: true, implementationColumns: resolved }).allowed).toBe(false);
    expect(evaluateImplementationTaskBind(liaisonNone, renamedTask, { explicitRouting: true }).allowed).toBe(true);
  });
});

/*
FNXC:LaneCapabilityWake 2026-10-22-15:55 (RUFU-766):
RUFU-682 added `reviewer` to `REVIEW_AUTOMATION_ROLES` and declared review to be reviewer work, but left every
wake path scoring a review-lane card with the implementation bar — and `in-review` is deliberately
implementation-class, because that is what stops a liaison lane from claiming review work. So the review was
"reviewer work" only in prose: on rtm3 all three projects had exactly one lane, tagged `reviewer` only, and every
wake that ran the review refused the lane for lacking `executor` (KUBE-027/182/185/187), then RUFU-682 made that
refusal durable. The bar now follows the wake's declared purpose.
*/
describe("wake-purpose capability binding (review vs implementation)", () => {
  const reviewerOnly = { id: "a-rev", role: "reviewer" as const, roles: ["reviewer"] as never, runtimeConfig: { assignmentPolicy: "none" } };
  const executorOnly = { id: "a-exec", role: "executor" as const, roles: ["executor"] as never, runtimeConfig: { assignmentPolicy: "auto" } };
  const engineerReviewer = { id: "a-eng", role: "reviewer" as const, roles: ["reviewer", "engineer"] as never, runtimeConfig: { assignmentPolicy: "auto" } };
  const reviewCard = { id: "KUBE-027", column: "in-review" };

  it("the card is implementation-class by lane vocabulary and review-owned by workflow — both at once", () => {
    expect(isImplementationTask(reviewCard)).toBe(true);
    expect(isReviewOwnedTask(reviewCard, "in-review")).toBe(true);
  });

  it("review purpose admits a reviewer-only lane even at assignmentPolicy 'none'", () => {
    expect(evaluateWakeCapabilityBind(reviewerOnly as never, reviewCard, { purpose: "review", reviewColumn: "in-review" }).allowed).toBe(true);
    expect(evaluateWakeCapabilityBind(engineerReviewer as never, reviewCard, { purpose: "review", reviewColumn: "in-review" }).allowed).toBe(true);
  });

  it("review purpose refuses a lane with no `reviewer` tag — the bucket stays honest", () => {
    expect(evaluateWakeCapabilityBind(executorOnly as never, reviewCard, { purpose: "review", reviewColumn: "in-review" }).allowed).toBe(false);
    expect(hasWorkflowRoleCapability(executorOnly as never, "reviewer")).toBe(false);
    expect(hasWorkflowRoleCapability(reviewerOnly as never, "reviewer")).toBe(true);
  });

  it("implementation purpose is byte-for-byte the old verdict", () => {
    const before = evaluateImplementationTaskBind(reviewerOnly as never, reviewCard, { explicitRouting: true });
    const after = evaluateWakeCapabilityBind(reviewerOnly as never, reviewCard, { purpose: "implementation", reviewColumn: "in-review", explicitRouting: true });
    expect(after).toEqual(before);
    expect(after.allowed).toBe(false);
  });

  it("an unresolvable review lane fails closed to the implementation bar", () => {
    expect(evaluateWakeCapabilityBind(reviewerOnly as never, reviewCard, { purpose: "review", reviewColumn: undefined }).allowed).toBe(false);
    expect(evaluateWakeCapabilityBind(reviewerOnly as never, reviewCard, { purpose: "review", reviewColumn: null }).allowed).toBe(false);
    // A renamed board resolves its own lane name — the check is equality, not the legacy literal.
    expect(evaluateWakeCapabilityBind(reviewerOnly as never, { id: "X", column: "qa-acceptance" }, { purpose: "review", reviewColumn: "qa-acceptance" }).allowed).toBe(true);
  });

  it("review purpose never leaks into a non-review-owned card", () => {
    expect(evaluateWakeCapabilityBind(reviewerOnly as never, { id: "X", column: "in-progress" }, { purpose: "review", reviewColumn: "in-review" }).allowed).toBe(false);
  });
});
