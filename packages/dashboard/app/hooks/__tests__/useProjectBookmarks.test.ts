import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useProjectBookmarks } from "../useProjectBookmarks";

describe("useProjectBookmarks", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts with empty bookmarks when localStorage is empty", () => {
    const { result } = renderHook(() => useProjectBookmarks());
    expect(result.current.bookmarkedIds.size).toBe(0);
    expect(result.current.isBookmarked("any-id")).toBe(false);
  });

  it("loads bookmarks from localStorage", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify(["proj_1", "proj_2"]));

    const { result } = renderHook(() => useProjectBookmarks());
    expect(result.current.bookmarkedIds.size).toBe(2);
    expect(result.current.isBookmarked("proj_1")).toBe(true);
    expect(result.current.isBookmarked("proj_2")).toBe(true);
    expect(result.current.isBookmarked("proj_3")).toBe(false);
  });

  it("adds a bookmark", () => {
    const { result } = renderHook(() => useProjectBookmarks());

    act(() => {
      result.current.toggleBookmark("proj_1");
    });

    expect(result.current.isBookmarked("proj_1")).toBe(true);
    expect(result.current.bookmarkedIds.has("proj_1")).toBe(true);
  });

  it("removes a bookmark", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify(["proj_1"]));

    const { result } = renderHook(() => useProjectBookmarks());

    act(() => {
      result.current.toggleBookmark("proj_1");
    });

    expect(result.current.isBookmarked("proj_1")).toBe(false);
    expect(result.current.bookmarkedIds.size).toBe(0);
  });

  it("persists bookmarks to localStorage", () => {
    const { result } = renderHook(() => useProjectBookmarks());

    act(() => {
      result.current.toggleBookmark("proj_1");
    });

    // Check that localStorage was updated
    const stored = JSON.parse(localStorage.getItem("fusion_project_bookmarks") ?? "[]");
    expect(stored).toContain("proj_1");
  });

  it("persists removal to localStorage", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify(["proj_1", "proj_2"]));

    const { result } = renderHook(() => useProjectBookmarks());

    act(() => {
      result.current.toggleBookmark("proj_1");
    });

    const stored = JSON.parse(localStorage.getItem("fusion_project_bookmarks") ?? "[]");
    expect(stored).toEqual(["proj_2"]);
  });

  it("handles corrupted localStorage gracefully", () => {
    localStorage.setItem("fusion_project_bookmarks", "not-json{{{");

    const { result } = renderHook(() => useProjectBookmarks());
    expect(result.current.bookmarkedIds.size).toBe(0);
  });

  it("handles non-array localStorage value gracefully", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify({ foo: "bar" }));

    const { result } = renderHook(() => useProjectBookmarks());
    expect(result.current.bookmarkedIds.size).toBe(0);
  });

  it("filters non-string items from stored array", () => {
    localStorage.setItem("fusion_project_bookmarks", JSON.stringify(["proj_1", 42, null, "proj_2"]));

    const { result } = renderHook(() => useProjectBookmarks());
    expect(result.current.bookmarkedIds.size).toBe(2);
    expect(result.current.isBookmarked("proj_1")).toBe(true);
    expect(result.current.isBookmarked("proj_2")).toBe(true);
  });

  it("toggles multiple bookmarks independently", () => {
    const { result } = renderHook(() => useProjectBookmarks());

    act(() => {
      result.current.toggleBookmark("proj_1");
    });
    act(() => {
      result.current.toggleBookmark("proj_2");
    });

    expect(result.current.isBookmarked("proj_1")).toBe(true);
    expect(result.current.isBookmarked("proj_2")).toBe(true);
    expect(result.current.bookmarkedIds.size).toBe(2);

    act(() => {
      result.current.toggleBookmark("proj_1");
    });

    expect(result.current.isBookmarked("proj_1")).toBe(false);
    expect(result.current.isBookmarked("proj_2")).toBe(true);
    expect(result.current.bookmarkedIds.size).toBe(1);
  });
});
