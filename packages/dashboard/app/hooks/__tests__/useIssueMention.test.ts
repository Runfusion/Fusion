import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useIssueMention } from "../useIssueMention";

vi.mock("../../api", () => ({
  fetchRecentIssues: vi.fn(),
}));

import { fetchRecentIssues } from "../../api";

const mockFetchRecentIssues = fetchRecentIssues as unknown as ReturnType<typeof vi.fn>;

describe("useIssueMention", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockFetchRecentIssues.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("detects trigger at start, after space, and punctuation", () => {
    const { result } = renderHook(() => useIssueMention());

    act(() => result.current.detectMention("#", 1));
    expect(result.current.mentionActive).toBe(true);

    act(() => result.current.detectMention("hey #1", 6));
    expect(result.current.mentionActive).toBe(true);

    act(() => result.current.detectMention("hey, #2", 7));
    expect(result.current.mentionActive).toBe(true);
  });

  it("deactivates on path-like query and stays active on digits", () => {
    const { result } = renderHook(() => useIssueMention());

    act(() => result.current.detectMention("#123", 4));
    expect(result.current.mentionActive).toBe(true);

    act(() => result.current.detectMention("#src/foo.ts", 11));
    expect(result.current.mentionActive).toBe(false);
  });

  it("debounces fetch", async () => {
    const { result } = renderHook(() => useIssueMention({ projectId: "p1" }));

    act(() => {
      result.current.detectMention("#12", 3);
    });

    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(mockFetchRecentIssues).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchRecentIssues).toHaveBeenCalledWith("p1", "12");
  });

  it("selectIssue inserts trailing space and cursor position", () => {
    const { result } = renderHook(() => useIssueMention());

    act(() => result.current.detectMention("Fix #4 now", 6));

    const selection = result.current.selectIssue(
      { number: 42, title: "Bug", state: "open", htmlUrl: "https://x", repository: "o/r" },
      "Fix #4 now",
    );

    expect(selection.text).toBe("Fix #42  now");
    expect(selection.cursorPosition).toBe(8);
  });

  it("handles keyboard navigation and dismiss", async () => {
    mockFetchRecentIssues.mockResolvedValueOnce([
      { number: 1, title: "a", state: "open", htmlUrl: "https://x/1", repository: "o/r" },
      { number: 2, title: "b", state: "open", htmlUrl: "https://x/2", repository: "o/r" },
    ]);

    const { result } = renderHook(() => useIssueMention());

    act(() => {
      result.current.detectMention("#", 1);
    });

    await act(async () => {
      vi.advanceTimersByTime(200);
      await Promise.resolve();
      await Promise.resolve();
    });

    const preventDefault = vi.fn();
    act(() => {
      result.current.handleKeyDown({ key: "ArrowDown", preventDefault } as unknown as React.KeyboardEvent<HTMLElement>);
    });

    expect(result.current.selectedIndex).toBe(1);

    act(() => {
      result.current.handleKeyDown({ key: "Escape", preventDefault } as unknown as React.KeyboardEvent<HTMLElement>);
    });

    expect(result.current.mentionActive).toBe(false);
  });
});
