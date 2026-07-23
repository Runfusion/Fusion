import { describe, expect, it } from "vitest";
import {
  normalizeValidationDiagnostics,
  renderValidationCause,
  renderValidationFailureDescription,
  VALIDATION_DIAGNOSTICS_MAX_EVIDENCE_PER_ASSERTION,
  VALIDATION_DIAGNOSTICS_MAX_TEXT_BYTES,
} from "../missions/mission-types.js";

describe("validation diagnostics normalization", () => {
  it("preserves order, limits evidence, and records omissions", () => {
    const result = normalizeValidationDiagnostics({
      runId: "VR-1", sourceFeatureId: "F-1", outcome: "fail",
      assertions: [{ assertionId: "CA-1", passed: false, evidence: Array.from({ length: 17 }, (_, index) => ({ text: `evidence-${index}` })) }],
    });
    expect(result.assertions[0].evidence).toHaveLength(VALIDATION_DIAGNOSTICS_MAX_EVIDENCE_PER_ASSERTION);
    expect(result.assertions[0].evidence[0].text).toBe("evidence-0");
    expect(result.assertions[0].omittedEvidenceCount).toBe(1);
  });

  it("redacts before safely truncating multibyte evidence and fields", () => {
    const result = normalizeValidationDiagnostics({
      runId: "VR-1", sourceFeatureId: "F-1", outcome: "fail",
      projectRoot: "/repo",
      assertions: [{ assertionId: "CA-1", passed: false, message: `token=secret-value ${"😀".repeat(2000)}`, expected: "/repo/src/example.ts", actual: "/private/tmp/secret.txt", evidence: [{ text: "Authorization: Bearer sk-live-ABCDEFG1234567890abcdef" }] }],
    });
    const assertion = result.assertions[0];
    expect(assertion.message).toContain("[REDACTED]");
    expect(Buffer.byteLength(assertion.message!, "utf8")).toBeLessThanOrEqual(VALIDATION_DIAGNOSTICS_MAX_TEXT_BYTES);
    expect(assertion.expected).toBe("src/example.ts");
    expect(assertion.actual).toBe("[external path omitted]");
    expect(assertion.evidence[0].text).toContain("[REDACTED]");
    expect(assertion.message).toContain("… [truncated]");
  });

  it("omits Windows absolute paths outside the project root", () => {
    const result = normalizeValidationDiagnostics({
      runId: "VR-1", sourceFeatureId: "F-1", outcome: "fail",
      projectRoot: "C:\\repo",
      assertions: [{ assertionId: "CA-1", passed: false, evidence: [{ text: "C:\\external\\secret.txt" }, { text: "C:\\repo\\src\\proof.test.ts" }] }],
    });
    expect(result.assertions[0].evidence.map((entry) => entry.text)).toEqual(["[external path omitted]", "src/proof.test.ts"]);
  });

  it("renders outcome-consistent event and remediation prose", () => {
    const diagnostics = normalizeValidationDiagnostics({
      runId: "VR-1", sourceFeatureId: "F-1", outcome: "fail",
      assertions: [
        { assertionId: "CA-pass", verdict: "pass", passed: true },
        { assertionId: "CA-fail", verdict: "fail", passed: false, expected: "green", actual: "red" },
        { assertionId: "CA-blocked", verdict: "blocked", passed: false, message: "Service unavailable" },
      ],
    });
    const eventDescription = renderValidationFailureDescription(diagnostics);
    expect(eventDescription).toContain("CA-fail");
    expect(eventDescription).toContain("CA-blocked");
    expect(eventDescription).toContain("1 assertion failed");
    expect(eventDescription).toContain("1 assertion is blocked");
    expect(eventDescription).not.toContain("CA-pass");
    const remediationCause = renderValidationCause(diagnostics);
    expect(remediationCause).toContain("Validator run: VR-1");
    expect(remediationCause).toContain("Blocked assertions: CA-blocked");
    expect(remediationCause).toContain("### CA-blocked (blocked)");
  });
});
