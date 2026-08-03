import { describe, expect, it, vi } from "vitest";
import { createTodoPluginRoutes } from "./todo-routes.js";

const routes = createTodoPluginRoutes();
function route(method: string, path: string) {
  const hit = routes.find((candidate) => candidate.method === method && candidate.path === path);
  if (!hit) throw new Error(`Missing ${method} ${path}`);
  return hit.handler;
}

describe("Todo plugin routes", () => {
  it("creates and reads a project-scoped list through the plugin namespace", async () => {
    const list = { id: "TDL-1", projectId: "project-a", title: "Inbox", createdAt: "now", updatedAt: "now" };
    const todoStore = { createList: vi.fn(async () => list), getListsWithItems: vi.fn(async () => [{ ...list, items: [] }]) };
    const ctx = { taskStore: { getTodoStore: () => todoStore }, resolveProjectTaskStore: vi.fn(async () => ({ getTodoStore: () => todoStore })) } as never;
    const created = await route("POST", "/todos")({ params: {}, body: { title: " Inbox ", projectId: "project-a" } }, ctx) as { status: number; body: typeof list };
    expect(created).toMatchObject({ status: 201, body: { title: "Inbox", projectId: "project-a" } });
    const listed = await route("GET", "/todos")({ params: {}, query: { projectId: "project-a" } }, ctx);
    expect(listed).toEqual([{ ...list, items: [] }]);
    expect(ctx.resolveProjectTaskStore).toHaveBeenCalledWith("project-a");
  });

  it("rejects invalid list titles", async () => {
    const ctx = { taskStore: { getTodoStore: () => ({ createList: vi.fn() }) } } as never;
    await expect(route("POST", "/todos")({ params: {}, body: { title: "" } }, ctx)).resolves.toEqual({ status: 400, body: { error: "title is required" } });
  });

  it("validates task options before looking up the todo item", async () => {
    const getItem = vi.fn();
    const ctx = { taskStore: { getTodoStore: () => ({ getItem }) } } as never;

    await expect(route("POST", "/todos/items/:id/create-task")({ params: { id: "missing" }, body: { workflowId: 12 } }, ctx))
      .resolves.toEqual({ status: 400, body: { error: "workflowId must be a string" } });
    expect(getItem).not.toHaveBeenCalled();

    await expect(route("POST", "/todos/items/:id/create-task")({ params: { id: "missing" }, body: { assignedAgentId: false } }, ctx))
      .resolves.toEqual({ status: 400, body: { error: "assignedAgentId must be a string" } });
    expect(getItem).not.toHaveBeenCalled();
  });

  it("preserves operational errors for the host's 500 error boundary", async () => {
    const failure = new Error("storage unavailable");
    const ctx = { taskStore: { getTodoStore: () => ({ getListsWithItems: vi.fn(async () => { throw failure; }) }) } } as never;
    await expect(route("GET", "/todos")({ params: {} }, ctx)).rejects.toBe(failure);
  });
});
