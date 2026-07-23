import { describe, expect, it, vi } from "vitest";
import { createBoardActionServices } from "../board/board-action-services.js";

describe("board action services", () => {
  it("delegates moves through the canonical TaskStore moveTask path", async () => {
    const task = { id: "FN-ACTION", column: "todo" };
    const store = {
      moveTask: vi.fn().mockResolvedValue(task),
      updateTask: vi.fn(),
    };

    await expect(createBoardActionServices(store as any).moveTask({
      taskId: "FN-ACTION",
      column: "todo",
      preserveProgress: true,
      source: "engine",
    })).resolves.toBe(task);

    expect(store.moveTask).toHaveBeenCalledWith("FN-ACTION", "todo", {
      preserveProgress: true,
      moveSource: "engine",
    });
  });

  it("delegates updates through the canonical TaskStore updateTask path", async () => {
    const task = { id: "FN-ACTION", title: "Updated" };
    const store = {
      moveTask: vi.fn(),
      updateTask: vi.fn().mockResolvedValue(task),
    };

    await expect(createBoardActionServices(store as any).updateTask({
      taskId: "FN-ACTION",
      updates: { title: "Updated" },
    })).resolves.toBe(task);

    expect(store.updateTask).toHaveBeenCalledWith("FN-ACTION", { title: "Updated" });
  });
});
