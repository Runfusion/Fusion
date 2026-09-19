/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 Stage C — the executor's run carrier, asserted directly):

`executor.ts` holds the repo's largest population of mutating store call sites and almost none of
them has an acting agent in scope, so U18 is satisfied here by a CARRIER (`currentRunContexts`, read
through the total `runContextFor`) rather than by an argument at each site. That makes the carrier
itself the thing worth testing: every other executor test asserts a specific behaviour and would
still pass if the carrier silently degraded to a marker or to `undefined`.

Three invariants, one per failure mode this stage could regress into:

  1. Inside a live run the store sees the RUN's actor — the assigned agent, not a lane label. A
     regression that dropped `currentRunContexts` and always returned the lane would pass every
     "was updateTask called" assertion in the suite and fail only here.
  2. Outside a live run the store sees the executor LANE, derived. Not `undefined` (which is what
     the partial `getRunContextFor` produced, type-checking only against U18's deprecated overload
     and attributing nothing) and not the unattributed marker (which would claim no actor is
     knowable for a write this lane demonstrably made).
  3. `getRunContextFor` stays PARTIAL. It is the liveness probe behind ~20 `?.runId` reads; if it
     were collapsed into the total form those probes would silently become unconditionally true.
*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "./executor-test-helpers.js";
import { TaskExecutor } from "../executor.js";
import { actorContextForAgent, UNATTRIBUTED_MUTATION_CONTEXT, type RunMutationContext } from "@fusion/core";
import { createMockStore, resetExecutorMocks } from "./executor-test-helpers.js";

describe("executor mutation-context carrier (U18 Stage C)", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fusion-executor-ctx-"));
    resetExecutorMocks();
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeExecutor() {
    const store = createMockStore();
    const executor = new TaskExecutor(store, tmpRoot) as unknown as {
      runContextFor: (taskId: string, fallbackAgentId?: string | null) => RunMutationContext;
      getRunContextFor: (taskId: string) => RunMutationContext | undefined;
      currentRunContexts: Map<string, RunMutationContext>;
    };
    return { store, executor };
  }

  it("hands the live run's own actor to the store while a run is active", () => {
    const { executor } = makeExecutor();
    executor.currentRunContexts.set("FN-1", {
      runId: "exec-run-1",
      agentId: "agent-7",
      actor: actorContextForAgent("agent-7"),
    });

    const resolved = executor.runContextFor("FN-1");

    expect(resolved.runId).toBe("exec-run-1");
    expect(resolved.agentId).toBe("agent-7");
    expect(resolved.actor.actor.id).toBe("agent-7");
    // The lane label must never displace a real assigned agent.
    expect(resolved.actor.actor.id).not.toBe("executor");
  });

  it("derives the executor lane — never the unattributed marker — outside a live run", () => {
    const { executor } = makeExecutor();

    const resolved = executor.runContextFor("FN-NO-RUN");

    expect(resolved.actor.actor.id).toBe("executor");
    expect(resolved.actor.actor.kind).toBe("agent");
    expect(resolved.actor.actor.id).not.toBe(UNATTRIBUTED_MUTATION_CONTEXT.actor.actor.id);
    // Autonomous engine work acts for nobody (R28).
    expect(resolved.actor.actingFor).toBeUndefined();
  });

  it("prefers an explicit fallback agent over the lane label, and still never returns undefined", () => {
    const { executor } = makeExecutor();

    const resolved = executor.runContextFor("FN-NO-RUN", "agent-42");

    expect(resolved.actor.actor.id).toBe("agent-42");
    expect(resolved).toBeDefined();
  });

  it("keeps getRunContextFor partial so the liveness probes stay honest", () => {
    const { executor } = makeExecutor();

    // No live run: the probe says so, while the total form still produces an actor.
    expect(executor.getRunContextFor("FN-NO-RUN")).toBeUndefined();
    expect(executor.runContextFor("FN-NO-RUN").actor.actor.id).toBe("executor");

    executor.currentRunContexts.set("FN-2", {
      runId: "exec-run-2",
      agentId: "agent-9",
      actor: actorContextForAgent("agent-9"),
    });
    expect(executor.getRunContextFor("FN-2")?.runId).toBe("exec-run-2");
  });
});
