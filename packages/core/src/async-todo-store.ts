/**
 * Async Drizzle TodoStore helpers (U6 satellite-db-injected-stores).
 *
 * FNXC:TodoStore 2026-06-24-06:00:
 * Async equivalents of the sync SQLite TodoStore call sites in todo-store.ts.
 * These helpers target the PostgreSQL `project.todo_lists` and
 * `project.todo_items` tables via Drizzle and preserve the list/item CRUD
 * round-trip, ordering, and toggle semantics.
 *
 * SQLite → PostgreSQL notes (VAL-SCHEMA-004):
 *   The boolean `completed` column is kept as integer (0/1) in PostgreSQL
 *   (per _shared.ts: "kept as integer to preserve exact behavior"), so
 *   `row.completed === 1` checks still work. There are no JSON columns on
 *   these tables.
 *
 * Transition context (see library/satellite-store-migration-pattern.md):
 *   `getDatabase()` still returns the sync `Database` until the coordinated
 *   `getDatabase()` flip. The sync TodoStore keeps its sync path (the gate
 *   depends on it). These helpers are the async target the PostgreSQL
 *   integration tests consume. They program against the stable
 *   `AsyncDataLayer` interface (U4), not the underlying driver.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "./postgres/schema/index.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import type {
  TodoList,
  TodoItem,
  TodoListUpdateInput,
  TodoItemUpdateInput,
  TodoListWithItems,
} from "./types.js";

/** A query-capable handle: either the top-level db or a transaction handle. */
type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

