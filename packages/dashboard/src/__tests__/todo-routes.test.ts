// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { TodoItem, TodoList, TodoListWithItems } from "@fusion/core";
import { get as performGet, request as performRequest } from "../test-request.js";
import { createTodoRouter } from "../todo-routes.js";
import { ApiError } from "../api-error.js";

const mockGetOrCreateProjectStore = vi.fn();
vi.mock("../project-store-resolver.js", () => ({
  getOrCreateProjectStore: (...args: unknown[]) => mockGetOrCreateProjectStore(...args),
}));

function createMockTodoStore() {
  const lists = new Map<string, TodoList>();
  const items = new Map<string, TodoItem>();

  const listItemsForList = (listId: string) =>
    Array.from(items.values())
      .filter((item) => item.listId === listId)
      .sort((a, b) => a.sortOrder - b.sortOrder);

  return {
    createList: vi.fn((projectId: string, input: { title: string }) => {
      const id = `TDL-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const now = new Date().toISOString();
      const list: TodoList = {
        id,
        projectId,
        title: input.title,
        createdAt: now,
        updatedAt: now,
      };
      lists.set(id, list);
      return list;
    }),

    updateList: vi.fn((id: string, updates: { title?: string }) => {
      const existing = lists.get(id);
      if (!existing) return undefined;
      const updated: TodoList = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      };
      lists.set(id, updated);
      return updated;
    }),

    deleteList: vi.fn((id: string) => {
      const existed = lists.delete(id);
      for (const item of Array.from(items.values())) {
        if (item.listId === id) {
          items.delete(item.id);
        }
      }
      return existed;
    }),

    listLists: vi.fn((projectId: string) =>
      Array.from(lists.values()).filter((list) => list.projectId === projectId)
    ),

    getListsWithItems: vi.fn((projectId: string): TodoListWithItems[] =>
      Array.from(lists.values())
        .filter((list) => list.projectId === projectId)
        .map((list) => ({
          ...list,
          items: listItemsForList(list.id),
        }))
    ),

    getList: vi.fn((id: string) => lists.get(id)),

    getItem: vi.fn((id: string) => items.get(id)),

    listItems: vi.fn((listId: string) => listItemsForList(listId)),

    createItem: vi.fn((listId: string, input: { text: string }) => {
      if (!lists.has(listId)) {
        throw new Error(`Todo list ${listId} not found`);
      }
      const id = `TDI-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const now = new Date().toISOString();
      const item: TodoItem = {
        id,
        listId,
        text: input.text,
        completed: false,
        completedAt: null,
        sortOrder: listItemsForList(listId).length,
        createdAt: now,
        updatedAt: now,
      };
      items.set(id, item);
      return item;
    }),

    updateItem: vi.fn((id: string, updates: { text?: string; completed?: boolean }) => {
      const existing = items.get(id);
      if (!existing) return undefined;
      const now = new Date().toISOString();
      const updated: TodoItem = {
        ...existing,
        ...updates,
        completedAt:
          updates.completed === undefined
            ? existing.completedAt
            : updates.completed
              ? now
              : null,
        updatedAt: now,
      };
      items.set(id, updated);
      return updated;
    }),

    deleteItem: vi.fn((id: string) => items.delete(id)),

    reorderItems: vi.fn((listId: string, itemIds: string[]) => {
      const listItems = listItemsForList(listId);
      const existingIds = listItems.map((item) => item.id);

      if (new Set(itemIds).size !== itemIds.length) {
        throw new Error("Cannot reorder items: duplicate item IDs provided");
      }
      if (existingIds.length !== itemIds.length) {
        throw new Error("Cannot reorder items: provided IDs must include all items in the list");
      }
      for (let index = 0; index < itemIds.length; index += 1) {
        const item = items.get(itemIds[index]);
        if (item) {
          items.set(item.id, {
            ...item,
            sortOrder: index,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return listItemsForList(listId);
    }),
  };
}

describe("Todo Routes", () => {
  let app: express.Express;
  let mockTodoStore: ReturnType<typeof createMockTodoStore>;
  let mockStore: {
    getTodoStore: ReturnType<typeof vi.fn>;
    getRootDir: ReturnType<typeof vi.fn>;
    createTask: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockTodoStore = createMockTodoStore();
    mockStore = {
      getTodoStore: vi.fn(() => mockTodoStore),
      getRootDir: vi.fn(() => "/test/root"),
      createTask: vi.fn(async (input) => ({ id: "FN-TODO-TASK", ...input })),
    };

    mockGetOrCreateProjectStore.mockResolvedValue(mockStore);

    app = express();
    app.use(express.json());
    app.use("/api/todos", createTodoRouter(mockStore as never));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof ApiError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      if (err instanceof Error) {
        res.status(500).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Internal server error" });
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("list endpoints", () => {
    it("GET / returns all lists with items", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      mockTodoStore.createItem(list.id, { text: "Ship it" });

      const response = await performGet(app, "/api/todos?projectId=proj-a");
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(1);
      expect(response.body[0].title).toBe("Inbox");
      expect(response.body[0].items).toHaveLength(1);
    });

    it("GET /?projectId=X passes projectId to store", async () => {
      const response = await performGet(app, "/api/todos?projectId=proj-scope");
      expect(response.status).toBe(200);
      expect(mockTodoStore.getListsWithItems).toHaveBeenCalledWith("proj-scope");
      expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("proj-scope");
    });

    it("POST / creates a list with valid title", async () => {
      const response = await performRequest(
        app,
        "POST",
        "/api/todos",
        JSON.stringify({ title: " Today " }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(201);
      expect(response.body.title).toBe("Today");
    });

    it.each([
      [{}, "title is required"],
      [{ title: "" }, "title is required"],
      [{ title: "   " }, "title is required"],
      [{ title: "A".repeat(201) }, "200 characters"],
    ])("POST / rejects invalid title %#", async (body, message) => {
      const response = await performRequest(app, "POST", "/api/todos", JSON.stringify(body), {
        "Content-Type": "application/json",
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain(message);
    });

    it("PATCH /:id updates list title", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Old" });
      const response = await performRequest(
        app,
        "PATCH",
        `/api/todos/${list.id}`,
        JSON.stringify({ title: "New" }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(200);
      expect(response.body.title).toBe("New");
    });

    it("PATCH /:id returns 404 for nonexistent list", async () => {
      const response = await performRequest(
        app,
        "PATCH",
        "/api/todos/TDL-MISSING",
        JSON.stringify({ title: "Nope" }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toContain("not found");
    });

    it("DELETE /:id deletes list", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Delete me" });
      const response = await performRequest(app, "DELETE", `/api/todos/${list.id}`);
      expect(response.status).toBe(204);
      expect(mockTodoStore.deleteList).toHaveBeenCalledWith(list.id);
    });
  });

  describe("item endpoints", () => {
    it("GET /:id returns a list with its ordered items and 404s when missing", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const first = mockTodoStore.createItem(list.id, { text: "First" });
      const second = mockTodoStore.createItem(list.id, { text: "Second" });

      const response = await performGet(app, `/api/todos/${list.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: list.id, title: "Inbox" });
      expect(response.body.items.map((item: TodoItem) => item.id)).toEqual([first.id, second.id]);

      const missing = await performGet(app, "/api/todos/TDL-MISSING");
      expect(missing.status).toBe(404);
    });

    it("GET /:id/items returns ordered items and 404s for a missing list", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const first = mockTodoStore.createItem(list.id, { text: "First" });
      const second = mockTodoStore.createItem(list.id, { text: "Second" });

      const response = await performGet(app, `/api/todos/${list.id}/items`);
      expect(response.status).toBe(200);
      expect(response.body.map((item: TodoItem) => item.id)).toEqual([first.id, second.id]);

      const missing = await performGet(app, "/api/todos/TDL-MISSING/items");
      expect(missing.status).toBe(404);
    });

    it("GET /items/:id returns an item and 404s when missing", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Read me" });

      const response = await performGet(app, `/api/todos/items/${item.id}`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: item.id, text: "Read me" });

      const missing = await performGet(app, "/api/todos/items/TDI-MISSING");
      expect(missing.status).toBe(404);
    });

    it("POST /:id/items creates item with valid text", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const response = await performRequest(
        app,
        "POST",
        `/api/todos/${list.id}/items`,
        JSON.stringify({ text: " Buy milk " }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(201);
      expect(response.body.text).toBe("Buy milk");
    });

    it("POST /items/:id/create-task creates a task with todo provenance and no forced column", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Ship Todo API" });

      const response = await performRequest(app, "POST", `/api/todos/items/${item.id}/create-task`);
      expect(response.status).toBe(201);
      expect(response.body.id).toBe("FN-TODO-TASK");
      expect(mockStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        title: item.text.slice(0, 200),
        description: item.text,
        source: {
          sourceType: "api",
          sourceMetadata: { todoItemId: item.id, todoListId: item.listId },
        },
      }));
      expect(mockStore.createTask.mock.calls[0]?.[0]).not.toHaveProperty("column");
    });

    it("POST /items/:id/create-task honors trimmed optional task fields", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Original title" });

      const response = await performRequest(
        app,
        "POST",
        `/api/todos/items/${item.id}/create-task`,
        JSON.stringify({
          title: " Custom title ",
          priority: "high",
          workflowId: " workflow-custom ",
          assignedAgentId: " agent-1 ",
        }),
        { "Content-Type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockStore.createTask).toHaveBeenCalledWith(expect.objectContaining({
        title: "Custom title",
        priority: "high",
        workflowId: "workflow-custom",
        assignedAgentId: "agent-1",
      }));
    });

    it("POST /items/:id/create-task omits blank workflow and agent IDs", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Task" });

      const response = await performRequest(
        app,
        "POST",
        `/api/todos/items/${item.id}/create-task`,
        JSON.stringify({ workflowId: "  ", assignedAgentId: "\t" }),
        { "Content-Type": "application/json" },
      );

      expect(response.status).toBe(201);
      const input = mockStore.createTask.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(input).not.toHaveProperty("workflowId");
      expect(input).not.toHaveProperty("assignedAgentId");
    });

    it.each([
      [{ title: "   " }, "blank"],
      [{ title: "A".repeat(201) }, "200 characters"],
      [{ priority: "critical" }, "priority"],
    ])("POST /items/:id/create-task rejects invalid input %#", async (body, message) => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Task" });
      const response = await performRequest(
        app,
        "POST",
        `/api/todos/items/${item.id}/create-task`,
        JSON.stringify(body),
        { "Content-Type": "application/json" },
      );

      expect(response.status).toBe(400);
      expect(response.body.error).toContain(message);
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it("POST /items/:id/create-task returns 404 for a missing item", async () => {
      const response = await performRequest(app, "POST", "/api/todos/items/TDI-MISSING/create-task");
      expect(response.status).toBe(404);
      expect(mockStore.createTask).not.toHaveBeenCalled();
    });

    it.each([
      [{}, "text is required"],
      [{ text: "" }, "text is required"],
      [{ text: " ".repeat(3) }, "text is required"],
      [{ text: "A".repeat(2001) }, "2000 characters"],
    ])("POST /:id/items rejects invalid text %#", async (payload, message) => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const response = await performRequest(
        app,
        "POST",
        `/api/todos/${list.id}/items`,
        JSON.stringify(payload),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toContain(message);
    });

    it("PATCH /items/:id updates item text", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Old text" });

      const response = await performRequest(
        app,
        "PATCH",
        `/api/todos/items/${item.id}`,
        JSON.stringify({ text: "New text" }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(200);
      expect(response.body.text).toBe("New text");
    });

    it("PATCH /items/:id updates item completed status", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Task" });

      const response = await performRequest(
        app,
        "PATCH",
        `/api/todos/items/${item.id}`,
        JSON.stringify({ completed: true }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(200);
      expect(response.body.completed).toBe(true);
    });

    it("PATCH /items/:id rejects invalid completed type", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Task" });

      const response = await performRequest(
        app,
        "PATCH",
        `/api/todos/items/${item.id}`,
        JSON.stringify({ completed: "true" }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("completed must be a boolean");
    });

    it("PATCH /items/:id returns 404 for nonexistent item", async () => {
      const response = await performRequest(
        app,
        "PATCH",
        "/api/todos/items/TDI-MISSING",
        JSON.stringify({ text: "Nope" }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(404);
      expect(response.body.error).toContain("not found");
    });

    it("DELETE /items/:id deletes item", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Task" });

      const response = await performRequest(app, "DELETE", `/api/todos/items/${item.id}`);
      expect(response.status).toBe(204);
      expect(mockTodoStore.deleteItem).toHaveBeenCalledWith(item.id);
    });
  });

  describe("reorder endpoint", () => {
    it("POST /:id/items/reorder reorders items", async () => {
      const list = mockTodoStore.createList("proj-a", { title: "Inbox" });
      const item1 = mockTodoStore.createItem(list.id, { text: "One" });
      const item2 = mockTodoStore.createItem(list.id, { text: "Two" });

      const response = await performRequest(
        app,
        "POST",
        `/api/todos/${list.id}/items/reorder`,
        JSON.stringify({ itemIds: [item2.id, item1.id] }),
        { "Content-Type": "application/json" }
      );

      expect(response.status).toBe(204);
      expect(mockTodoStore.reorderItems).toHaveBeenCalledWith(list.id, [item2.id, item1.id]);
    });

    it.each([
      [{}, "itemIds must be an array"],
      [{ itemIds: "not-array" }, "itemIds must be an array"],
      [{ itemIds: ["ok", 123] }, "itemIds must be an array of strings"],
    ])("POST /:id/items/reorder rejects invalid itemIds %#", async (body, message) => {
      const response = await performRequest(
        app,
        "POST",
        "/api/todos/TDL-1/items/reorder",
        JSON.stringify(body),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(400);
      expect(response.body.error).toContain(message);
    });
  });

  describe("project scoping", () => {
    it("passes projectId from query param to list endpoint and resolver", async () => {
      const response = await performGet(app, "/api/todos?projectId=project-query");
      expect(response.status).toBe(200);
      expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("project-query");
      expect(mockTodoStore.getListsWithItems).toHaveBeenCalledWith("project-query");
    });

    it("passes projectId from body to create endpoint and resolver", async () => {
      const response = await performRequest(
        app,
        "POST",
        "/api/todos",
        JSON.stringify({ title: "List", projectId: "project-body" }),
        { "Content-Type": "application/json" }
      );
      expect(response.status).toBe(201);
      expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("project-body");
      expect(mockTodoStore.createList).toHaveBeenCalledWith("project-body", { title: "List" });
    });

    it("uses a body projectId to resolve the scoped store for create-task", async () => {
      const list = mockTodoStore.createList("project-body", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Scoped task" });

      const response = await performRequest(
        app,
        "POST",
        `/api/todos/items/${item.id}/create-task`,
        JSON.stringify({ projectId: "project-task-scope" }),
        { "Content-Type": "application/json" },
      );

      expect(response.status).toBe(201);
      expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("project-task-scope");
      expect(mockStore.createTask).toHaveBeenCalledTimes(1);
    });

    it("passes projectId from body to item update route via scoped resolver", async () => {
      const list = mockTodoStore.createList("project-body", { title: "Inbox" });
      const item = mockTodoStore.createItem(list.id, { text: "Initial" });

      const response = await performRequest(
        app,
        "PATCH",
        `/api/todos/items/${item.id}`,
        JSON.stringify({ text: "Updated", projectId: "project-body" }),
        { "Content-Type": "application/json" }
      );

      expect(response.status).toBe(200);
      expect(mockGetOrCreateProjectStore).toHaveBeenCalledWith("project-body");
    });
  });
});
