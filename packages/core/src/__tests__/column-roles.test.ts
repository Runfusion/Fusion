import { describe, expect, it } from "vitest";
import {
  isCompleteColumnRole,
  isHoldColumnRole,
  isIntakeColumnRole,
  isPreImplementationColumnRole,
  isReviewColumnRole,
  isTerminalColumnRole,
  isWipColumnRole,
  type ColumnRoleTraitFlags,
} from "../column-roles.js";

/*
FNXC:WorkflowResolvedColumns 2026-07-30-15:20:
Covers BOTH modes of every predicate — the flags path and the degraded no-flags fallback. The
fallback is the half that had no test when these lived only in the dashboard app, and it is the half
that matters: it runs for any caller holding a task row without a resolved IR, and for a card resting
in a column its workflow no longer declares.

The renamed-column cases are the point of the whole conversion: a column carrying the right trait
under a NON-legacy id must answer yes, and a column carrying the legacy id but the WRONG trait must
answer no. A predicate that only ever saw default boards would pass while doing nothing.
*/

const F = (f: ColumnRoleTraitFlags): ColumnRoleTraitFlags => f;

describe("column-role predicates — flags decide when present", () => {
  it("reads each role off its own trait, under a renamed column id", () => {
    expect(isIntakeColumnRole(F({ intake: true }), "Inbox")).toBe(true);
    expect(isHoldColumnRole(F({ hold: true }), "Parking")).toBe(true);
    expect(isWipColumnRole(F({ countsTowardWip: true }), "Building")).toBe(true);
    expect(isReviewColumnRole(F({ mergeBlocker: true }), "Checking")).toBe(true);
    expect(isCompleteColumnRole(F({ complete: true }), "Shipped")).toBe(true);
  });

  it("a legacy id with the WRONG traits answers no — the id must not win over resolved flags", () => {
    // The conversion's whole claim: once flags resolve, the id is not consulted.
    expect(isCompleteColumnRole(F({ hold: true }), "done")).toBe(false);
    expect(isWipColumnRole(F({ hold: true }), "in-progress")).toBe(false);
    expect(isIntakeColumnRole(F({ hold: true }), "triage")).toBe(false);
    expect(isReviewColumnRole(F({ complete: true }), "in-review")).toBe(false);
  });

  it("pre-implementation is the union of intake and hold", () => {
    expect(isPreImplementationColumnRole(F({ intake: true }), "x")).toBe(true);
    expect(isPreImplementationColumnRole(F({ hold: true }), "x")).toBe(true);
    expect(isPreImplementationColumnRole(F({ countsTowardWip: true }), "x")).toBe(false);
  });

  it("review accepts either separable trait", () => {
    expect(isReviewColumnRole(F({ humanReview: true }), "x")).toBe(true);
    expect(isReviewColumnRole(F({ mergeBlocker: true }), "x")).toBe(true);
    expect(isReviewColumnRole(F({}), "x")).toBe(false);
  });

  it("terminal and complete are the same successful lifecycle role", () => {
    expect(isTerminalColumnRole(F({ complete: true }), "x")).toBe(true);
    expect(isTerminalColumnRole(F({ countsTowardWip: true }), "x")).toBe(false);
  });

  it("an empty resolved-flags object is authoritative — it does NOT fall back to the id", () => {
    // `{}` means "traits resolved, this column has none", which is different from "unresolved".
    expect(isCompleteColumnRole(F({}), "done")).toBe(false);
    expect(isWipColumnRole(F({}), "in-progress")).toBe(false);
    expect(isTerminalColumnRole(F({}), "archived")).toBe(false);
  });
});

describe("column-role predicates — degraded fallback when flags are absent", () => {
  it("falls back to the legacy id for each role", () => {
    expect(isIntakeColumnRole(undefined, "triage")).toBe(true);
    expect(isHoldColumnRole(undefined, "todo")).toBe(true);
    expect(isWipColumnRole(undefined, "in-progress")).toBe(true);
    expect(isReviewColumnRole(undefined, "in-review")).toBe(true);
    expect(isCompleteColumnRole(undefined, "done")).toBe(true);
  });

  it("pre-implementation falls back to BOTH planning ids, merged and pre-merge", () => {
    // `todo` is the post-U11 merged Planning column; `triage` its pre-merge predecessor, retained
    // for projects upgraded mid-flight that still hold cards there.
    expect(isPreImplementationColumnRole(undefined, "todo")).toBe(true);
    expect(isPreImplementationColumnRole(undefined, "triage")).toBe(true);
    expect(isPreImplementationColumnRole(undefined, "in-progress")).toBe(false);
  });

  it("terminal falls back to Done only", () => {
    expect(isTerminalColumnRole(undefined, "done")).toBe(true);
    expect(isTerminalColumnRole(undefined, "archived")).toBe(false);
    expect(isTerminalColumnRole(undefined, "in-review")).toBe(false);
  });

  it("a RENAMED column with no resolved flags answers no — the fallback cannot invent a role", () => {
    // The honest limit of the degraded mode, asserted so nobody mistakes it for trait resolution.
    expect(isCompleteColumnRole(undefined, "Shipped")).toBe(false);
    expect(isWipColumnRole(undefined, "Building")).toBe(false);
    expect(isIntakeColumnRole(undefined, "Inbox")).toBe(false);
  });
});
