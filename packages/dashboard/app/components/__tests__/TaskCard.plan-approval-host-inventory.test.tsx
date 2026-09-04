import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const HOSTS = [
  "../Column.tsx",
  "../WorktreeGroup.tsx",
  "../DockTaskList.tsx",
  "../useRightDockController.tsx",
  "../dashboard/MainContent.tsx",
] as const;

function source(relativePath: string): string {
  return readAppFile(`components/${relativePath.replace(/^\.\.\//, "")}`);
}

describe("TaskCard plan-approval host inventory", () => {
  it("keeps the exact TaskCard host set with project and toast context", () => {
    const discovered = HOSTS.filter((relativePath) => source(relativePath).includes("<TaskCard"));
    expect(discovered).toEqual([...HOSTS]);
    for (const relativePath of HOSTS) {
      const taskCards = source(relativePath).match(/<TaskCard\b[\s\S]*?\/>/g) ?? [];
      expect(taskCards.length, relativePath).toBeGreaterThan(0);
      for (const taskCard of taskCards) {
        expect(taskCard, relativePath).toContain("projectId=");
        expect(taskCard, relativePath).toContain("addToast=");
      }
    }
  });
});
