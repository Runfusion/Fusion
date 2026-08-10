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

Invariant under test: a built-in workflow role owner is always routable. It is coerced back to routable at the
durable write seam, so no caller — REST, dashboard toggle, plugin, provisioning, config restore — can put the
system into the deadlocked state; and the static routability predicate is SHARED with the router so
"what provisioning produces" and "what routing accepts" cannot drift apart again.
*/
import { describe, expect, it } from "vitest";
import {
  enforceBuiltinWorkflowRoleRoutability,
  isBuiltinWorkflowRoleAgent,
  isWorkflowPrincipalEligible,
} from "../agent-role-policy.js";

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
  it("coerces a disabled built-in owner back to routable", () => {
    const result = enforceBuiltinWorkflowRoleRoutability(builtIn({ enabled: false }));
    expect(result.runtimeConfig).toMatchObject({ enabled: true });
    expect(isWorkflowPrincipalEligible(result)).toBe(true);
  });

  it("preserves every other runtimeConfig key while coercing", () => {
    // The operator's heartbeat cadence and claim policy are theirs; only routability is non-negotiable.
    const result = enforceBuiltinWorkflowRoleRoutability(
      builtIn({ enabled: false, heartbeatIntervalMs: 3_600_000, autoClaimRelevantTasks: true }),
    );
    expect(result.runtimeConfig).toEqual({
      enabled: true,
      heartbeatIntervalMs: 3_600_000,
      autoClaimRelevantTasks: true,
    });
  });

  it("leaves an operator-owned agent free to be disabled", () => {
    // The invariant protects the engine's own principals, not every agent — operators keep their off switch.
    const result = enforceBuiltinWorkflowRoleRoutability(operatorOwned({ enabled: false }));
    expect(result.runtimeConfig).toMatchObject({ enabled: false });
    expect(isWorkflowPrincipalEligible(result)).toBe(false);
    expect(isBuiltinWorkflowRoleAgent(result)).toBe(false);
  });

  it("is a no-op for an already-routable built-in owner (same reference, no churn)", () => {
    const agent = builtIn({ enabled: true });
    expect(enforceBuiltinWorkflowRoleRoutability(agent)).toBe(agent);
    const unset = builtIn();
    expect(enforceBuiltinWorkflowRoleRoutability(unset)).toBe(unset);
  });

  /*
  The predicate the router consults. `enabled === false` was the exact bit that made the pool look exhausted;
  paused/errored agents must stay excluded so the coercion never resurrects a genuinely broken principal.
  */
  it("still excludes paused and errored agents from principal routing", () => {
    expect(isWorkflowPrincipalEligible({ runtimeConfig: { enabled: true }, state: "paused" })).toBe(false);
    expect(isWorkflowPrincipalEligible({ runtimeConfig: { enabled: true }, state: "error" })).toBe(false);
    expect(isWorkflowPrincipalEligible({ runtimeConfig: { enabled: true }, state: "active" })).toBe(true);
    // An unset runtimeConfig is routable: only an explicit `false` opts an agent out.
    expect(isWorkflowPrincipalEligible({ state: "active" })).toBe(true);
  });
});
