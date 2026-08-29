import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readAppFile } from "../../test/cssFixture";

describe("PlanningModeModal initial surface", () => {
  it("keeps the sequential interview surfaces available", () => {
    const source = readAppFile("components/PlanningModeModal.tsx");
    expect(source).toContain('data-testid="planning-plan-review"');
    expect(source).toContain('data-testid="planning-refine-menu"');
    expect(source).toContain('data-testid="planning-create-retry"');
  });
});
