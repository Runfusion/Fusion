import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TodoItem, TodoList, TodoListWithItems } from "@fusion/core";
import {
  fetchTodoLists,
  createTodoList,
  updateTodoList,
  deleteTodoList,
  createTodoItem,
  updateTodoItem,
  deleteTodoItem,
  reorderTodoItems,
} from "./api.js";
import { readCache, SWR_CACHE_KEYS, SWR_DEFAULT_MAX_AGE_MS, writeCache } from "./swrCache.js";

type ToastType = "info" | "success" | "error" | "warning";

export interface UseTodoListsOptions {
  projectId?: string;
  addToast?: (message: string, type?: ToastType | string) => void;
}

export interface UseTodoListsResult {
  lists: TodoList[];
  items: TodoItem[];
  loading: boolean;
  error: string | null;
  selectedListId: string | null;
  setSelectedListId: (id: string | null) => void;
  createList: (title: string) => Promise<void>;
  renameList: (id: string, title: string) => Promise<void>;
  deleteList: (id: string) => Promise<void>;
  createItem: (text: string) => Promise<void>;
  updateItem: (id: string, patch: { text?: string; completed?: boolean }) => Promise<void>;
  toggleItem: (id: string) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;
  reorderItems: (itemIds: string[]) => Promise<void>;
}

function toList(listWithItems: TodoListWithItems): TodoList {
  const { items: _items, ...list } = listWithItems;
  return list;
}

