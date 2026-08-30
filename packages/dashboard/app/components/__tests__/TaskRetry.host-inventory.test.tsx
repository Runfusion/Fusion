import { describe, expect, it } from "vitest";
import { readAppFile } from "../../test/cssFixture";

const component = (name: string) => readAppFile(`components/${name}`);

const menuHosts = ["TaskCard.tsx", "ListView.tsx", "TaskDetailModal.tsx"];
const passThroughHosts = ["Board.tsx", "Column.tsx", "WorktreeGroup.tsx", "AppModals.tsx", "dashboard/MainContent.tsx", "useRightDockController.tsx"];

describe("Retry host inventory", () => {
  it("wires the shared action model and stage copy in every menu host", () => {
    for (const name of menuHosts) {
      const source = component(name);
      expect(source).toContain("buildTaskActionMenuModel");
      expect(source).toContain("onRetry");
      expect(source).toContain("resolveRetryStageCopy");
    }
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
