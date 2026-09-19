/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage D):

Covers the one place in `@runfusion/fusion` where U18's conversion had to make a SECURITY decision
rather than a mechanical one: how the pi extension names the actor behind a store mutation.

Three outcomes, and the difference between the last two is the whole point of the unit:

  - an `agent` principal DERIVES a real actor, so the write is genuinely attributed;
  - an `operator` (or `unresolved`) principal takes the unattributed MARKER — "no actor assigned yet,
    U11 fills it in";
  - an `ambiguous` principal — two live agent sessions sharing one cwd — FAILS CLOSED. It must not
    take the marker: the marker means a later unit completes it, while ambiguity means there are two
    candidates and guessing between them would write an audit row naming an agent that may not have
    made the change. Filing it as ordinary deferred debt would also hide it from U11.

Negative coverage is deliberate and specific. Asserting only "ambiguous returns the ambiguous kind"
would still pass if the resolver ALSO handed back a usable context, so the test asserts the
resolution carries no `runContext` at all — there is nothing a caller could accidentally write with.
*/

import { describe, it, expect, afterEach } from "vitest";
import {
  registerFusionSessionIdentity,
  __clearFusionSessionIdentityRegistryForTests,
  UNATTRIBUTED_ACTOR_ID,
  AMBIGUOUS_ACTOR_ID,
  isReservedActorId,
} from "@fusion/core";
import { resolveExtensionMutationContext, ambiguousActorToolError } from "../extension.js";

const CWD = process.cwd();

afterEach(() => {
  __clearFusionSessionIdentityRegistryForTests();
});

describe("extension mutation-context resolution (U18)", () => {
  it("derives a real actor from an explicit agent principal, and carries the run id", () => {
    const resolved = resolveExtensionMutationContext({ cwd: CWD, agentId: "agent-7", runId: "run-42" });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.runContext.actor.actor.id).toBe("agent-7");
    expect(resolved.runContext.actor.actor.kind).toBe("agent");
    expect(resolved.runContext.agentId).toBe("agent-7");
    expect(resolved.runContext.runId).toBe("run-42");
    // A derived actor is NOT the marker; conflating them is what would make the census lie.
    expect(resolved.runContext.actor.actor.id).not.toBe(UNATTRIBUTED_ACTOR_ID);
  });

  it("derives a real actor from a single registered session in the cwd", () => {
    const dispose = registerFusionSessionIdentity(CWD, { agentId: "agent-registry", taskId: "FN-1" });
    try {
      const resolved = resolveExtensionMutationContext({ cwd: CWD });
      expect(resolved.kind).toBe("resolved");
      if (resolved.kind !== "resolved") return;
      expect(resolved.runContext.actor.actor.id).toBe("agent-registry");
    } finally {
      dispose();
    }
  });

  it("takes the unattributed marker for an operator caller, never the bootstrap actor", async () => {
    const { BOOTSTRAP_ACTOR_ID } = await import("@fusion/core");
    const resolved = resolveExtensionMutationContext({ cwd: CWD });
    expect(resolved.kind).toBe("resolved");
    if (resolved.kind !== "resolved") return;
    expect(resolved.runContext.actor.actor.id).toBe(UNATTRIBUTED_ACTOR_ID);
    /*
    Bootstrap means "written while identity was off" and is real attribution. Using it for an unwired
    operator surface would make this call site report as fully attributed while attributing nothing,
    and would leave U11 with no work list.
    */
    expect(resolved.runContext.actor.actor.id).not.toBe(BOOTSTRAP_ACTOR_ID);
  });

  it("FAILS CLOSED for an ambiguous cwd instead of taking the marker or guessing an agent", () => {
    const disposeA = registerFusionSessionIdentity(CWD, { agentId: "agent-a", taskId: "FN-1" });
    const disposeB = registerFusionSessionIdentity(CWD, { agentId: "agent-b", taskId: "FN-2" });
    try {
      const resolved = resolveExtensionMutationContext({ cwd: CWD });
      expect(resolved.kind).toBe("ambiguous");
      if (resolved.kind !== "ambiguous") return;
      expect(resolved.candidateCount).toBe(2);
      // There is no context to write with — not the marker, and not either candidate.
      expect("runContext" in resolved).toBe(false);
    } finally {
      disposeA();
      disposeB();
    }
  });

  it("an explicit agent id still wins over an ambiguous registry, because it is direct evidence", () => {
    const disposeA = registerFusionSessionIdentity(CWD, { agentId: "agent-a" });
    const disposeB = registerFusionSessionIdentity(CWD, { agentId: "agent-b" });
    try {
      const resolved = resolveExtensionMutationContext({ cwd: CWD, agentId: "agent-explicit" });
      expect(resolved.kind).toBe("resolved");
      if (resolved.kind !== "resolved") return;
      expect(resolved.runContext.actor.actor.id).toBe("agent-explicit");
    } finally {
      disposeA();
      disposeB();
    }
  });

  it("the refusal is a visible error naming the remedy, not a silent no-op", () => {
    const denial = ambiguousActorToolError("fn_task_update", 2);
    expect(denial.isError).toBe(true);
    expect(denial.details.error).toBe("ambiguous-caller-identity");
    expect(denial.details.tool).toBe("fn_task_update");
    expect(denial.details.candidateCount).toBe(2);
    expect(denial.content[0]?.text).toContain("ambiguous");
    expect(denial.content[0]?.text).toContain("End one concurrent session");
  });

  it("neither the ambiguous nor the unattributed id can ever become a real actor", () => {
    // If either were grantable, the fail-closed branch above would be a privilege-escalation target.
    expect(isReservedActorId(AMBIGUOUS_ACTOR_ID)).toBe(true);
    expect(isReservedActorId(UNATTRIBUTED_ACTOR_ID)).toBe(true);
  });
});
