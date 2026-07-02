import { Router, type Request, type Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { TaskStore } from "@fusion/core";
import {
  ApiError,
  badRequest,
  notFound,
  internalError,
} from "./api-error.js";
import { getOrCreateProjectStore } from "./project-store-resolver.js";

function rethrowAsApiError(error: unknown, fallbackMessage = "Internal server error"): never {
  if (error instanceof ApiError) {
    throw error;
  }
  if (error instanceof Error && error.message) {
    throw internalError(error.message);
  }
  throw internalError(fallbackMessage);
}

function validateTitle(title: unknown): string {
  if (!title || typeof title !== "string" || !title.trim()) {
    throw badRequest("title is required");
  }
  if (title.length > 200) {
    throw badRequest("title must not exceed 200 characters");
  }
  return title.trim();
}

function validateText(text: unknown): string {
  if (!text || typeof text !== "string" || !text.trim()) {
    throw badRequest("text is required");
  }
  if (text.length > 2000) {
    throw badRequest("text must not exceed 2000 characters");
  }
  return text.trim();
}

function validateBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw badRequest(`${field} must be a boolean`);
  }
  return value;
}

function validateStringArray(arr: unknown, fieldName: string): string[] {
  if (!Array.isArray(arr)) {
    throw badRequest(`${fieldName} must be an array`);
  }
  if (!arr.every((item) => typeof item === "string")) {
    throw badRequest(`${fieldName} must be an array of strings`);
  }
  return arr;
}

export function createTodoRouter(store: TaskStore): Router {
  const router = Router();
  const requestContext = new AsyncLocalStorage<TaskStore>();

  function getProjectIdFromRequest(req: Request): string | undefined {
    if (typeof req.query.projectId === "string" && req.query.projectId.trim()) {
      return req.query.projectId;
    }
    if (req.body && typeof req.body === "object" && typeof req.body.projectId === "string" && req.body.projectId.trim()) {
      return req.body.projectId;
    }
    return undefined;
  }

  function getScopedStore(): TaskStore {
    const scoped = requestContext.getStore();
    return scoped ?? store;
  }

  router.use(async (req: Request, _res: Response, next) => {
    try {
      const projectId = getProjectIdFromRequest(req);
      const scopedStore = projectId ? await getOrCreateProjectStore(projectId) : store;
      requestContext.run(scopedStore, next);
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (req, res) => {
    try {
      const projectId = getProjectIdFromRequest(req) ?? "";
      const todoStore = getScopedStore().getTodoStore();
      const lists = await todoStore.getListsWithItems(projectId);
      res.json(lists);
    } catch (error) {
      rethrowAsApiError(error, "Failed to list todo lists");
    }
  });

  router.post("/", async (req, res) => {
    try {
      const projectId = getProjectIdFromRequest(req) ?? "";
      const title = validateTitle((req.body as { title?: unknown }).title);
      const todoStore = getScopedStore().getTodoStore();
      const list = await todoStore.createList(projectId, { title });
      res.status(201).json(list);
    } catch (error) {
      rethrowAsApiError(error, "Failed to create todo list");
    }
  });

  router.patch("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const input = req.body as { title?: unknown };

      if (input.title === undefined) {
        throw badRequest("At least one field must be provided");
      }

      const title = validateTitle(input.title);
      const todoStore = getScopedStore().getTodoStore();
      const updated = await todoStore.updateList(id, { title });

      if (!updated) {
        throw notFound(`Todo list ${id} not found`);
      }

      res.json(updated);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update todo list");
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const todoStore = getScopedStore().getTodoStore();
      await todoStore.deleteList(id);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to delete todo list");
    }
  });

  router.post("/:id/items", async (req, res) => {
    try {
      const { id: listId } = req.params;
      const text = validateText((req.body as { text?: unknown }).text);
      const todoStore = getScopedStore().getTodoStore();
      const item = await todoStore.createItem(listId, { text });
      res.status(201).json(item);
    } catch (error) {
      rethrowAsApiError(error, "Failed to create todo item");
    }
  });

  router.patch("/items/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const input = req.body as { text?: unknown; completed?: unknown };
      const updates: { text?: string; completed?: boolean } = {};

      if (input.text !== undefined) {
        updates.text = validateText(input.text);
      }
      if (input.completed !== undefined) {
        updates.completed = validateBoolean(input.completed, "completed");
      }
      if (Object.keys(updates).length === 0) {
        throw badRequest("At least one field must be provided");
      }

      const todoStore = getScopedStore().getTodoStore();
      const item = await todoStore.updateItem(id, updates);
      if (!item) {
        throw notFound(`Todo item ${id} not found`);
      }

      res.json(item);
    } catch (error) {
      rethrowAsApiError(error, "Failed to update todo item");
    }
  });

  router.delete("/items/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const todoStore = getScopedStore().getTodoStore();
      await todoStore.deleteItem(id);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to delete todo item");
    }
  });

  router.post("/:id/items/reorder", async (req, res) => {
    try {
      const { id: listId } = req.params;
      const itemIds = validateStringArray((req.body as { itemIds?: unknown }).itemIds, "itemIds");
      const todoStore = getScopedStore().getTodoStore();
      await todoStore.reorderItems(listId, itemIds);
      res.status(204).send();
    } catch (error) {
      rethrowAsApiError(error, "Failed to reorder todo items");
    }
  });

  return router;
}
