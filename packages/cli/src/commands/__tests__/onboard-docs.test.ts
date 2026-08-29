import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const binSource = readFileSync(resolve(__dirname, "../../bin.ts"), "utf8");
const cliReference = readFileSync(resolve(__dirname, "../../../../../docs/cli-reference.md"), "utf8");

function extractOnboardSection(markdown: string): string {
  const start = markdown.indexOf("## `fn onboard`");
  const end = markdown.indexOf("---", start);
  return start >= 0 ? markdown.slice(start, end >= 0 ? end : undefined) : "";
}

describe("onboard help/docs parity", () => {
  it("always documents fn onboard and --force in both HELP and CLI reference", () => {
    const onboardDocs = extractOnboardSection(cliReference);

    expect(binSource).toContain("fn onboard");
    expect(onboardDocs).toContain("fn onboard");

    expect(binSource).toContain("--force");
    expect(onboardDocs).toContain("--force");
  });

  it("keeps conditional onboarding escape hatches in parity between HELP and docs", () => {
    const onboardDocs = extractOnboardSection(cliReference);
    const parityTerms = ["--skip-onboarding", "FUSION_SKIP_ONBOARDING"];

    for (const term of parityTerms) {
      expect(binSource.includes(term)).toBe(onboardDocs.includes(term));
    }
  });
});
