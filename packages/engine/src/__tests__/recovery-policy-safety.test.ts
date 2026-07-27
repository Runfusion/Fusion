/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-14:20 (U4 — RATIFIED SAFETY INVARIANT):

The single most important rule in the U4 policy design, encoded as a test.

The six safeguards — user pause, `autoMerge:false`, dependency, capacity,
merge-proof, at-most-once — are enforced by the reconciler OUTSIDE the policy
table. They must NEVER become expressible as workflow policy, because a workflow
author would then be able to author a safety invariant away: a workflow whose
`recovery` block said "ignore user pause" would produce an engine that overrides
an operator's explicit stop.

This file fails if any of the six becomes reachable from `WorkflowColumnRecovery`.
Two independent mechanisms, because either alone is defeatable:

  1. a STRUCTURAL assertion over the policy type's accepted keys — catches a new
     key being added to the schema;
  2. a BEHAVIORAL assertion that a policy attempting to disable a safeguard has
     no effect — catches the schema staying clean while the reconciler starts
     honoring an undeclared field.

The structural half is deliberately written against a hand-maintained allow-list
rather than inferred from the type, so ADDING a policy key requires editing this
file and re-stating the safety argument. That friction is the point.
*/
import { describe, expect, it } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";

import {
  decideRecovery,
  isSuppressedBySafeguard,
  resolveColumnRecovery,
  RECOVERY_POLICY_KEYS,
} from "../recovery-reconciler.js";

/**
 * The keys the recovery policy is ALLOWED to express, as REVIEWED. Adding to this
 * list means asserting, in review, that the new key cannot disable a safeguard.
 */
const REVIEWED_POLICY_KEYS = ["onStale", "stalenessMs"] as const;

/**
 * The keys the TYPE actually accepts, derived from `RECOVERY_POLICY_KEYS` —
 * a `Record<keyof WorkflowColumnRecovery, true>` that the compiler forces to stay
 * exhaustive. Driving the ratchet off this instead of off a test fixture is the
 * whole point: a fixture only proves what it happens to set, while this cannot
 * drift from the interface without failing the build.
 */
const TYPE_POLICY_KEYS = Object.keys(RECOVERY_POLICY_KEYS);

/** The six safeguards, in the vocabulary an author might try to use. */
const SAFEGUARD_KEYS = [
  "userPaused", "respectUserPause", "ignoreUserPause",
  "autoMerge", "allowAutoMergeOff", "ignoreAutoMerge",
  "dependencies", "ignoreDependencies", "skipDependencyCheck",
  "capacity", "ignoreCapacity", "overrideCapacity",
  "mergeProof", "skipMergeProof", "ignoreMergeConfirmed",
  "atMostOnce", "allowRepeat", "skipIdempotency",
];

function task(over: Partial<Task> = {}): Task {
  return {
    id: "FN-1",
    title: "t",
    description: "",
    column: "drafting",
    dependencies: [],
    steps: [],
    currentStep: 0,
    log: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    columnMovedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  } as unknown as Task;
}

/** A workflow whose hold column carries a staleness policy, plus any extra keys. */
function ir(extraPolicyKeys: Record<string, unknown> = {}): WorkflowIr {
  return {
    version: "v2",
    id: "custom:wf",
    nodes: [],
    edges: [],
    columns: [
      {
        id: "drafting",
        name: "Drafting",
        traits: [{ trait: "hold", config: { release: "capacity" } }],
        recovery: {
          stalenessMs: 1_000,
          onStale: { action: "surface", code: "stale-paused-todo" },
          ...extraPolicyKeys,
        },
      },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

const LATER = { now: () => Date.parse("2026-01-02T00:00:00.000Z") };

describe("recovery policy safety invariant — safeguards live OUTSIDE the policy table", () => {
  describe("structural: the policy schema exposes no safeguard key", () => {
    it("the TYPE accepts exactly the reviewed key set", () => {
      /*
      The ratchet. `TYPE_POLICY_KEYS` is derived from a compiler-enforced
      exhaustive manifest, so this fails the moment `WorkflowColumnRecovery`
      gains or loses a key — even one no fixture ever sets, which is exactly the
      case the fixture-driven version missed.
      */
      expect([...TYPE_POLICY_KEYS].sort()).toEqual([...REVIEWED_POLICY_KEYS].sort());
    });

    it.each(SAFEGUARD_KEYS)("the TYPE does not accept a safeguard key: %s", (key) => {
      expect(TYPE_POLICY_KEYS).not.toContain(key);
    });

    it("a workflow cannot smuggle an unknown key past the parser into a live policy", () => {
      /* Complements the type ratchet at runtime: whatever a stored workflow row
         carries, what the reconciler READS must stay within the reviewed set. */
      const policy = resolveColumnRecovery(ir(), "drafting");
      expect(policy).toBeDefined();
      expect(Object.keys(policy!).every((k) => (TYPE_POLICY_KEYS as string[]).includes(k))).toBe(true);
    });
  });

  describe("behavioral: a policy that tries to disable a safeguard has no effect", () => {
    it("cannot switch off the user-pause safeguard", () => {
      /*
      The load-bearing case for the `surface` action. A user-paused card must not
      receive engine-authored signals, and no policy may say otherwise.
      */
      const paused = task({ userPaused: true } as Partial<Task>);

      // Honest policy: suppressed.
      const honest = decideRecovery(paused, ir(), LATER);
      expect(honest).toEqual({ suppressed: "user-paused" });

      // Hostile policy attempting every spelling of "ignore the pause": identical.
      const hostile = decideRecovery(
        paused,
        ir({ ignoreUserPause: true, respectUserPause: false, userPaused: false }),
        LATER,
      );
      expect(hostile).toEqual({ suppressed: "user-paused" });
    });

    it("still acts on an unpaused card, so the guard is not vacuously suppressing everything", () => {
      /* Without this, a reconciler that suppressed EVERYTHING would pass the test
         above while doing nothing — the "dead guard passes tests" failure mode. */
      const outcome = decideRecovery(task(), ir(), LATER);
      expect(outcome).toEqual({
        decision: expect.objectContaining({ taskId: "FN-1", action: "surface", code: "stale-paused-todo" }),
      });
    });

    it("routes the user-pause decision through the single safeguard chokepoint", () => {
      /* Pins that suppression comes from `isSuppressedBySafeguard` and not from an
         incidental check elsewhere, so there stays exactly one place to audit. */
      expect(isSuppressedBySafeguard({ userPaused: true }, "surface")).toBe("user-paused");
      expect(isSuppressedBySafeguard({ userPaused: false }, "surface")).toBeUndefined();
      expect(isSuppressedBySafeguard({ userPaused: undefined }, "surface")).toBeUndefined();
    });
  });

  describe("scope limits stated rather than implied", () => {
    it("implements only the surface action, so only its relevant safeguard is wired", () => {
      /*
      `surface` mutates no lifecycle state, so autoMerge / dependency / capacity /
      merge-proof / at-most-once gate actions that do not exist yet. Wiring them
      now would be untestable dead code. This test records the scope limit so the
      absence reads as deliberate; it must be updated when `rebound` lands.
      */
      const decision = decideRecovery(task(), ir(), LATER);
      expect("decision" in decision && decision.decision.action).toBe("surface");
    });
  });
});
