import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const taskCardHosts = [
  "../Column.tsx",
  "../DockTaskList.tsx",
  "../useRightDockController.tsx",
  "../WorktreeGroup.tsx",
  "../dashboard/MainContent.tsx",
] as const;

describe("TaskCard host inventory (FN-8561)", () => {
  it("keeps every shared-card host delegated to the canonical TaskCard", () => {
    for (const relativePath of taskCardHosts) {
      const source = readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
      expect(source, relativePath).toMatch(/import\s+\{\s*TaskCard\s*\}\s+from/);
      expect(source, relativePath).toMatch(/<TaskCard\b/);
    }
  });
});
