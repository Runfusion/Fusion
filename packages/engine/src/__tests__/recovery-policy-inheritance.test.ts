/*
FNXC:WorkflowRecoveryPolicy 2026-07-27-17:10 (U4 — the OVERRIDE LAYER rule):

Recovery policy is an OVERRIDE LAYER over the operator's settings, not a
replacement for them. Ratified precedence:

  declared explicitly  → workflow policy WINS
  left unset           → DEFER to the project/global setting, exactly as today

This mirrors the two-tier merge `effective-settings.ts` already implements for
workflow settings (a stored value overrides the base; a declaration default only
fills an absent key), rather than inventing a fourth precedence system beside
model selection, project settings, and workflow settings.

WHY THIS TEST EXISTS AND WHY IT IS FIRST. This is where a green suite lies. The
naive implementation — "read `policy.stalenessMs`, otherwise use the built-in
default" — passes every obvious test while silently resetting an operator who
tuned `stalePausedTodoThresholdMs`. The failure is invisible: no error, no diff,
the sweep simply starts firing on a schedule nobody chose.

The subtlety the ratified rule turns on: **equal-to-default is not the same as
unset.** A declaration default that happens to be byte-equal to the legacy
literal is STILL wrong if it clobbers a project that customized the value. So
absence must stay ABSENT all the way through — never normalized into a default —
which is the same discipline `workflow-settings-resolver.ts` documents for keys
whose declaration omits a default.

Consequence that makes the migration safe: retiring a sweep no longer requires
builtin:coding to declare anything. Unset defers to the existing setting, so the
behavior cannot silently disappear on upgrade and no project needs touching.
*/
import { describe, expect, it } from "vitest";
import type { Task, WorkflowIr } from "@fusion/core";

import { decideRecovery, resolveEffectiveRecovery } from "../recovery-reconciler.js";

/** The legacy default for the stale-paused-hold signal (24h). */
const BUILTIN_DEFAULT_MS = 24 * 60 * 60_000;
/** An operator who deliberately tightened the threshold to 1h. */
const CUSTOMIZED_MS = 60 * 60_000;

const SIGNAL = { action: "surface", code: "stale-paused-todo" } as const;

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

/** `declared === undefined` models a workflow that never declared a policy. */
function ir(declared?: { stalenessMs?: number; onStale?: typeof SIGNAL }): WorkflowIr {
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
        ...(declared ? { recovery: declared } : {}),
      },
      { id: "building", name: "Building", traits: [{ trait: "wip", config: { limitSetting: "maxConcurrent" } }] },
      { id: "shipped", name: "Shipped", traits: [{ trait: "complete" }] },
    ],
  } as unknown as WorkflowIr;
}

/** A card that has rested 2h — stale under the customized 1h, fresh under 24h. */
const TWO_HOURS_LATER = { now: () => Date.parse("2026-01-01T02:00:00.000Z") };

