import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFileMention } from "../useFileMention";

vi.mock("../../api", () => ({
  fetchTasks: vi.fn(),
  searchFiles: vi.fn(),
}));

import { fetchTasks, searchFiles } from "../../api";

const mockFetchTasks = vi.mocked(fetchTasks);
const mockSearchFiles = vi.mocked(searchFiles);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushSearch() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();
  });
}

describe("useFileMention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetchTasks.mockResolvedValue([]);
    mockSearchFiles.mockResolvedValue({ files: [] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("detectMention", () => {
    it("returns false when cursor is at start with no text", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("", 0);
      });
      expect(result.current.mentionActive).toBe(false);
    });

    it("detects # at start of text", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#", 1);
      });
      expect(result.current.mentionActive).toBe(true);
      expect(result.current.mentionQuery).toBe("");
    });

    it("detects # after whitespace with partial filename", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("Hello #sr", 9);
      });
      expect(result.current.mentionActive).toBe(true);
      expect(result.current.mentionQuery).toBe("sr");
    });

    it("ignores # after non-whitespace", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("foo#bar", 6);
      });
      expect(result.current.mentionActive).toBe(false);
    });

    it("resets selected index when detection changes", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.setSelectedIndex(3);
        result.current.detectMention("#src", 4);
      });
      expect(result.current.selectedIndex).toBe(0);
    });
  });

  describe("selection helpers", () => {
    it("replaces partial mention with full file path", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("Check #src/ind", 14);
      });
      expect(
        result.current.selectFile({ path: "src/index.ts", name: "index.ts" }, "Check #src/ind"),
      ).toBe("Check #src/index.ts");
    });

    it("replaces partial mention with a task id", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("Check #FN-5 now", 11);
      });
      expect(
        result.current.selectTask({ id: "FN-5218", title: "Hash mentions", column: "todo" }, "Check #FN-5 now"),
      ).toBe("Check #FN-5218 now");
    });

    it("does nothing when mention is not active", () => {
      const { result } = renderHook(() => useFileMention());
      expect(result.current.selectFile({ path: "src/index.ts", name: "index.ts" }, "Some text")).toBe("Some text");
    });
  });

  describe("search", () => {
    it("returns task matches for id queries", async () => {
      mockFetchTasks.mockResolvedValue([
        { id: "FN-5218", title: "Hash entries in chat", column: "todo" } as never,
      ]);

      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#FN-", 4);
      });
      await flushSearch();

      expect(result.current.tasks).toEqual([
        { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
      ]);
      expect(result.current.combinedItems[0]).toEqual({
        kind: "task",
        task: { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
      });
    });

    it("returns file matches for substring queries", async () => {
      mockSearchFiles.mockResolvedValue({
        files: [{ path: "src/project.ts", name: "project.ts" }],
      });

      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#proj", 5);
      });
      await flushSearch();

      expect(result.current.files).toEqual([{ path: "src/project.ts", name: "project.ts" }]);
    });

    it("keeps file results when task search rejects", async () => {
      mockFetchTasks.mockRejectedValue(new Error("task search failed"));
      mockSearchFiles.mockResolvedValue({
        files: [{ path: "src/project.ts", name: "project.ts" }],
      });

      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#proj", 5);
      });
      await flushSearch();

      expect(result.current.files).toHaveLength(1);
      expect(result.current.tasks).toEqual([]);
    });

    it("keeps task results when file search rejects", async () => {
      mockFetchTasks.mockResolvedValue([
        { id: "FN-5218", title: "Hash entries in chat", column: "todo" } as never,
      ]);
      mockSearchFiles.mockRejectedValue(new Error("file search failed"));

      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#FN", 3);
      });
      await flushSearch();

      expect(result.current.tasks).toHaveLength(1);
      expect(result.current.files).toEqual([]);
    });

    it("cancels stale rapid-query results", async () => {
      const firstTasks = deferred<Array<{ id: string; title: string; column: string }>>();
      const secondTasks = deferred<Array<{ id: string; title: string; column: string }>>();
      const firstFiles = deferred<{ files: Array<{ path: string; name: string }> }>();
      const secondFiles = deferred<{ files: Array<{ path: string; name: string }> }>();

      mockFetchTasks.mockReturnValueOnce(firstTasks.promise as never).mockReturnValueOnce(secondTasks.promise as never);
      mockSearchFiles.mockReturnValueOnce(firstFiles.promise).mockReturnValueOnce(secondFiles.promise);

      const { result } = renderHook(() => useFileMention());

      act(() => {
        result.current.detectMention("#FN", 3);
      });
      await flushSearch();

      act(() => {
        result.current.detectMention("#FN-5", 5);
      });
      await flushSearch();

      await act(async () => {
        firstTasks.resolve([{ id: "FN-1111", title: "Old", column: "todo" }]);
        firstFiles.resolve({ files: [{ path: "old.ts", name: "old.ts" }] });
        secondTasks.resolve([{ id: "FN-5218", title: "New", column: "done" }]);
        secondFiles.resolve({ files: [{ path: "new.ts", name: "new.ts" }] });
        await Promise.resolve();
      });

      expect(result.current.tasks).toEqual([{ id: "FN-5218", title: "New", column: "done" }]);
      expect(result.current.files).toEqual([{ path: "new.ts", name: "new.ts" }]);
    });
  });

  describe("handleKeyDown", () => {
    it("returns false when mention is not active", () => {
      const { result } = renderHook(() => useFileMention());
      const handled = result.current.handleKeyDown(
        { key: "ArrowDown", preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLElement>,
        "text",
      );
      expect(handled).toBe(false);
    });

    it("walks the combined list with tasks first", async () => {
      mockFetchTasks.mockResolvedValue([
        { id: "FN-5218", title: "Task one", column: "todo" } as never,
        { id: "FN-5219", title: "Task two", column: "in-progress" } as never,
      ]);
      mockSearchFiles.mockResolvedValue({
        files: [{ path: "src/project.ts", name: "project.ts" }],
      });

      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#proj", 5);
      });
      await flushSearch();

      expect(result.current.combinedItems).toHaveLength(3);

      const preventDefault = vi.fn();
      act(() => {
        result.current.handleKeyDown(
          { key: "ArrowDown", preventDefault } as unknown as React.KeyboardEvent<HTMLElement>,
          "#proj",
        );
        result.current.handleKeyDown(
          { key: "ArrowDown", preventDefault } as unknown as React.KeyboardEvent<HTMLElement>,
          "#proj",
        );
      });

      expect(result.current.selectedIndex).toBe(2);
      expect(result.current.combinedItems[2]).toEqual({
        kind: "file",
        file: { path: "src/project.ts", name: "project.ts" },
      });
    });

    it("returns false when no results are loaded", () => {
      const { result } = renderHook(() => useFileMention());
      act(() => {
        result.current.detectMention("#test", 5);
      });
      const handled = result.current.handleKeyDown(
        { key: "Enter", preventDefault: vi.fn() } as unknown as React.KeyboardEvent<HTMLElement>,
        "#test",
      );
      expect(handled).toBe(false);
    });
  });
});