function buildTempId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useTodoLists(options: UseTodoListsOptions = {}): UseTodoListsResult {
  const { t } = useTranslation("app");
  const { projectId, addToast } = options;

  const cacheKey = `${SWR_CACHE_KEYS.TODO_LISTS_PREFIX}${projectId ?? "global"}`;
  const [lists, setLists] = useState<TodoList[]>(() => {
    const cached = readCache<TodoList[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    return Array.isArray(cached) ? cached : [];
  });
  const [items, setItems] = useState<TodoItem[]>([]);
  const [loading, setLoading] = useState(() => lists.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [listData, setListData] = useState<TodoListWithItems[]>([]);

  const selectedListIdRef = useRef<string | null>(selectedListId);
  selectedListIdRef.current = selectedListId;

  useEffect(() => {
    let cancelled = false;

    const cachedLists = readCache<TodoList[]>(cacheKey, { maxAgeMs: SWR_DEFAULT_MAX_AGE_MS });
    const hasCachedLists = Array.isArray(cachedLists) && cachedLists.length > 0;

    if (hasCachedLists) {
      setLists(cachedLists);
      setLoading(false);
    } else {
      setLists([]);
      setLoading(true);
    }

    async function loadLists() {
      if (!hasCachedLists) {
        setLoading(true);
      }
      setError(null);

      try {
        const data = await fetchTodoLists(projectId);
        if (cancelled) {
          return;
        }

        setListData(data);
        const fetchedLists = data.map(toList);
        setLists(fetchedLists);
        writeCache(cacheKey, fetchedLists, { maxBytes: 500_000 });

        const activeListId =
          selectedListIdRef.current && data.some((list) => list.id === selectedListIdRef.current)
            ? selectedListIdRef.current
            : (data[0]?.id ?? null);

        setSelectedListId(activeListId);
        setItems(activeListId ? (data.find((list) => list.id === activeListId)?.items ?? []) : []);
      } catch (err) {
        if (cancelled) {
          return;
        }
        setListData([]);
        setLists([]);
        setItems([]);
        setSelectedListId(null);
        setError(err instanceof Error ? err.message : t("todo.failedLoadLists", "Failed to load todo lists"));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadLists();

    return () => {
      cancelled = true;
    };
  }, [cacheKey, projectId]);

  useEffect(() => {
    if (!selectedListId) {
      setItems([]);
      return;
    }

    const selected = listData.find((list) => list.id === selectedListId);
    setItems(selected?.items ?? []);
  }, [listData, selectedListId]);

  const createListAction = useCallback(async (title: string) => {
    const previousLists = lists;
    const previousListData = listData;

    const now = new Date().toISOString();
    const tempList: TodoList = {
      id: buildTempId("temp-list"),
      projectId: projectId ?? "",
      title,
      createdAt: now,
      updatedAt: now,
    };

    setError(null);
    setLists((prev) => [...prev, tempList]);
    setListData((prev) => [...prev, { ...tempList, items: [] }]);

    try {
      const created = await createTodoList(title, projectId);
      setLists((prev) => prev.map((list) => (list.id === tempList.id ? created : list)));
      setListData((prev) => prev.map((list) => (list.id === tempList.id ? { ...created, items: [] } : list)));
      if (!selectedListIdRef.current) {
        setSelectedListId(created.id);
      }
    } catch (err) {
      setLists(previousLists);
      setListData(previousListData);
      setError(err instanceof Error ? err.message : t("todo.failedCreateList", "Failed to create list"));
      addToast?.(t("todo.failedCreateListToast", "Failed to create todo list"), "error");
    }
  }, [addToast, listData, lists, projectId, t]);

  const renameListAction = useCallback(async (id: string, title: string) => {
    const previousLists = lists;
    const previousListData = listData;

    setError(null);
    setLists((prev) => prev.map((list) => (list.id === id ? { ...list, title } : list)));
    setListData((prev) => prev.map((list) => (list.id === id ? { ...list, title } : list)));

    try {
      const updated = await updateTodoList(id, title, projectId);
      setLists((prev) => prev.map((list) => (list.id === id ? updated : list)));
      setListData((prev) => prev.map((list) => (list.id === id ? { ...updated, items: list.items } : list)));
    } catch (err) {
      setLists(previousLists);
      setListData(previousListData);
      setError(err instanceof Error ? err.message : t("todo.failedRenameList", "Failed to rename list"));
      addToast?.(t("todo.failedRenameListToast", "Failed to rename todo list"), "error");
    }
  }, [addToast, listData, lists, projectId, t]);

  const deleteListAction = useCallback(async (id: string) => {
    const previousLists = lists;
    const previousListData = listData;
    const previousSelectedListId = selectedListIdRef.current;
    const nextSelectedListId =
      previousSelectedListId === id ? (lists.find((list) => list.id !== id)?.id ?? null) : previousSelectedListId;

    setError(null);
    setLists((prev) => prev.filter((list) => list.id !== id));
    setListData((prev) => prev.filter((list) => list.id !== id));
    if (previousSelectedListId === id) {
      setSelectedListId(nextSelectedListId);
    }

    try {
      await deleteTodoList(id, projectId);
    } catch (err) {
      setLists(previousLists);
      setListData(previousListData);
      setSelectedListId(previousSelectedListId);
      setError(err instanceof Error ? err.message : t("todo.failedDeleteList", "Failed to delete list"));
      addToast?.(t("todo.failedDeleteListToast", "Failed to delete todo list"), "error");
    }
  }, [addToast, listData, lists, projectId, t]);

  const createItemAction = useCallback(async (text: string) => {
    const listId = selectedListIdRef.current;
    if (!listId) {
      return;
    }

    const previousItems = items;
    const previousListData = listData;
    const now = new Date().toISOString();
    const maxSortOrder = items.reduce((max, item) => Math.max(max, item.sortOrder), -1);

    const tempItem: TodoItem = {
      id: buildTempId("temp-item"),
      listId,
      text,
      completed: false,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      sortOrder: maxSortOrder + 1,
    };

    setError(null);
    setItems((prev) => [...prev, tempItem]);
    setListData((prev) =>
      prev.map((list) =>
        list.id === listId
          ? { ...list, items: [...list.items, tempItem] }
          : list,
      ),
    );

    try {
      const created = await createTodoItem(listId, text, projectId);
      setItems((prev) => prev.map((item) => (item.id === tempItem.id ? created : item)));
      setListData((prev) =>
        prev.map((list) =>
          list.id === listId
            ? { ...list, items: list.items.map((item) => (item.id === tempItem.id ? created : item)) }
            : list,
        ),
      );
    } catch (err) {
      setItems(previousItems);
      setListData(previousListData);
      setError(err instanceof Error ? err.message : t("todo.failedCreateItem", "Failed to create item"));
      addToast?.(t("todo.failedCreateItemToast", "Failed to create todo item"), "error");
    }
  }, [addToast, items, listData, projectId, t]);

  const updateItemAction = useCallback(async (id: string, patch: { text?: string; completed?: boolean }) => {
    const target = items.find((item) => item.id === id);
    if (!target) {
      return;
    }

    const previousItems = items;
    const previousListData = listData;
    const nextCompleted = patch.completed ?? target.completed;
    const optimisticItem: TodoItem = {
      ...target,
      ...patch,
      completed: nextCompleted,
      completedAt: nextCompleted ? (target.completedAt ?? new Date().toISOString()) : null,
      updatedAt: new Date().toISOString(),
    };

    setError(null);
    setItems((prev) => prev.map((item) => (item.id === id ? optimisticItem : item)));
    setListData((prev) =>
      prev.map((list) =>
        list.id === optimisticItem.listId
          ? { ...list, items: list.items.map((item) => (item.id === id ? optimisticItem : item)) }
          : list,
      ),
    );

    try {
      const updated = await updateTodoItem(id, patch, projectId);
      setItems((prev) => prev.map((item) => (item.id === id ? updated : item)));
      setListData((prev) =>
        prev.map((list) =>
          list.id === updated.listId
            ? { ...list, items: list.items.map((item) => (item.id === id ? updated : item)) }
            : list,
        ),
      );
    } catch (err) {
      setItems(previousItems);
      setListData(previousListData);
      setError(err instanceof Error ? err.message : t("todo.failedUpdateItem", "Failed to update item"));
      addToast?.(t("todo.failedUpdateItemToast", "Failed to update todo item"), "error");
    }
  }, [addToast, items, listData, projectId, t]);

  const toggleItemAction = useCallback(async (id: string) => {
    const target = items.find((item) => item.id === id);
    if (!target) {
      return;
    }

    await updateItemAction(id, { completed: !target.completed });
  }, [items, updateItemAction]);

  const deleteItemAction = useCallback(async (id: string) => {
    const previousItems = items;
    const previousListData = listData;

    setError(null);
    setItems((prev) => prev.filter((item) => item.id !== id));
    setListData((prev) =>
      prev.map((list) => ({
        ...list,
        items: list.items.filter((item) => item.id !== id),
      })),
    );

    try {
      await deleteTodoItem(id, projectId);
    } catch (err) {
      setItems(previousItems);
      setListData(previousListData);
      setError(err instanceof Error ? err.message : t("todo.failedDeleteItem", "Failed to delete item"));
      addToast?.(t("todo.failedDeleteItemToast", "Failed to delete todo item"), "error");
    }
  }, [addToast, items, listData, projectId, t]);

  const reorderItemsAction = useCallback(async (itemIds: string[]) => {
    const listId = selectedListIdRef.current;
    if (!listId) {
      return;
    }

    const previousItems = items;
    const previousListData = listData;

    const byId = new Map(items.map((item) => [item.id, item]));
    const reorderedItems = itemIds
      .map((itemId, index) => {
        const existing = byId.get(itemId);
        if (!existing) {
          return null;
        }
        return {
          ...existing,
          sortOrder: index,
        };
      })
      .filter((item): item is TodoItem => item !== null);

    setError(null);
    setItems(reorderedItems);
    setListData((prev) =>
      prev.map((list) =>
        list.id === listId
          ? { ...list, items: reorderedItems }
          : list,
      ),
    );

    try {
      await reorderTodoItems(listId, itemIds, projectId);
    } catch (err) {
      setItems(previousItems);
      setListData(previousListData);
      setError(err instanceof Error ? err.message : t("todo.failedReorderItems", "Failed to reorder items"));
      addToast?.(t("todo.failedReorderItemsToast", "Failed to reorder todo items"), "error");
    }
  }, [addToast, items, listData, projectId, t]);

  return {
    lists,
    items,
    loading,
    error,
    selectedListId,
    setSelectedListId,
    createList: createListAction,
    renameList: renameListAction,
    deleteList: deleteListAction,
    createItem: createItemAction,
    updateItem: updateItemAction,
    toggleItem: toggleItemAction,
    deleteItem: deleteItemAction,
    reorderItems: reorderItemsAction,
  };
}
