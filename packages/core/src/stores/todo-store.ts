import { EventEmitter } from "node:events";
import type { Database } from "../db/db.js";
import type {
  TodoList,
  TodoItem,
  TodoListCreateInput,
  TodoListUpdateInput,
  TodoItemCreateInput,
  TodoItemUpdateInput,
  TodoListWithItems,
} from "../types.js";

export interface TodoStoreEvents {
  "list:created": [TodoList];
  "list:updated": [TodoList];
  "list:deleted": [string];
  "item:created": [TodoItem];
  "item:updated": [TodoItem];
  "item:deleted": [string];
  "items:reordered": [{ listId: string; items: TodoItem[] }];
}

interface TodoListRow {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface TodoItemRow {
  id: string;
  listId: string;
  text: string;
  completed: number;
  completedAt: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export class TodoStore extends EventEmitter<TodoStoreEvents> {
  constructor(private db: Database) {
    super();
    this.setMaxListeners(50);
  }

  getDatabase(): Database {
    return this.db;
  }

  private generateListId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TDL-${timestamp}-${random}`;
  }

  private generateItemId(): string {
    const timestamp = Date.now().toString(36).toUpperCase();
    const random = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TDI-${timestamp}-${random}`;
  }

  private rowToTodoList(row: TodoListRow): TodoList {
    return {
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private rowToTodoItem(row: TodoItemRow): TodoItem {
    return {
      id: row.id,
      listId: row.listId,
      text: row.text,
      completed: row.completed === 1,
      completedAt: row.completedAt,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  createList(projectId: string, input: TodoListCreateInput): TodoList {
    const now = new Date().toISOString();
    const list: TodoList = {
      id: this.generateListId(),
      projectId,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(
      "INSERT INTO todo_lists (id, projectId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)"
    ).run(list.id, list.projectId, list.title, list.createdAt, list.updatedAt);

    this.db.bumpLastModified();
    this.emit("list:created", list);
    return list;
  }

  getList(id: string): TodoList | undefined {
    const row = this.db.prepare("SELECT * FROM todo_lists WHERE id = ?").get(id) as TodoListRow | undefined;
    return row ? this.rowToTodoList(row) : undefined;
  }

  listLists(projectId: string): TodoList[] {
    const rows = this.db.prepare(
      "SELECT * FROM todo_lists WHERE projectId = ? ORDER BY createdAt ASC, id ASC"
    ).all(projectId) as unknown as TodoListRow[];
    return rows.map((row) => this.rowToTodoList(row));
  }

  updateList(id: string, input: TodoListUpdateInput): TodoList | undefined {
    const existing = this.getList(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const title = input.title ?? existing.title;

    this.db.prepare("UPDATE todo_lists SET title = ?, updatedAt = ? WHERE id = ?").run(title, now, id);
    this.db.bumpLastModified();

    const updated = this.getList(id)!;
    this.emit("list:updated", updated);
    return updated;
  }

  deleteList(id: string): boolean {
    const result = this.db.prepare("DELETE FROM todo_lists WHERE id = ?").run(id) as { changes?: number };
    if ((result.changes ?? 0) < 1) return false;

    this.db.bumpLastModified();
    this.emit("list:deleted", id);
    return true;
  }

  createItem(listId: string, input: TodoItemCreateInput): TodoItem {
    const list = this.getList(listId);
    if (!list) {
      throw new Error(`Todo list ${listId} not found`);
    }

    const nextSortOrder = (() => {
      if (input.sortOrder !== undefined) return input.sortOrder;
      const row = this.db.prepare("SELECT MAX(sortOrder) AS maxSortOrder FROM todo_items WHERE listId = ?").get(listId) as
        | { maxSortOrder: number | null }
        | undefined;
      return (row?.maxSortOrder ?? -1) + 1;
    })();

    const now = new Date().toISOString();
    const item: TodoItem = {
      id: this.generateItemId(),
      listId,
      text: input.text,
      completed: false,
      completedAt: null,
      sortOrder: nextSortOrder,
      createdAt: now,
      updatedAt: now,
    };

    this.db.prepare(
      `INSERT INTO todo_items
         (id, listId, text, completed, completedAt, sortOrder, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(item.id, item.listId, item.text, 0, null, item.sortOrder, item.createdAt, item.updatedAt);

    this.db.bumpLastModified();
    this.emit("item:created", item);
    return item;
  }

  getItem(id: string): TodoItem | undefined {
    const row = this.db.prepare("SELECT * FROM todo_items WHERE id = ?").get(id) as TodoItemRow | undefined;
    return row ? this.rowToTodoItem(row) : undefined;
  }

  listItems(listId: string): TodoItem[] {
    const rows = this.db.prepare(
      "SELECT * FROM todo_items WHERE listId = ? ORDER BY sortOrder ASC, createdAt ASC, id ASC"
    ).all(listId) as unknown as TodoItemRow[];
    return rows.map((row) => this.rowToTodoItem(row));
  }

  updateItem(id: string, input: TodoItemUpdateInput): TodoItem | undefined {
    const existing = this.getItem(id);
    if (!existing) return undefined;

    const now = new Date().toISOString();
    const sets: string[] = ["updatedAt = ?"];
    const params: Array<string | number | null> = [now];

    if (input.text !== undefined) {
      sets.push("text = ?");
      params.push(input.text);
    }

    if (input.sortOrder !== undefined) {
      sets.push("sortOrder = ?");
      params.push(input.sortOrder);
    }

    if (input.completed !== undefined) {
      sets.push("completed = ?");
      params.push(input.completed ? 1 : 0);
      sets.push("completedAt = ?");
      params.push(input.completed ? now : null);
    }

    params.push(id);
    this.db.prepare(`UPDATE todo_items SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    this.db.bumpLastModified();

    const updated = this.getItem(id)!;
    this.emit("item:updated", updated);
    return updated;
  }

  deleteItem(id: string): boolean {
    const result = this.db.prepare("DELETE FROM todo_items WHERE id = ?").run(id) as { changes?: number };
    if ((result.changes ?? 0) < 1) return false;

    this.db.bumpLastModified();
    this.emit("item:deleted", id);
    return true;
  }

  toggleItem(id: string): TodoItem | undefined {
    const existing = this.getItem(id);
    if (!existing) return undefined;
    return this.updateItem(id, { completed: !existing.completed });
  }

  reorderItems(listId: string, itemIds: string[]): TodoItem[] {
    const items = this.listItems(listId);
    const existingIds = items.map((item) => item.id);

    if (new Set(itemIds).size !== itemIds.length) {
      throw new Error("Cannot reorder items: duplicate item IDs provided");
    }

    if (existingIds.length !== itemIds.length) {
      throw new Error("Cannot reorder items: provided IDs must include all items in the list");
    }

    const existingIdSet = new Set(existingIds);
    for (const itemId of itemIds) {
      if (!existingIdSet.has(itemId)) {
        throw new Error(`Cannot reorder items: item ${itemId} does not belong to list ${listId}`);
      }
    }

    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (let index = 0; index < itemIds.length; index++) {
        this.db
          .prepare("UPDATE todo_items SET sortOrder = ?, updatedAt = ? WHERE id = ? AND listId = ?")
          .run(index, now, itemIds[index], listId);
      }
    });

    this.db.bumpLastModified();
    const reordered = this.listItems(listId);
    this.emit("items:reordered", { listId, items: reordered });
    return reordered;
  }

  getListsWithItems(projectId: string): TodoListWithItems[] {
    const lists = this.listLists(projectId);
    if (lists.length === 0) return [];

    const rows = this.db.prepare(
      `SELECT * FROM todo_items
       WHERE listId IN (SELECT id FROM todo_lists WHERE projectId = ?)
       ORDER BY listId ASC, sortOrder ASC, createdAt ASC, id ASC`
    ).all(projectId) as unknown as TodoItemRow[];

    const itemsByListId = new Map<string, TodoItem[]>();
    for (const row of rows) {
      const item = this.rowToTodoItem(row);
      const listItems = itemsByListId.get(item.listId) ?? [];
      listItems.push(item);
      itemsByListId.set(item.listId, listItems);
    }

    return lists.map((list) => ({
      ...list,
      items: itemsByListId.get(list.id) ?? [],
    }));
  }
}