describe("recovery policy is an OVERRIDE LAYER over operator settings", () => {
  describe("the case that makes a naive implementation lie", () => {
    it("a CUSTOMIZED setting with the policy key UNSET observes the CUSTOMIZED value", () => {
      /*
      THE test. A project tuned the threshold to 1h and its workflow declares no
      policy. The card has rested 2h, so it is stale under the operator's value
      and fresh under the built-in 24h default.

      A naive implementation falls back to the built-in default, finds the card
      fresh, and silently stops surfacing it — resetting a deliberate operator
      choice with no error and nothing in any diff.
      */
      const effective = resolveEffectiveRecovery(undefined, {
        stalenessMs: CUSTOMIZED_MS,
        onStale: SIGNAL,
      });

      expect(effective?.stalenessMs).toBe(CUSTOMIZED_MS);
      expect(effective?.stalenessMs).not.toBe(BUILTIN_DEFAULT_MS);
    });

    it("acts on the card end-to-end using the inherited setting", () => {
      /* The decision half: inheritance must reach the actual reconcile outcome,
         not just the resolver. */
      const outcome = decideRecovery(task(), ir(), {
        ...TWO_HOURS_LATER,
        inherited: { stalenessMs: CUSTOMIZED_MS, onStale: SIGNAL },
      });

      expect(outcome).toEqual({
        decision: expect.objectContaining({ taskId: "FN-1", action: "surface", code: "stale-paused-todo" }),
      });
    });

    it("does NOT act when the same card is fresh under the inherited value", () => {
      /* The negative half — otherwise "always act" would pass the test above. */
      const outcome = decideRecovery(task(), ir(), {
        ...TWO_HOURS_LATER,
        inherited: { stalenessMs: BUILTIN_DEFAULT_MS, onStale: SIGNAL },
      });

      expect(outcome).toEqual({ suppressed: "not-stale" });
    });
  });

  describe("explicit declaration wins", () => {
    it("a declared policy overrides the operator setting", () => {
      const effective = resolveEffectiveRecovery(
        { stalenessMs: 5_000, onStale: SIGNAL },
        { stalenessMs: CUSTOMIZED_MS, onStale: SIGNAL },
      );
      expect(effective?.stalenessMs).toBe(5_000);
    });

    it("overrides even when the declared value equals the built-in default", () => {
      /*
      `equal-to-default is not the same as unset`: a workflow that DELIBERATELY
      declares the legacy value is making a choice, and it must win over the
      operator setting exactly as any other explicit declaration does. The
      distinction is presence, never value.
      */
      const effective = resolveEffectiveRecovery(
        { stalenessMs: BUILTIN_DEFAULT_MS, onStale: SIGNAL },
        { stalenessMs: CUSTOMIZED_MS, onStale: SIGNAL },
      );
      expect(effective?.stalenessMs).toBe(BUILTIN_DEFAULT_MS);
    });

    it("inherits per-field: a declared threshold with no declared action still inherits the action", () => {
      const effective = resolveEffectiveRecovery(
        { stalenessMs: 5_000 },
        { stalenessMs: CUSTOMIZED_MS, onStale: SIGNAL },
      );
      expect(effective).toEqual({ stalenessMs: 5_000, onStale: SIGNAL });
    });
  });

  describe("onStale precedence (P2: previously untested)", () => {
    /*
    FNXC:WorkflowRecoveryPolicy 2026-07-27-21:55 (PR #2482 review, P2):
    The override tests proved only that `stalenessMs` wins, so an `onStale`
    precedence bug passed. Distinct codes on each side make the winner
    observable — with the same code on both, any precedence order looks correct.
    */
    const DECLARED_SIGNAL = { action: "surface", code: "declared-code" } as const;
    const INHERITED_SIGNAL = { action: "surface", code: "inherited-code" } as const;

    it("a declared onStale overrides the inherited one", () => {
      const effective = resolveEffectiveRecovery(
        { stalenessMs: 5_000, onStale: DECLARED_SIGNAL },
        { stalenessMs: CUSTOMIZED_MS, onStale: INHERITED_SIGNAL },
      );
      expect(effective?.onStale.code).toBe("declared-code");
    });

    it("carries the DECLARED code through to the decision, not just the resolver", () => {
      const outcome = decideRecovery(task(), ir({ stalenessMs: 5_000, onStale: DECLARED_SIGNAL }), {
        ...TWO_HOURS_LATER,
        inherited: { stalenessMs: CUSTOMIZED_MS, onStale: INHERITED_SIGNAL },
      });
      expect(outcome).toEqual({ decision: expect.objectContaining({ code: "declared-code" }) });
    });

    it("inherits the code when only the threshold is declared", () => {
      const outcome = decideRecovery(task(), ir({ stalenessMs: 5_000 }), {
        ...TWO_HOURS_LATER,
        inherited: { stalenessMs: CUSTOMIZED_MS, onStale: INHERITED_SIGNAL },
      });
      expect(outcome).toEqual({ decision: expect.objectContaining({ code: "inherited-code" }) });
    });
  });

  describe("a non-positive threshold is ABSENT, never 'always stale'", () => {
    /*
    FNXC:WorkflowRecoveryPolicy 2026-07-27-21:55 (PR #2482 review, P1):
    The resolver and its consumer disagreed about 0. Reconciled toward ABSENT,
    because the only path that can supply 0 is the inherited operator setting,
    where `<= 0` means DISABLED today — reading it as always-stale would invert an
    explicit off switch into surface-everything.
    */
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      "treats an inherited threshold of %s as no policy",
      (value) => {
        expect(resolveEffectiveRecovery(undefined, { stalenessMs: value, onStale: SIGNAL })).toBeUndefined();
      },
    );

    it("suppresses rather than surfacing everything when the operator disabled the sweep", () => {
      const outcome = decideRecovery(task(), ir(), {
        ...TWO_HOURS_LATER,
        inherited: { stalenessMs: 0, onStale: SIGNAL },
      });
      expect(outcome).toEqual({ suppressed: "no-policy" });
    });
  });

  describe("absence stays absent — never normalized into a default", () => {
    it("yields NO actionable policy when neither the workflow nor the setting supplies a threshold", () => {
      /* The sweep is simply off. It must not invent a built-in default and start
         acting on a project that configured nothing. */
      expect(resolveEffectiveRecovery(undefined, {})).toBeUndefined();
      expect(resolveEffectiveRecovery(undefined, { onStale: SIGNAL })).toBeUndefined();
    });

    it("treats an explicitly-undefined setting as absent, not as a value", () => {
      expect(resolveEffectiveRecovery(undefined, { stalenessMs: undefined, onStale: SIGNAL })).toBeUndefined();
    });

    it("suppresses with no-policy when nothing is declared and nothing is inherited", () => {
      const outcome = decideRecovery(task(), ir(), TWO_HOURS_LATER);
      expect(outcome).toEqual({ suppressed: "no-policy" });
    });
  });

  describe("zero-behavior-change on upgrade", () => {
    it("an unset policy reproduces the operator's value for every threshold it inherits", () => {
      /*
      The upgrade guarantee, stated as a property: for ANY operator value, an
      undeclared workflow observes exactly that value. If this holds, landing the
      policy table touches no project.
      */
      for (const operatorValue of [1, 1_000, CUSTOMIZED_MS, BUILTIN_DEFAULT_MS, 7 * 24 * 60 * 60_000]) {
        const effective = resolveEffectiveRecovery(undefined, { stalenessMs: operatorValue, onStale: SIGNAL });
        expect(effective?.stalenessMs).toBe(operatorValue);
      }
    });
  });
});
