import { describe, expect, it } from "vitest";
import {
  applyReviewSeverityGate,
  formatFindingsByPriority,
  formatResolvedFindings,
  isBlockingFinding,
  resolveReviewBlockingSeverity,
  DEFAULT_CODE_REVIEW_BLOCKING_SEVERITY,
  DEFAULT_PLAN_REVIEW_BLOCKING_SEVERITY,
} from "../workflows/review-severity-gate.js";
import type { WorkflowReviewFinding } from "../types.js";

function finding(overrides: Partial<WorkflowReviewFinding> = {}): WorkflowReviewFinding {
  return { id: "f1", title: "t", body: "b", ...overrides };
}

describe("resolveReviewBlockingSeverity", () => {
  it("defaults plan review to high (P0+P1) and code review to critical (P0)", () => {
    expect(resolveReviewBlockingSeverity({ reviewKind: "plan" })).toBe("high");
    expect(resolveReviewBlockingSeverity({ reviewKind: "code" })).toBe("critical");
    expect(DEFAULT_PLAN_REVIEW_BLOCKING_SEVERITY).toBe("high");
    expect(DEFAULT_CODE_REVIEW_BLOCKING_SEVERITY).toBe("critical");
  });

  it("prefers a stored workflow setting over the node value and the default", () => {
    expect(resolveReviewBlockingSeverity({
      reviewKind: "plan",
      workflowSettings: { planReviewBlockingSeverity: "any" },
      nodeBlockingSeverity: "critical",
    })).toBe("any");
    expect(resolveReviewBlockingSeverity({
      reviewKind: "code",
      workflowSettings: { codeReviewBlockingSeverity: "low" },
    })).toBe("low");
  });

  it("falls back to the node value, then the default, ignoring invalid values", () => {
    expect(resolveReviewBlockingSeverity({ reviewKind: "plan", nodeBlockingSeverity: "critical" })).toBe("critical");
    expect(resolveReviewBlockingSeverity({
      reviewKind: "plan",
      workflowSettings: { planReviewBlockingSeverity: "bogus" },
      nodeBlockingSeverity: 7,
    })).toBe("high");
  });

  it("reads each review kind from its own setting key", () => {
    // A plan-review override must not leak into code review's threshold.
    const settings = { planReviewBlockingSeverity: "any" };
    expect(resolveReviewBlockingSeverity({ reviewKind: "code", workflowSettings: settings })).toBe("critical");
  });
});

describe("isBlockingFinding", () => {
  it("blocks at the threshold and above", () => {
    expect(isBlockingFinding(finding({ severity: "critical" }), "high")).toBe(true);
    expect(isBlockingFinding(finding({ severity: "high" }), "high")).toBe(true);
    expect(isBlockingFinding(finding({ severity: "medium" }), "high")).toBe(false);
    expect(isBlockingFinding(finding({ severity: "low" }), "high")).toBe(false);
    expect(isBlockingFinding(finding({ severity: "high" }), "critical")).toBe(false);
  });

  it("treats an unclassified finding as blocking (fail closed)", () => {
    expect(isBlockingFinding(finding({ severity: undefined }), "critical")).toBe(true);
  });

  it("blocks everything at threshold \"any\"", () => {
    expect(isBlockingFinding(finding({ severity: "low" }), "any")).toBe(true);
  });

  it("never blocks review receipts or superseded findings", () => {
    for (const resolution of ["resolved-in-review", "superseded"] as const) {
      expect(isBlockingFinding(finding({ severity: "critical", resolution }), "critical")).toBe(false);
      expect(isBlockingFinding(finding({ severity: "critical", resolution }), "any")).toBe(false);
    }
  });
});

