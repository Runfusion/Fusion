/*
FNXC:WorkflowAgentRouting 2026-08-10-01:15 (a built-in workflow owner is never unroutable — regression):

Reported symptom: every task stopped moving. Work items churned `held → running → held` at ~3.5×/second across
the whole board, pinning a CPU core and writing ~19k `workflowWorkItem` audit rows/hour while ZERO work
executed. The hold reason was `workflow-principal-role-pool-exhausted:executor`.

Root cause: `provisionBuiltinWorkflowRoleAgents` seeded the four permanent workflow owners (triage, executor,
reviewer, merger) with `runtimeConfig: { enabled: false }`, while the router's `available()` treats
`enabled === false` as unavailable. The only permanent principals for every built-in role were therefore
unroutable BY CONSTRUCTION — a defect every fresh instance ships with, not a local misconfiguration. Nothing
recovers on its own, because the pool can only change through operator action.

First fix attempt made it worse in a different way: enabling the heartbeat to restore routing gave four agents
autonomous loops and auto-claiming nobody wanted. The real defect is that ONE flag answered two questions.

Invariant under test: `runtimeConfig.enabled` governs the durable heartbeat runtime ONLY, and a built-in
workflow role owner is routable regardless of it. So the built-ins keep heartbeats and auto-claim OFF — which
is what they should be, since the workflow engine invokes them — while every built-in role stays routable. The
predicate is SHARED with the router so "what provisioning produces" and "what routing accepts" cannot drift.
*/
import { describe, expect, it } from "vitest";
import { isBuiltinWorkflowRoleAgent, isWorkflowPrincipalEligible } from "../agent-role-policy.js";

const builtIn = (runtimeConfig?: Record<string, unknown>) => ({
  id: "agent-builtin",
  metadata: { builtInWorkflowRole: true, workflowRole: "executor" },
  runtimeConfig,
});

const operatorOwned = (runtimeConfig?: Record<string, unknown>) => ({
  id: "agent-operator",
  metadata: {},
  runtimeConfig,
});

describe("built-in workflow role routability invariant", () => {
  it("routes a built-in owner whose heartbeat runtime is off", () => {
    // The exact production state: heartbeat disabled (correct) must NOT mean unroutable.
    expect(isWorkflowPrincipalEligible(builtIn({ enabled: false }))).toBe(true);
    expect(isWorkflowPrincipalEligible(builtIn({ enabled: false, autoClaimRelevantTasks: false }))).toBe(true);
  });

  it("keeps the heartbeat flag meaning only 'run the autonomous loop'", () => {
    // Routability must not be achievable only by switching the heartbeat on — that regression gave four
    // agents autonomous loops and auto-claiming nobody asked for.
    const off = builtIn({ enabled: false });
    const on = builtIn({ enabled: true });
    expect(isWorkflowPrincipalEligible(off)).toBe(isWorkflowPrincipalEligible(on));
  });

  it("leaves an operator-owned agent unroutable when disabled", () => {
    // The structural exemption is scoped to the engine's own principals; operators keep their off switch.
    expect(isWorkflowPrincipalEligible(operatorOwned({ enabled: false }))).toBe(false);
    expect(isWorkflowPrincipalEligible(operatorOwned({ enabled: true }))).toBe(true);
    expect(isBuiltinWorkflowRoleAgent(operatorOwned())).toBe(false);
  });

  /*
  Paused/errored is a genuine unusability signal, so it outranks the built-in exemption — otherwise the
  exemption would resurrect a broken principal and route work into it.
  */
  it("still excludes paused and errored agents, including built-ins", () => {
    expect(isWorkflowPrincipalEligible({ ...builtIn({ enabled: false }), state: "paused" })).toBe(false);
    expect(isWorkflowPrincipalEligible({ ...builtIn({ enabled: false }), state: "error" })).toBe(false);
    expect(isWorkflowPrincipalEligible({ ...builtIn({ enabled: false }), state: "active" })).toBe(true);
    expect(isWorkflowPrincipalEligible({ ...operatorOwned(), state: "active" })).toBe(true);
  });
});
