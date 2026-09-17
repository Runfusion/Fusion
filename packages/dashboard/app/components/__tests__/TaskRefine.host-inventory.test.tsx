import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

const component = (name: string) => readAppFile(`components/${name}`);

const menuHosts = ["TaskCard.tsx", "ListView.tsx", "TaskDetailModal.tsx"];
const passThroughHosts = ["Board.tsx", "Column.tsx", "WorktreeGroup.tsx", "AppModals.tsx", "dashboard/MainContent.tsx", "dashboard/MainViewKeepAlive.tsx", "useRightDockController.tsx"];

/*
FNXC:TaskRefine 2026-09-14-22:23:
FN-400 symptom: Refine opened the whole task record before showing its composer, because the card and the list row
only bubbled the intent up to a host that called the detail-open deep link. The composer is now a standalone dialog
owned by exactly the three menu hosts, and the routing that made a record open is deleted, not merely unused.
*/
describe("Refine host inventory", () => {
  it("keeps the direct Refine-dialog host inventory exact", () => {
    const directHosts = listComponentFiles()
      .filter((path) => !path.includes("__tests__/") && readAppFile(`components/${path}`).includes("<TaskRefineDialog"));
    expect(directHosts.sort()).toEqual([...menuHosts].sort());

    for (const name of menuHosts) {
      /*
      FNXC:TaskFollowUp 2026-09-17-18:10:
      FN-513 reuses this composer for Follow-up, so each host also imports its MODE type. The import
      is asserted as a structural guarantee that the mode is a compile-time contract rather than a
      loose string each host re-invents.
      */
      expect(component(name)).toContain('import { TaskRefineDialog, type TaskRefineDialogMode } from "./TaskRefineDialog";');
    }
  });

  /*
  FNXC:TaskFollowUp 2026-09-17-18:10:
  FN-513 adds a SECOND affordance to exactly the same three hosts. The inventory is asserted here too
  so a fourth host — or a pass-through host that starts bubbling the intent upward again, which is the
  deep-link shape FN-400 deleted — fails immediately.
  */
  it("keeps the direct Follow-up host inventory identical to the Refine one", () => {
    const followUpHosts = listComponentFiles()
      .filter((path) => !path.includes("__tests__/") && readAppFile(`components/${path}`).includes("onOpenFollowUp"))
      .filter((path) => path !== "TaskContextMenu.tsx");
    expect(followUpHosts.sort()).toEqual([...menuHosts].sort());

    // The menu itself declares the prop and the descriptor; it never renders the composer.
    expect(component("TaskContextMenu.tsx")).toContain("onOpenFollowUp");
    expect(component("TaskContextMenu.tsx")).not.toContain("<TaskRefineDialog");
  });

  it("keeps every pass-through host free of the dialog and of the removed bubbling props", () => {
    for (const name of passThroughHosts) {
      const source = component(name);
      expect(source, name).not.toContain("TaskRefineDialog");
      expect(source, name).not.toContain("onOpenRefine");
      expect(source, name).not.toContain("onOpenFollowUp");
    }
  });

  it("forwards only the created refinement upward from the board and list chains", () => {
    for (const name of ["TaskCard.tsx", "ListView.tsx", "Board.tsx", "Column.tsx", "WorktreeGroup.tsx", "dashboard/MainContent.tsx", "dashboard/MainViewKeepAlive.tsx"]) {
      expect(component(name), name).toContain("onRefinementCreated");
    }
  });

  it("leaves no trace of the deleted detail-open refine route", () => {
    const appFiles = [
      ...listComponentFiles().filter((path) => !path.includes("__tests__/")).map((path) => `components/${path}`),
      "hooks/useModalManager.ts",
      "App.tsx",
    ];
    const offenders = appFiles.filter((path) => {
      const source = readAppFile(path);
      return source.includes('initialAction: "refine"')
        || source.includes("DetailTaskInitialAction")
        || source.includes("detailTaskInitialAction")
        || source.includes("detail-refine-");
    });
    expect(offenders).toEqual([]);
  });
});
