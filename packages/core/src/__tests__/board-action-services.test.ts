import { describe, expect, it, vi } from "vitest";
import { UNATTRIBUTED_MUTATION_CONTEXT } from "../identity/mutation-context.js";
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

    /*
    FNXC:Identity 2026-08-09-03:04 (U18):
    The mutation context is asserted POSITIONALLY, not waved through with `expect.anything()`. This
    seam is a census entry precisely because it forwards the unattributed marker today; when U9 gives
    the board routes a real actor, this assertion is what fails and names the line to change, rather
    than silently accepting whatever context happens to arrive.
    */
    expect(store.moveTask).toHaveBeenCalledWith("FN-ACTION", "todo", {
      preserveProgress: true,
      moveSource: "engine",
    }, UNATTRIBUTED_MUTATION_CONTEXT);
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

    expect(store.updateTask).toHaveBeenCalledWith("FN-ACTION", { title: "Updated" }, UNATTRIBUTED_MUTATION_CONTEXT);
  });
});
