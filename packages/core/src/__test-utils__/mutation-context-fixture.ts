/*
FNXC:Identity 2026-08-09-03:04 (U18/KTD2 — the test-side mutation context):
U18 makes the mutation-context parameter required across the mutating store surface. `@fusion/core`'s
own suite calls `createTask`/`updateTask`/`moveTask`/`logEntry`/`deleteTask`/`addComment` roughly 900
times, and hand-writing a context literal at each of them would be ~900 chances to write a slightly
different one — which is how a test suite ends up asserting on the fixture instead of on behavior.

One fixture, imported. `testMutationContext()` is a REAL, fully-populated `RunMutationContext`, not
the unattributed marker: a test must be able to prove that the context a caller supplied is the
context that got persisted, and the marker deliberately carries no actor to observe. Tests that want
to assert the unwired path should import `UNATTRIBUTED_MUTATION_CONTEXT` explicitly and say so.

While the deprecated staging overload still exists, most existing tests compile and run untouched —
this fixture is for tests that are BEING converted and for new tests, which must never be written
against the deprecated arity.
*/

import type { RunMutationContext } from "../types/task/task-log.js";
import type { ActorRef } from "../identity/actor.js";

/** A stable human actor for tests that assert on attribution. */
export const TEST_ACTOR: ActorRef = { id: "human:test-operator", kind: "human", displayName: "Test Operator" };

/** A stable agent actor for tests that exercise the agent-attributed paths. */
export const TEST_AGENT_ACTOR: ActorRef = { id: "agent:test-agent", kind: "agent", displayName: "Test Agent" };

/**
 * The default mutation context for tests.
 *
 * Returns a fresh object each call so a test that mutates or snapshots it cannot leak into the next
 * one — a shared frozen constant reads cheaper but turns one careless `context.runId = ...` into a
 * cross-file failure that reproduces only in file order.
 */
export function testMutationContext(overrides: Partial<RunMutationContext> = {}): RunMutationContext {
  return {
    runId: "test-run",
    agentId: "test-agent",
    actor: { actor: TEST_ACTOR },
    ...overrides,
  };
}

/** A mutation context attributed to an agent actor, for checkout/assignment-shaped tests. */
export function testAgentMutationContext(overrides: Partial<RunMutationContext> = {}): RunMutationContext {
  return testMutationContext({ actor: { actor: TEST_AGENT_ACTOR }, ...overrides });
}

/**
 * A delegated context: an agent executing on behalf of a human (R5/R28). Kept here so the two
 * fields are never collapsed into one "effective user" at a test call site — the containment rule
 * `evaluateDelegatedPermission` enforces is only testable while both are present.
 */
export function testDelegatedMutationContext(overrides: Partial<RunMutationContext> = {}): RunMutationContext {
  return testMutationContext({ actor: { actor: TEST_AGENT_ACTOR, actingFor: TEST_ACTOR }, ...overrides });
}