describe("applyReviewSeverityGate", () => {
  it("downgrades a REVISE whose findings are all below the threshold", () => {
    const result = applyReviewSeverityGate({
      verdict: "REVISE",
      findings: [finding({ id: "a", severity: "medium" }), finding({ id: "b", severity: "low" })],
      threshold: "high",
    });
    expect(result.verdict).toBe("APPROVE_WITH_NOTES");
    expect(result.downgraded).toBe(true);
    expect(result.blocking).toHaveLength(0);
    expect(result.advisory.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("keeps a REVISE that carries a finding at the threshold", () => {
    const result = applyReviewSeverityGate({
      verdict: "REVISE",
      findings: [finding({ id: "a", severity: "medium" }), finding({ id: "b", severity: "high" })],
      threshold: "high",
    });
    expect(result.verdict).toBe("REVISE");
    expect(result.downgraded).toBe(false);
    expect(result.blocking.map((f) => f.id)).toEqual(["b"]);
    expect(result.advisory.map((f) => f.id)).toEqual(["a"]);
  });

  it("applies the asymmetric built-in defaults: a high finding blocks plan review but not code review", () => {
    const findings = [finding({ severity: "high" })];
    expect(applyReviewSeverityGate({ verdict: "REVISE", findings, threshold: DEFAULT_PLAN_REVIEW_BLOCKING_SEVERITY }).verdict)
      .toBe("REVISE");
    expect(applyReviewSeverityGate({ verdict: "REVISE", findings, threshold: DEFAULT_CODE_REVIEW_BLOCKING_SEVERITY }).verdict)
      .toBe("APPROVE_WITH_NOTES");
  });

  /*
   * The fail-closed contract is the reason this gate is safe to enable by default: every reviewer that
   * does not opt into the structured findings schema keeps its full blocking power.
   */
  it("never downgrades a REVISE with no findings at all (prose-only reviewer)", () => {
    for (const findings of [undefined, []]) {
      const result = applyReviewSeverityGate({ verdict: "REVISE", findings, threshold: "critical" });
      expect(result.verdict).toBe("REVISE");
      expect(result.downgraded).toBe(false);
    }
  });

  it("never downgrades when any finding is unclassified", () => {
    const result = applyReviewSeverityGate({
      verdict: "REVISE",
      findings: [finding({ id: "a", severity: "low" }), finding({ id: "b", severity: undefined })],
      threshold: "critical",
    });
    expect(result.verdict).toBe("REVISE");
    expect(result.downgraded).toBe(false);
    expect(result.blocking.map((f) => f.id)).toEqual(["b"]);
  });

  it("restores pre-gate behavior at threshold \"any\"", () => {
    const result = applyReviewSeverityGate({
      verdict: "REVISE",
      findings: [finding({ severity: "low" })],
      threshold: "any",
    });
    expect(result.verdict).toBe("REVISE");
    expect(result.downgraded).toBe(false);
  });

  it("keeps an all-resolved REVISE fail-closed while exposing only audit receipts", () => {
    const result = applyReviewSeverityGate({
      verdict: "REVISE",
      findings: [finding({ id: "receipt", severity: "critical", resolution: "resolved-in-review" })],
      threshold: "any",
    });
    expect(result).toMatchObject({ verdict: "REVISE", downgraded: false, blocking: [], advisory: [] });
    expect(result.resolved.map((item) => item.id)).toEqual(["receipt"]);
  });

  it("only ever relaxes — an APPROVE carrying a critical finding is left alone", () => {
    for (const verdict of ["APPROVE", "APPROVE_WITH_NOTES", "CLOSE_NO_OP", undefined]) {
      const result = applyReviewSeverityGate({
        verdict,
        findings: [finding({ severity: "critical" })],
        threshold: "high",
      });
      expect(result.verdict).toBe(verdict);
      expect(result.downgraded).toBe(false);
    }
  });
});

describe("formatFindingsByPriority", () => {
  it("groups by priority with an explicit obligation per group", () => {
    const out = formatFindingsByPriority([
      finding({ id: "a", title: "boom", body: "breaks", severity: "critical", filePath: "src/a.ts", line: 12 }),
      finding({ id: "b", title: "maybe", body: "risky", severity: "high" }),
      finding({ id: "c", title: "nit-ish", body: "minor", severity: "low" }),
    ]);
    expect(out).toContain("### P0 — must fix");
    expect(out).toContain("### P1 — should fix");
    expect(out).toContain("### P2 — optional");
    expect(out).toContain("(src/a.ts:12)");
    expect(out).toContain("Skipping these is expected");
  });

  it("omits groups with no findings and returns empty for no findings", () => {
    const out = formatFindingsByPriority([finding({ severity: "critical" })]);
    expect(out).toContain("### P0 — must fix");
    expect(out).not.toContain("### P1");
    expect(out).not.toContain("### P2");
    expect(formatFindingsByPriority([])).toBe("");
  });

  it("presents unclassified findings with the strongest obligation, matching the fail-closed gate", () => {
    const out = formatFindingsByPriority([finding({ title: "unknown", body: "x" })]);
    expect(out).toContain("### Unclassified — treat as must fix");
  });

  it("omits non-open findings from priorities and renders audit receipts separately", () => {
    const receipt = finding({ id: "receipt", title: "Fixed", body: "Already handled", resolution: "resolved-in-review" });
    expect(formatFindingsByPriority([receipt])).toBe("");
    expect(formatResolvedFindings([receipt])).toContain("Already resolved during this review pass — do NOT redo");
    expect(formatResolvedFindings([receipt])).toContain("[resolved-in-review]");
  });
});
