import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const findingPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/solutions/integration-issues/grok-cli-usage-data-source.md",
);

const canonicalVerdicts = [
  "VERDICT FN-8689: SOURCE+LIVE — provenance chain proven; source-identified request and formatter arithmetic recorded; numeric formatter inputs confirmed by redacted harness capture.",
  "VERDICT FN-8689: SOURCE-ONLY — BLOCKED, live confirmation unavailable. Provenance chain proven and source-identified request/arithmetic recorded; no harness-confirmed numeric inputs.",
  "VERDICT FN-8689: STATIC-BLOCKED — BLOCKED, source provenance unrecoverable. No provenance chain proven; no source-identified request and no live capture performed.",
] as const;

const canonicalFn8690Verdicts = [
  "VERDICT FN-8690: CONFIRMED — source pinned; /usage handler read; redacted capture returned allow-listed values for every source-consumed meter field; request and display arithmetic recorded.",
  "VERDICT FN-8690: NO-FIELDS — source pinned and handler read; redacted capture proved every source-consumed operand field is absent from this account's response.",
  "VERDICT FN-8690: BLOCKED-NO-SOURCE — source could not be pinned. Blocker recorded; no source-identified request or formula asserted.",
  "VERDICT FN-8690: BLOCKED-NO-CAPTURE — source pinned and handler read; request and display arithmetic recorded from source, but the redacted capture could not confirm the source-consumed operands. Blocker recorded; no live-derived formula asserted.",
] as const;

describe("Grok CLI usage source finding", () => {
  const finding = readFileSync(findingPath, "utf8");

  it("keeps the required solution frontmatter and provenance record", () => {
    expect(finding).toMatch(/^---\ncategory: integration-issues\nmodule: packages\/dashboard\/src\/usage\.ts\ntags: \[[^\]]+\]\nproblem_type: upstream-provenance-mismatch\napplies_when: .+\n---/);
    expect(finding).toContain("## Source provenance (FN-8689)");
    expect(finding).toContain("Retrieval method");
    expect(finding).toContain("0.2.118");
    expect(finding).toContain("Installed SHA-256");
    expect(finding).toMatch(/candidate-only|No official `version → asset filename → published digest → source tag\/commit` chain/i);
    expect(finding).toContain("repository-not-found");
  });

  it("records exactly one canonical FN-8689 verdict", () => {
    const verdictLines = finding
      .split("\n")
      .filter((line) => line.startsWith("VERDICT FN-8689:"));

    expect(verdictLines).toHaveLength(1);
    expect(canonicalVerdicts).toContain(verdictLines[0] as (typeof canonicalVerdicts)[number]);
  });

  it("records one canonical FN-8690 verdict and the required evidence sections", () => {
    const verdictLines = finding
      .split("\n")
      .filter((line) => line.startsWith("VERDICT FN-8690:"));

    expect(verdictLines).toHaveLength(1);
    expect(canonicalFn8690Verdicts).toContain(verdictLines[0] as (typeof canonicalFn8690Verdicts)[number]);
    expect(finding).toContain("## Source provenance (FN-8690)");
    expect(finding).toContain("## Source-identified handler, request, and arithmetic (FN-8690)");
    expect(finding).toContain("## Redacted replay (FN-8690)");
    expect(finding).toContain("### Source-named operand classification");
    expect(finding).toContain("## FN-8668 hand-off (FN-8690)");
  });

  it("does not commit credential-shaped material", () => {
    expect(finding).not.toMatch(/Bearer\s+/);
    expect(finding).not.toContain("eyJ");
    expect(finding).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(finding).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  });
});
