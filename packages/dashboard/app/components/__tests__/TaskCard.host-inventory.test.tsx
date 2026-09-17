import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

/**
 * Operational hosts: cards that carry the board's full behaviour (open, edit, menu, mutations).
 * These keep the default `interactionMode` and must stay exactly as they were.
 */
const operationalTaskCardHosts = [
  "Column.tsx",
  "DockTaskList.tsx",
  "WorktreeGroup.tsx",
  "dashboard/MainContent.tsx",
  "useRightDockController.tsx",
] as const;

/*
FNXC:TaskSearch 2026-09-17-09:41:
FN-477 added a SIXTH host, and it is deliberately listed apart: the header search results panel is a
read-only SELECTION surface. It is the only host allowed to pass `interactionMode="search-result"`,
and the five operational hosts must never adopt it — that is the difference this split ratchets. It
renders the canonical card rather than a copied miniature so a result measures and reads exactly like
the board card it refers to.
*/
const selectionTaskCardHosts = ["TaskSearchResultsPopover.tsx"] as const;

const taskCardHosts = [...operationalTaskCardHosts, ...selectionTaskCardHosts].sort();

describe("TaskCard host inventory (FN-321)", () => {
  it("keeps the exact production host set delegated to the canonical TaskCard", () => {
    const discoveredHosts = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__/"))
      .filter((relativePath) => readAppFile(`components/${relativePath}`).includes("<TaskCard"));

    expect([...discoveredHosts].sort()).toEqual(taskCardHosts);
    for (const relativePath of taskCardHosts) {
      const source = readAppFile(`components/${relativePath}`);
      expect(source, relativePath).toMatch(/import\s+\{\s*TaskCard\s*\}\s+from/);
      expect(source, relativePath).toMatch(/<TaskCard\b/);
    }
  });

  it("reserves the read-only result mode for the selection host alone", () => {
    const resultModeHosts = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__/"))
      .filter((relativePath) => /interactionMode\s*=\s*["{]\s*"?search-result/.test(readAppFile(`components/${relativePath}`)));

    expect(resultModeHosts).toEqual([...selectionTaskCardHosts]);

    // The board's operational hosts keep the default mode: no search-result opt-in anywhere.
    for (const relativePath of operationalTaskCardHosts) {
      expect(readAppFile(`components/${relativePath}`), relativePath).not.toContain("search-result");
    }
  });

  it("keeps the files affordance implementation inside TaskCard only", () => {
    const producers = listComponentFiles()
      .filter((relativePath) => !relativePath.includes("__tests__/"))
      .filter((relativePath) => readAppFile(`components/${relativePath}`).includes("card-session-files"));
    expect(producers).toEqual(["TaskCard.tsx"]);
  });
});
