import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { TodoItem, TodoList, TodoListWithItems } from "@fusion/core";
import { useTodoLists } from "../useTodoLists";

vi.mock("../../api", () => ({
  fetchTodoLists: vi.fn(),
  createTodoList: vi.fn(),
  updateTodoList: vi.fn(),
  deleteTodoList: vi.fn(),
  createTodoItem: vi.fn(),
  updateTodoItem: vi.fn(),
  deleteTodoItem: vi.fn(),
  reorderTodoItems: vi.fn(),
}));

import {
  fetchTodoLists,
  createTodoList,
  updateTodoList,
  deleteTodoList,
  createTodoItem,
  updateTodoItem,
  deleteTodoItem,
  reorderTodoItems,
} from "../../api";

const mockFetchTodoLists = vi.mocked(fetchTodoLists);
const mockCreateTodoList = vi.mocked(createTodoList);
const mockUpdateTodoList = vi.mocked(updateTodoList);
const mockDeleteTodoList = vi.mocked(deleteTodoList);
const mockCreateTodoItem = vi.mocked(createTodoItem);
const mockUpdateTodoItem = vi.mocked(updateTodoItem);
const mockDeleteTodoItem = vi.mocked(deleteTodoItem);
const mockReorderTodoItems = vi.mocked(reorderTodoItems);

function makeList(id: string, title: string, items: TodoItem[] = []): TodoListWithItems {
  return {
    id,
    projectId: "project-1",
    title,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    items,
  };
}

function makeItem(id: string, listId: string, text: string, completed = false, sortOrder = 0): TodoItem {
  return {
    id,
    listId,
    text,
    completed,
    completedAt: completed ? "2026-01-01T00:00:00.000Z" : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sortOrder,
  };
}

describe("useTodoLists", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateTodoList.mockResolvedValue({} as TodoList);
    mockDeleteTodoItem.mockResolvedValue();
  });

  it("initial fetch populates lists", async () => {
    mockFetchTodoLists.mockResolvedValue([makeList("list-1", "Inbox")]);

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.lists).toHaveLength(1);
    expect(result.current.lists[0].title).toBe("Inbox");
    expect(result.current.selectedListId).toBe("list-1");
  });

  it("selectedListId filters items", async () => {
    const listOneItems = [makeItem("item-1", "list-1", "One")];
    const listTwoItems = [makeItem("item-2", "list-2", "Two")];
    mockFetchTodoLists.mockResolvedValue([
      makeList("list-1", "Inbox", listOneItems),
      makeList("list-2", "Work", listTwoItems),
    ]);

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.items.map((item) => item.id)).toEqual(["item-1"]);

    act(() => {
      result.current.setSelectedListId("list-2");
    });

    await waitFor(() => {
      expect(result.current.items.map((item) => item.id)).toEqual(["item-2"]);
    });
  });

  it("createList optimistically adds and rolls back on error", async () => {
    const addToast = vi.fn();
    mockFetchTodoLists.mockResolvedValue([makeList("list-1", "Inbox")]);

    let rejectCreate: ((reason?: unknown) => void) | undefined;
    mockCreateTodoList.mockReturnValue(
      new Promise((_, reject) => {
        rejectCreate = reject;
      }),
    );

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1", addToast }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createPromise: Promise<void> | undefined;
    act(() => {
      createPromise = result.current.createList("Urgent");
    });

    expect(result.current.lists.some((list) => list.title === "Urgent")).toBe(true);

    rejectCreate?.(new Error("create failed"));
    await act(async () => {
      await createPromise;
    });

    expect(result.current.lists.map((list) => list.title)).toEqual(["Inbox"]);
    expect(addToast).toHaveBeenCalledWith("Failed to create todo list", "error");
  });

  it("deleteList optimistically removes and rolls back on error", async () => {
    const addToast = vi.fn();
    mockFetchTodoLists.mockResolvedValue([
      makeList("list-1", "Inbox"),
      makeList("list-2", "Work"),
    ]);

    let rejectDelete: ((reason?: unknown) => void) | undefined;
    mockDeleteTodoList.mockReturnValue(
      new Promise((_, reject) => {
        rejectDelete = reject;
      }),
    );

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1", addToast }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deletePromise: Promise<void> | undefined;
    act(() => {
      deletePromise = result.current.deleteList("list-1");
    });

    expect(result.current.lists.map((list) => list.id)).toEqual(["list-2"]);

    rejectDelete?.(new Error("delete failed"));
    await act(async () => {
      await deletePromise;
    });

    expect(result.current.lists.map((list) => list.id)).toEqual(["list-1", "list-2"]);
    expect(addToast).toHaveBeenCalledWith("Failed to delete todo list", "error");
  });

  it("createItem optimistically adds to selected list items", async () => {
    const initialItems = [makeItem("item-1", "list-1", "Existing")];
    mockFetchTodoLists.mockResolvedValue([makeList("list-1", "Inbox", initialItems)]);

    let resolveCreate: ((value: TodoItem) => void) | undefined;
    mockCreateTodoItem.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let createPromise: Promise<void> | undefined;
    act(() => {
      createPromise = result.current.createItem("New item");
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[1].text).toBe("New item");

    resolveCreate?.(makeItem("item-2", "list-1", "New item", false, 1));
    await act(async () => {
      await createPromise;
    });

    expect(result.current.items.map((item) => item.id)).toEqual(["item-1", "item-2"]);
  });

  it("toggleItem flips completed and rolls back on error", async () => {
    const addToast = vi.fn();
    const item = makeItem("item-1", "list-1", "Toggle me", false, 0);
    mockFetchTodoLists.mockResolvedValue([makeList("list-1", "Inbox", [item])]);

    let rejectUpdate: ((reason?: unknown) => void) | undefined;
    mockUpdateTodoItem.mockReturnValue(
      new Promise((_, reject) => {
        rejectUpdate = reject;
      }),
    );

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1", addToast }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let togglePromise: Promise<void> | undefined;
    act(() => {
      togglePromise = result.current.toggleItem("item-1");
    });

    expect(result.current.items[0].completed).toBe(true);

    rejectUpdate?.(new Error("toggle failed"));
    await act(async () => {
      await togglePromise;
    });

    expect(result.current.items[0].completed).toBe(false);
    expect(addToast).toHaveBeenCalledWith("Failed to update todo item", "error");
  });

  it("reorderItems optimistically reorders", async () => {
    const itemOne = makeItem("item-1", "list-1", "One", false, 0);
    const itemTwo = makeItem("item-2", "list-1", "Two", false, 1);
    mockFetchTodoLists.mockResolvedValue([makeList("list-1", "Inbox", [itemOne, itemTwo])]);

    let resolveReorder: (() => void) | undefined;
    mockReorderTodoItems.mockReturnValue(
      new Promise((resolve) => {
        resolveReorder = resolve;
      }),
    );

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let reorderPromise: Promise<void> | undefined;
    act(() => {
      reorderPromise = result.current.reorderItems(["item-2", "item-1"]);
    });

    expect(result.current.items.map((item) => item.id)).toEqual(["item-2", "item-1"]);

    resolveReorder?.();
    await act(async () => {
      await reorderPromise;
    });

    expect(mockReorderTodoItems).toHaveBeenCalledWith("list-1", ["item-2", "item-1"], "project-1");
  });

  it("sets error state on fetch failure", async () => {
    mockFetchTodoLists.mockRejectedValue(new Error("fetch failed"));

    const { result } = renderHook(() => useTodoLists({ projectId: "project-1" }));

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("fetch failed");
    expect(result.current.lists).toEqual([]);
    expect(result.current.items).toEqual([]);
  });
});
