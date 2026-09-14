import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoppedOutChats } from "../usePoppedOutChats";
import type { ChatSessionInfo } from "../useChat";

const session = (id: string, title = id): ChatSessionInfo => ({
  id, agentId: "agent-1", title, status: "active", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
});

describe("usePoppedOutChats", () => {
  it("refreshes an existing project/session entry in place and raises its focus nonce", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("a")));
    act(() => result.current.popOut("project-a", session("b")));
    const firstNonce = result.current.entries[0].focusNonce;

    act(() => result.current.popOut("project-a", session("a", "refreshed")));

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((entry) => entry.session.id)).toEqual(["a", "b"]);
    expect(result.current.entries[0]).toMatchObject({
      session: { title: "refreshed" },
      focusNonce: firstNonce + 1,
      cascadeSlot: 0,
    });
    expect(result.current.entries[1]).toMatchObject({ focusNonce: 1, cascadeSlot: 1 });
  });

  it("keeps equal session ids independent across projects", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("same", "A")));
    act(() => result.current.popOut("project-b", session("same", "B")));
    act(() => result.current.popOut("project-a", session("same", "A refreshed")));

    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((entry) => [entry.projectId, entry.session.title, entry.focusNonce])).toEqual([
      ["project-a", "A refreshed", 2],
      ["project-b", "B", 1],
    ]);
  });

  it("closes precisely, reuses the released cascade slot, and closes all", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("same")));
    act(() => result.current.popOut("project-a", session("other")));
    act(() => result.current.popOut("project-b", session("same")));

    act(() => result.current.close("project-a", "other"));
    expect(result.current.entries.map((entry) => [entry.projectId, entry.session.id, entry.cascadeSlot]))
      .toEqual([["project-a", "same", 0], ["project-b", "same", 0]]);

    act(() => result.current.popOut("project-a", session("replacement")));
    expect(result.current.entries.find((entry) => entry.session.id === "replacement")).toMatchObject({ cascadeSlot: 1 });

    act(() => result.current.closeAll());
    expect(result.current.entries).toEqual([]);
  });
});
