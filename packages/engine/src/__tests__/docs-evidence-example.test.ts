import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectExternalIntegrationEvidenceGaps } from "../spec-validation/external-integration-evidence.js";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const contributingPath = resolve(workspaceRoot, "docs", "contributing.md");

function extractEvidenceExample(): string {
  const contributing = readFileSync(contributingPath, "utf8");
  const match = contributing.match(
    /<!-- evidence-example:start -->([\s\S]*?)<!-- evidence-example:end -->/,
  );
  expect(match?.[1]).toBeDefined();

  const fenced = match?.[1]?.trim() ?? "";
  const fenceMatch = fenced.match(/^```markdown\r?\n([\s\S]*?)\r?\n```$/);
  expect(fenceMatch?.[1]).toBeDefined();
  return fenceMatch?.[1] ?? "";
}

describe("documented external integration evidence example", () => {
  it("satisfies the spec-validation gate", () => {
    const example = extractEvidenceExample();

    expect(detectExternalIntegrationEvidenceGaps({ promptContent: example })).toEqual([]);
  });

  it("fails the gate when checksum evidence is removed", () => {
    const example = extractEvidenceExample();
    const withoutChecksum = example.replace(/^- Checksum:.*$/m, "- Checksum:");

    const findings = detectExternalIntegrationEvidenceGaps({ promptContent: withoutChecksum });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.missing).toContain("checksum-or-source-of-truth-evidence");
  });
});
