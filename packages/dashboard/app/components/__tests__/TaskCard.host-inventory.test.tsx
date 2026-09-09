import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

const taskCardHosts = [
  "Column.tsx",
  "DockTaskList.tsx",
  "WorktreeGroup.tsx",
  "dashboard/MainContent.tsx",
  "useRightDockController.tsx",
] as const;

describe("TaskCard host inventory (FN-321)", () => {
  it("keeps the exact production host set delegated to the canonical TaskCard", () => {
    const discoveredHosts = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__/"))
      .filter((relativePath) => readAppFile(`components/${relativePath}`).includes("<TaskCard"));

    expect(discoveredHosts).toEqual([...taskCardHosts]);
    for (const relativePath of taskCardHosts) {
      const source = readAppFile(`components/${relativePath}`);
      expect(source, relativePath).toMatch(/import\s+\{\s*TaskCard\s*\}\s+from/);
      expect(source, relativePath).toMatch(/<TaskCard\b/);
    }
  });

  it("keeps the files affordance implementation inside TaskCard only", () => {
    const producers = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__/"))
      .filter((relativePath) => readAppFile(`components/${relativePath}`).includes("card-session-files"));
    expect(producers).toEqual(["TaskCard.tsx"]);
  });
});
