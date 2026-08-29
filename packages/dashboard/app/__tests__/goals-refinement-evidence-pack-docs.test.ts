import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Goals refinement evidence pack documentation", () => {
  it("documents the required evidence fields, activation threshold, and unmet-threshold rule", () => {
    const doc = readFileSync(
      resolve(__dirname, "../../../../docs/goals-refinement-evidence-pack.md"),
      "utf-8",
    );

    expect(doc).toContain("**Observed pain:**");
    expect(doc).toContain("**Frequency:**");
    expect(doc).toContain("**Impacted workflow:**");
    expect(doc).toContain("**Reproduction artifacts:**");

    expect(doc).toContain("at least two independent real-use observations");
    expect(doc).toContain(
      "Slice 4 remains pending and no implementation tasks are created",
    );
  });
});