/** Row shape for todo_lists (camelCase column aliases via Drizzle). */
interface TodoListRow {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Row shape for todo_items. */
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

function rowToTodoList(row: TodoListRow): TodoList {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToTodoItem(row: TodoItemRow): TodoItem {
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

const todoListColumns = {
  id: schema.project.todoLists.id,
  projectId: schema.project.todoLists.projectId,
  title: schema.project.todoLists.title,
  createdAt: schema.project.todoLists.createdAt,
  updatedAt: schema.project.todoLists.updatedAt,
};

const todoItemColumns = {
  id: schema.project.todoItems.id,
  listId: schema.project.todoItems.listId,
  text: schema.project.todoItems.text,
  completed: schema.project.todoItems.completed,
  completedAt: schema.project.todoItems.completedAt,
  sortOrder: schema.project.todoItems.sortOrder,
  createdAt: schema.project.todoItems.createdAt,
  updatedAt: schema.project.todoItems.updatedAt,
};

/**
 * FNXC:TodoStore 2026-06-24-06:05:
 * Create a todo list (non-destructive INSERT, VAL-DATA-009).
 */
export async function createTodoList(
  handle: QueryHandle,
  list: { id: string; projectId: string; title: string; createdAt: string; updatedAt: string },
): Promise<TodoList> {
  await handle.insert(schema.project.todoLists).values({
    id: list.id,
    projectId: list.projectId,
    title: list.title,
    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  });
  return rowToTodoList(list as TodoListRow);
}

/**
 * Get a single todo list by id.
 */
export async function getTodoList(handle: QueryHandle, id: string): Promise<TodoList | undefined> {
  const rows = await handle
    .select(todoListColumns)
    .from(schema.project.todoLists)
    .where(eq(schema.project.todoLists.id, id));
  return rows[0] ? rowToTodoList(rows[0] as TodoListRow) : undefined;
}

/**
 * List todo lists for a project, ordered by createdAt ASC then id ASC.
 */
export async function listTodoLists(handle: QueryHandle, projectId: string): Promise<TodoList[]> {
  const rows = await handle
    .select(todoListColumns)
    .from(schema.project.todoLists)
    .where(eq(schema.project.todoLists.projectId, projectId))
    .orderBy(asc(schema.project.todoLists.createdAt), asc(schema.project.todoLists.id));
  return rows.map((row) => rowToTodoList(row as TodoListRow));
}

/**
 * FNXC:TodoStore 2026-06-24-06:10:
 * Update a todo list's title. Returns undefined if the list does not exist.
 */
export async function updateTodoList(
  handle: QueryHandle,
  id: string,
  input: TodoListUpdateInput,
): Promise<TodoList | undefined> {
  const existing = await getTodoList(handle, id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const title = input.title ?? existing.title;
  await handle
    .update(schema.project.todoLists)
    .set({ title, updatedAt: now })
    .where(eq(schema.project.todoLists.id, id));
  return (await getTodoList(handle, id))!;
}

/**
 * Delete a todo list by id. Returns true if a row was deleted.
 */
export async function deleteTodoList(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.todoLists)
    .where(eq(schema.project.todoLists.id, id))
    .returning({ id: schema.project.todoLists.id });
  return result.length > 0;
}

/**
 * FNXC:TodoStore 2026-06-24-06:15:
 * Create a todo item. Computes the next sortOrder when not provided.
 */
export async function createTodoItem(
  handle: QueryHandle,
  item: { id: string; listId: string; text: string; completed: boolean; completedAt: string | null; sortOrder: number | undefined; createdAt: string; updatedAt: string },
): Promise<TodoItem> {
  let sortOrder = item.sortOrder;
  if (sortOrder === undefined) {
    const maxRows = await handle
      .select({ maxSortOrder: sql<number | null>`max(${schema.project.todoItems.sortOrder})` })
      .from(schema.project.todoItems)
      .where(eq(schema.project.todoItems.listId, item.listId));
    sortOrder = (maxRows[0]?.maxSortOrder ?? -1) + 1;
  }
  await handle.insert(schema.project.todoItems).values({
    id: item.id,
    listId: item.listId,
    text: item.text,
    completed: 0,
    completedAt: null,
    sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
  return {
    id: item.id,
    listId: item.listId,
    text: item.text,
    completed: false,
    completedAt: null,
    sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Get a single todo item by id.
 */
export async function getTodoItem(handle: QueryHandle, id: string): Promise<TodoItem | undefined> {
  const rows = await handle
    .select(todoItemColumns)
    .from(schema.project.todoItems)
    .where(eq(schema.project.todoItems.id, id));
  return rows[0] ? rowToTodoItem(rows[0] as TodoItemRow) : undefined;
}

/**
 * List todo items for a list, ordered by sortOrder ASC then createdAt ASC then id ASC.
 */
export async function listTodoItems(handle: QueryHandle, listId: string): Promise<TodoItem[]> {
  const rows = await handle
    .select(todoItemColumns)
    .from(schema.project.todoItems)
    .where(eq(schema.project.todoItems.listId, listId))
    .orderBy(
      asc(schema.project.todoItems.sortOrder),
      asc(schema.project.todoItems.createdAt),
      asc(schema.project.todoItems.id),
    );
  return rows.map((row) => rowToTodoItem(row as TodoItemRow));
}

/**
 * FNXC:TodoStore 2026-06-24-06:20:
 * Update a todo item (text, sortOrder, completed). Returns undefined if not found.
 */
export async function updateTodoItem(
  handle: QueryHandle,
  id: string,
  input: TodoItemUpdateInput,
): Promise<TodoItem | undefined> {
  const existing = await getTodoItem(handle, id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  const sets: Record<string, unknown> = { updatedAt: now };
  if (input.text !== undefined) sets.text = input.text;
  if (input.sortOrder !== undefined) sets.sortOrder = input.sortOrder;
  if (input.completed !== undefined) {
    sets.completed = input.completed ? 1 : 0;
    sets.completedAt = input.completed ? now : null;
  }
  await handle
    .update(schema.project.todoItems)
    .set(sets as never)
    .where(eq(schema.project.todoItems.id, id));
  return (await getTodoItem(handle, id))!;
}

/**
 * Delete a todo item by id. Returns true if a row was deleted.
 */
export async function deleteTodoItem(handle: QueryHandle, id: string): Promise<boolean> {
  const result = await handle
    .delete(schema.project.todoItems)
    .where(eq(schema.project.todoItems.id, id))
    .returning({ id: schema.project.todoItems.id });
  return result.length > 0;
}

/**
 * FNXC:TodoStore 2026-06-24-06:25:
 * Reorder items within a list transactionally. Each item's sortOrder is set
 * to its index in the itemIds array. The entire reorder runs in one
 * transaction so partial reorders never persist.
 */
export async function reorderTodoItems(
  layer: AsyncDataLayer,
  listId: string,
  itemIds: string[],
): Promise<TodoItem[]> {
  const now = new Date().toISOString();
  await layer.transactionImmediate(async (tx) => {
    for (let index = 0; index < itemIds.length; index++) {
      await tx
        .update(schema.project.todoItems)
        .set({ sortOrder: index, updatedAt: now })
        .where(
          and(
            eq(schema.project.todoItems.id, itemIds[index]!),
            eq(schema.project.todoItems.listId, listId),
          ),
        );
    }
  });
  return listTodoItems(layer.db, listId);
}

/**
 * FNXC:TodoStore 2026-06-24-06:30:
 * Get all lists with their items for a project in two queries (lists + items)
 * then group items by listId in memory.
 */
export async function getTodoListsWithItems(
  handle: QueryHandle,
  projectId: string,
): Promise<TodoListWithItems[]> {
  const lists = await listTodoLists(handle, projectId);
  if (lists.length === 0) return [];
  const rows = await handle
    .select(todoItemColumns)
    .from(schema.project.todoItems)
    .where(
      inArray(
        schema.project.todoItems.listId,
        lists.map((l) => l.id),
      ),
    )
    .orderBy(
      asc(schema.project.todoItems.listId),
      asc(schema.project.todoItems.sortOrder),
      asc(schema.project.todoItems.createdAt),
      asc(schema.project.todoItems.id),
    );
  const itemsByListId = new Map<string, TodoItem[]>();
  for (const row of rows) {
    const item = rowToTodoItem(row as TodoItemRow);
    const listItems = itemsByListId.get(item.listId) ?? [];
    listItems.push(item);
    itemsByListId.set(item.listId, listItems);
  }
  return lists.map((list) => ({
    ...list,
    items: itemsByListId.get(list.id) ?? [],
  }));
}
