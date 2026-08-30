import { describe, expect, it } from "vitest";
import { deriveRemediationSteps } from "../executor/derive-remediation-steps.js";

describe("deriveRemediationSteps", () => {
  const base = { gateStepId: "code-review", wave: 1, prompt: "## File Scope\n- `src/**`", changedFiles: [] } as const;

  it("turns each blocking code-review finding into provenance-backed work", () => {
    const result = deriveRemediationSteps({
      ...base,
      gate: "Code Review",
      findings: [{ id: "finding-1", title: "wrong guard", body: "Reverse the guard", filePath: "src/guard.ts", line: 8, severity: "critical" }],
    });
    expect(result.steps).toEqual([expect.objectContaining({
      name: "Fix: Reverse the guard",
      status: "pending",
      remediation: expect.objectContaining({ gate: "Code Review", findingId: "finding-1", filePath: "src/guard.ts", line: 8 }),
    })]);
    expect(result.steps[0].name).not.toMatch(/test|verif|qa|review/i);
  });

  it("does not create work for non-blocking or out-of-scope findings", () => {
    const nonBlocking = deriveRemediationSteps({
      ...base, gate: "Code Review",
      findings: [{ id: "note", title: "note", body: "note", filePath: "src/a.ts", severity: "medium" }],
    });
    expect(nonBlocking.steps).toEqual([]);

    const upstream = deriveRemediationSteps({
      ...base, gate: "Code Review",
      findings: [{ id: "upstream", title: "upstream", body: "outside", filePath: "other/a.ts", severity: "critical" }],
    });
    expect(upstream).toMatchObject({ steps: [], reason: "upstream-out-of-scope" });
    expect(upstream.outOfScope).toEqual([{ filePath: "other/a.ts", detail: "outside" }]);
  });

  it("derives distinct verification files and a fallback when output has none", () => {
    const files = deriveRemediationSteps({ ...base, gate: "Verification", gateStepId: "verification", verificationCommandLabel: "testCommand", verificationOutput: "src/a.ts:3 failed\nsrc/b.ts:6 failed" });
    expect(files.steps.map((step) => step.remediation?.filePath)).toEqual(["src/a.ts", "src/b.ts"]);
    const fallback = deriveRemediationSteps({ ...base, gate: "Verification", gateStepId: "verification", verificationCommandLabel: "buildCommand", verificationOutput: "failed" });
    expect(fallback.steps).toHaveLength(1);
    expect(fallback.steps[0].name).toBe("Fix: Fix failing buildCommand");
  });
});
