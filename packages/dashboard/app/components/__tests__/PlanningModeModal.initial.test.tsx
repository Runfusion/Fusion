import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("PlanningModeModal initial surface", () => {
  it("keeps the sequential interview surfaces available", () => {
    const source = readFileSync(resolve(process.cwd(), "app/components/PlanningModeModal.tsx"), "utf8");
    expect(source).toContain('data-testid="planning-plan-review"');
    expect(source).toContain('data-testid="planning-refine-menu"');
    expect(source).toContain('data-testid="planning-create-retry"');
  });
});
