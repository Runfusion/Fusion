/*
FNXC:WorkflowLifecycleColumns 2026-07-30-17:50 (U11 — dashboard pre-implementation guards):

Five `"triage"` literals across three dashboard files, of THREE different kinds. The
coordinator's warning was not to swap a literal for a trait lookup without checking
what the guard was for, so they are treated differently:

  TWO REAL REGRESSIONS from #2515, converted to resolve by ROLE:

    Column quick-create — `workflowMode || column === "triage"` gated the "+"
    affordance. Once #2515 removed `triage` from the default lineage no column
    matched, so on a NON-workflow board the affordance stopped rendering anywhere.

    TaskContextMenu `shouldShowActionsMenu` — `task.column !== "triage"` SUPPRESSED
    the menu for intake cards, which have almost no applicable actions. Post-#2515 a
    planning card sits in `todo`, so the test is true and the menu always renders.
    The suppression silently switched off.

  ONE ADDITIVE literal (`isPreExecutionHoldColumn`) where the id was OR'd with the
  trait checks. Reordered so traits decide first, with the id as the fallback.

  TWO DELIBERATE FALLBACKS (`taskActivity`, Column's preserve-progress prompt) that
  already resolved by trait and used ids only when metadata had not loaded. Those
  are NOT converted — losing them would drop the guard during the pre-load window.
  They move behind a NAMED helper so they stop reading as unconverted guards to the
  census and to the next reviewer, with behaviour unchanged.

The narrowness matters: the intake helper must NOT admit the hold lane, or the menu
suppression would swallow every card waiting on capacity.
*/
import { describe, expect, it } from "vitest";

import {
  isLegacyIntakeColumn,
  isLegacyPreImplementationColumn,
} from "../legacyLifecycleColumns.js";
import {
  isPreExecutionHoldColumn,
  isPreExecutionIntakeLane,
} from "../../components/TaskContextMenu.js";

describe("legacy pre-implementation column fallbacks", () => {
  it("recognises both legacy pre-implementation ids and nothing else", () => {
    for (const id of ["triage", "todo"]) {
      expect(isLegacyPreImplementationColumn(id)).toBe(true);
    }
    for (const id of ["in-progress", "in-review", "done", "archived", "drafting", ""]) {
      expect(isLegacyPreImplementationColumn(id)).toBe(false);
    }
  });

  it("keeps the INTAKE fallback narrower than the pre-implementation one", () => {
    /* The distinction the menu suppression depends on: `todo` is pre-implementation
       but is NOT the intake lane on a split board. */
    expect(isLegacyIntakeColumn("triage")).toBe(true);
    expect(isLegacyIntakeColumn("todo")).toBe(false);
    expect(isLegacyPreImplementationColumn("todo")).toBe(true);
  });
});

describe("intake-lane resolution drives the actions-menu suppression", () => {
  it("resolves by ROLE when column flags are present", () => {
    expect(isPreExecutionIntakeLane("anything", { intake: true })).toBe(true);
    expect(isPreExecutionIntakeLane("triage", { intake: false })).toBe(false);
  });

  it("does NOT treat a hold-only lane as intake", () => {
    /*
    The failure the narrowing prevents. If this returned true, the actions menu
    would be suppressed for every card waiting on capacity — a much bigger
    regression than the one being fixed.
    */
    expect(isPreExecutionIntakeLane("backlog", { hold: true })).toBe(false);
  });

  it("never treats a terminal lane as intake, whatever the id", () => {
    expect(isPreExecutionIntakeLane("triage", { intake: true, complete: true })).toBe(false);
    expect(isPreExecutionIntakeLane("triage", { intake: true, archived: true })).toBe(false);
  });

  it("falls back to the legacy intake id when no flags are available", () => {
    expect(isPreExecutionIntakeLane("triage", undefined)).toBe(true);
    expect(isPreExecutionIntakeLane("todo", undefined)).toBe(false);
  });
});

describe("pre-execution HOLD column still admits both lanes", () => {
  it("admits intake and hold by trait, and the legacy id as fallback", () => {
    expect(isPreExecutionHoldColumn("anything", { intake: true })).toBe(true);
    expect(isPreExecutionHoldColumn("anything", { hold: true })).toBe(true);
    expect(isPreExecutionHoldColumn("triage", undefined)).toBe(true);
  });

  it("still refuses terminal lanes", () => {
    expect(isPreExecutionHoldColumn("triage", { complete: true })).toBe(false);
    expect(isPreExecutionHoldColumn("triage", { archived: true })).toBe(false);
  });

  it("is WIDER than the intake predicate, which is the point of keeping both", () => {
    expect(isPreExecutionHoldColumn("backlog", { hold: true })).toBe(true);
    expect(isPreExecutionIntakeLane("backlog", { hold: true })).toBe(false);
  });
});
