import { describe, expect, it } from "vitest";
import { computePlanApprovalFingerprint, resolvePlanApprovalRequired, type PlanApprovalMode } from "../plan-approval.js";

const workflowValues = [true, false, undefined] as const;

describe("resolvePlanApprovalRequired", () => {
  it.each(workflowValues)("defers to requirePlanApproval when mode is workflow and workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ planApprovalMode: "workflow", requirePlanApproval })).toBe(Boolean(requirePlanApproval));
  });

  it.each(workflowValues)("defers to requirePlanApproval when mode is undefined and workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ requirePlanApproval })).toBe(Boolean(requirePlanApproval));
  });

  it.each(workflowValues)("auto-approve-all bypasses approval when workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ planApprovalMode: "auto-approve-all", requirePlanApproval })).toBe(false);
  });

  it.each(workflowValues)("require-all requires approval when workflow value is %s", (requirePlanApproval) => {
    expect(resolvePlanApprovalRequired({ planApprovalMode: "require-all", requirePlanApproval })).toBe(true);
  });

  it("falls back to workflow behavior for unknown persisted modes", () => {
    expect(
      resolvePlanApprovalRequired({
        planApprovalMode: "future-mode" as PlanApprovalMode,
        requirePlanApproval: true,
      }),
    ).toBe(true);
    expect(
      resolvePlanApprovalRequired({
        planApprovalMode: "future-mode" as PlanApprovalMode,
        requirePlanApproval: false,
      }),
    ).toBe(false);
  });
});

/*
 * FNXC:PlanApproval 2026-07-04-22:41:
 * FN-7569 — computePlanApprovalFingerprint coverage: stable for identical content, normalizes only
 * trailing whitespace/newlines, and differs whenever the actual plan body changes.
 */
describe("computePlanApprovalFingerprint", () => {
  it("is stable for the same content across repeated calls", () => {
    const text = "# Task: FN-1\n\n## File Scope\n\n- a.ts\n";
    expect(computePlanApprovalFingerprint(text)).toBe(computePlanApprovalFingerprint(text));
  });

  it("is unaffected by trailing whitespace or trailing newline differences", () => {
    const base = "# Task: FN-1\n\n## File Scope\n\n- a.ts";
    expect(computePlanApprovalFingerprint(base)).toBe(computePlanApprovalFingerprint(`${base}\n`));
    expect(computePlanApprovalFingerprint(base)).toBe(computePlanApprovalFingerprint(`${base}\n\n\n`));
    expect(computePlanApprovalFingerprint("line one   \nline two")).toBe(computePlanApprovalFingerprint("line one\nline two"));
  });

  it("differs when the plan content actually changes", () => {
    const original = "# Task: FN-1\n\n## File Scope\n\n- a.ts\n";
    const changed = "# Task: FN-1\n\n## File Scope\n\n- a.ts\n- b.ts\n";
    expect(computePlanApprovalFingerprint(original)).not.toBe(computePlanApprovalFingerprint(changed));
  });

  it("produces a hex sha256-length digest", () => {
    expect(computePlanApprovalFingerprint("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
