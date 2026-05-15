import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useChatUnread } from "../useChatUnread";

describe("useChatUnread", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("treats unknown conversation as unread when activity exists", () => {
    const { result } = renderHook(() => useChatUnread("p1"));

    expect(result.current.isUnread("direct", "s1", "2026-05-15T00:00:00.000Z")).toBe(true);
  });

  it("markRead clears unread when activity is not newer", () => {
    const { result } = renderHook(() => useChatUnread("p1"));

    act(() => {
      result.current.markRead("direct", "s1", "2026-05-15T00:00:00.000Z");
    });

    expect(result.current.isUnread("direct", "s1", "2026-05-15T00:00:00.000Z")).toBe(false);
    expect(result.current.isUnread("direct", "s1", "2026-05-14T23:59:00.000Z")).toBe(false);
  });

  it("returns false for missing or invalid activity timestamps", () => {
    const { result } = renderHook(() => useChatUnread("p1"));

    expect(result.current.isUnread("direct", "s1", undefined)).toBe(false);
    expect(result.current.isUnread("room", "r1", "invalid-date")).toBe(false);
  });

  it("persists and reloads from project-scoped storage", () => {
    const { result, unmount } = renderHook(() => useChatUnread("p1"));

    act(() => {
      result.current.markRead("room", "r1", "2026-05-15T01:00:00.000Z");
    });

    unmount();

    const { result: reloaded } = renderHook(() => useChatUnread("p1"));
    expect(reloaded.current.isUnread("room", "r1", "2026-05-15T00:59:00.000Z")).toBe(false);
    expect(reloaded.current.isUnread("room", "r1", "2026-05-15T01:01:00.000Z")).toBe(true);
  });

  it("isolates unread maps by project scope", () => {
    const { result, rerender } = renderHook(({ projectId }: { projectId: string }) => useChatUnread(projectId), {
      initialProps: { projectId: "p1" },
    });

    act(() => {
      result.current.markRead("direct", "s1", "2026-05-15T02:00:00.000Z");
    });

    rerender({ projectId: "p2" });
    expect(result.current.isUnread("direct", "s1", "2026-05-15T02:00:00.000Z")).toBe(true);

    rerender({ projectId: "p1" });
    expect(result.current.isUnread("direct", "s1", "2026-05-15T02:00:00.000Z")).toBe(false);
  });

  it("evicts oldest entries when map exceeds cap", () => {
    const { result } = renderHook(() => useChatUnread("p1"));

    act(() => {
      const base = new Date("2026-05-15T00:00:00.000Z").getTime();
      for (let index = 0; index < 205; index += 1) {
        result.current.markRead("direct", `s-${index}`, new Date(base + index * 60_000).toISOString());
      }
    });

    const storedRaw = localStorage.getItem("kb:p1:fusion:chat-unread:direct");
    expect(storedRaw).toBeTruthy();
    const stored = JSON.parse(storedRaw ?? "{}");
    expect(Object.keys(stored)).toHaveLength(200);
    expect(stored["s-204"]).toBeDefined();
    expect(stored["s-0"]).toBeUndefined();
  });
});
