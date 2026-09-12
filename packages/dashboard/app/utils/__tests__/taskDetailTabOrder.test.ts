import { beforeEach, describe, expect, it } from "vitest";
import {
  TASK_DETAIL_TAB_ORDER_STORAGE_KEY,
  loadTaskDetailTabOrder,
  moveTaskDetailTab,
  reconcileTaskDetailTabOrder,
  saveTaskDetailTabOrder,
} from "../taskDetailTabOrder";

describe("taskDetailTabOrder", () => {
  beforeEach(() => localStorage.clear());

  it.each([
    [null],
    [{ bad: true }],
    [["unknown", 4, "chat", "chat"]],
  ])("réconcilie les préférences absentes ou invalides", (stored) => {
    expect(reconcileTaskDetailTabOrder(stored, ["chat", "definition", "review"]))
      .toEqual(["chat", "definition", "review"]);
  });

  it("conserve l'ordre connu et insère les nouvelles destinations à leur place canonique", () => {
    expect(reconcileTaskDetailTabOrder(
      ["review", "chat", "plugin-old", "review"],
      ["chat", "definition", "changes", "review", "plugin-new"],
    )).toEqual(["definition", "changes", "review", "chat", "plugin-new"]);
  });

  it("sauvegarde par projet et refuse toute clé globale", () => {
    expect(saveTaskDetailTabOrder(undefined, ["definition", "chat"])).toBe(false);
    expect(localStorage.getItem(TASK_DETAIL_TAB_ORDER_STORAGE_KEY)).toBeNull();

    expect(saveTaskDetailTabOrder("project-a", ["definition", "chat"])).toBe(true);
    expect(loadTaskDetailTabOrder("project-a", ["chat", "definition"])).toEqual(["definition", "chat"]);
    expect(loadTaskDetailTabOrder("project-b", ["chat", "definition"])).toEqual(["chat", "definition"]);
  });

  it("déplace avant ou après sans dupliquer", () => {
    expect(moveTaskDetailTab(["chat", "definition", "review"], "chat", "review", "after"))
      .toEqual(["definition", "review", "chat"]);
    expect(moveTaskDetailTab(["chat", "definition"], "missing", "chat", "before"))
      .toEqual(["chat", "definition"]);
  });
});
