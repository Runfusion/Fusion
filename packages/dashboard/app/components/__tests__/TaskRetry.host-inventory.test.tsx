import { describe, expect, it } from "vitest";
import { listComponentFiles, readAppFile } from "../../test/cssFixture";

const component = (name: string) => readAppFile(`components/${name}`);

const menuHosts = ["TaskCard.tsx", "ListView.tsx", "TaskDetailModal.tsx"];
const passThroughHosts = ["Board.tsx", "Column.tsx", "WorktreeGroup.tsx", "AppModals.tsx", "dashboard/MainContent.tsx", "dashboard/MainViewKeepAlive.tsx", "useRightDockController.tsx"];

describe("Retry host inventory", () => {
  it("wires the shared action model and stage copy in every menu host", () => {
    for (const name of menuHosts) {
      const source = component(name);
      expect(source).toContain("buildTaskActionMenuModel");
      expect(source).toContain("onRetry");
      expect(source).toContain("resolveRetryStageCopy");
    }
  });

  /*
  FNXC:ColumnRestart 2026-09-17-09:16:
  FN-499: the preserve-work choice belongs to the three menu hosts that own the Retry confirmation.
  A pass-through host merely forwards the callback and must never grow its own prompt.
  */
  it("owns the preserve-work confirmation only in the menu hosts", () => {
    for (const name of menuHosts) {
      const source = component(name);
      expect(source, name).toContain("confirmWithCheckbox");
      expect(source, name).toContain("preserveWork");
      expect(source, name).toContain("preserveWorkAvailable");
    }
    for (const name of passThroughHosts) {
      expect(component(name), name).not.toContain("preserveWorkAvailable");
    }
  });

  it("keeps the direct Reset-dialog host inventory exact", () => {
    const directHosts = listComponentFiles()
      .filter((path) => !path.includes("__tests__/") && readAppFile(`components/${path}`).includes("<TaskResetDialog"));
    expect(directHosts.sort()).toEqual([...menuHosts].sort());

    for (const name of [...menuHosts, ...passThroughHosts]) {
      expect(component(name)).toContain("onResetTask");
    }
    expect(readAppFile("App.tsx")).toContain("resetTask");
  });

  it("keeps stage restart and the removed recovery action deleted while Reset stays locally owned", () => {
    const removedAction = ["re", "specify"].join("");
    const allHosts = [...menuHosts, "TaskContextMenu.tsx", ...passThroughHosts];
    for (const name of allHosts) {
      const source = component(name);
      expect(source).not.toContain("onRestart" + "Stage");
      expect(source.toLowerCase()).not.toContain(removedAction);
    }
    for (const name of menuHosts) {
      expect(component(name)).toContain('import { TaskResetDialog } from "./TaskResetDialog";');
    }
    for (const name of passThroughHosts) {
      expect(component(name)).not.toContain("TaskResetDialog");
    }
  });
});
