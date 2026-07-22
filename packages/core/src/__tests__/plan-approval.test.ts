import { describe, expect, it } from "vitest";
import { computePlanApprovalFingerprint, resolvePlanApprovalRequired, type PlanApprovalMode } from "../planner/plan-approval.js";
import { applyFrontendUxCriteria } from "../tasks/frontend-ux-policy.js";
import { applyOriginalDescription } from "../tasks/original-description-policy.js";

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

  it("ignores deterministic Original Description and Frontend UX hygiene sections", () => {
    const plannerText = "# Task: FN-1\n\n## Mission\n\nBuild the interface.\n\n## File Scope\n\n- packages/dashboard/app/page.tsx\n";
    const withOriginalDescription = applyOriginalDescription(plannerText, "Operator request");
    const withAllHygiene = applyFrontendUxCriteria(withOriginalDescription, ["packages/dashboard/app/page.tsx"]);

    expect(computePlanApprovalFingerprint(withOriginalDescription)).toBe(
      computePlanApprovalFingerprint(plannerText),
    );
    expect(computePlanApprovalFingerprint(withAllHygiene)).toBe(
      computePlanApprovalFingerprint(plannerText),
    );
  });

  it("ignores Original Description when its verbatim body contains marker-like text", () => {
    const plannerText = "# Task: FN-1\n\n## Mission\n\nBuild the interface.\n";
    const descriptionWithMarker = [
      "Keep this literal marker in the task request:",
      "<!-- fusion-original-description:end -->",
      "It is description content, not the generated section boundary.",
    ].join("\n");

    expect(computePlanApprovalFingerprint(applyOriginalDescription(plannerText, descriptionWithMarker))).toBe(
      computePlanApprovalFingerprint(plannerText),
    );
  });

  it("preserves plan changes after an end-marker literal outside the generated section", () => {
    const plannerText = [
      "# Task: FN-1",
      "",
      "## Mission",
      "",
      "Build the interface.",
      "",
      "<!-- fusion-original-description:end -->",
      "",
      "## Steps",
      "",
      "- [ ] Implement the original plan.",
      "",
    ].join("\n");
    const changedPlan = plannerText.replace("Implement the original plan.", "Implement the revised plan.");
    const description = "Operator request";

    expect(computePlanApprovalFingerprint(applyOriginalDescription(plannerText, description))).not.toBe(
      computePlanApprovalFingerprint(applyOriginalDescription(changedPlan, description)),
    );
  });

  it("differs when the operator-authored plan content actually changes", () => {
    const original = "# Task: FN-1\n\n## File Scope\n\n- a.ts\n";
    const changed = "# Task: FN-1\n\n## File Scope\n\n- a.ts\n- b.ts\n";
    expect(computePlanApprovalFingerprint(original)).not.toBe(computePlanApprovalFingerprint(changed));
  });

  it("produces a hex sha256-length digest", () => {
    expect(computePlanApprovalFingerprint("anything")).toMatch(/^[0-9a-f]{64}$/);
  });
});
