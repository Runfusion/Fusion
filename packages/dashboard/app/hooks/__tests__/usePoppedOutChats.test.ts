import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePoppedOutChats } from "../usePoppedOutChats";
import type { ChatSessionInfo } from "../useChat";

const session = (id: string, title = id): ChatSessionInfo => ({
  id, agentId: "agent-1", title, status: "active", createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
});

describe("usePoppedOutChats", () => {
  it("refreshes an existing entry in place and raises its focus nonce", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("a")));
    act(() => result.current.popOut("project-a", session("b")));
    const firstNonce = result.current.entries[0].focusNonce;

    // App.tsx:2152 depends on length remaining stable for Quick Chat outside dismissal.
    act(() => result.current.popOut("project-a", session("a", "refreshed")));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((entry) => entry.session.id)).toEqual(["a", "b"]);
    expect(result.current.entries[0]).toMatchObject({ session: { title: "refreshed" }, focusNonce: firstNonce + 1, cascadeSlot: 0 });
    expect(result.current.entries[1].focusNonce).toBe(1);
  });

  it("keeps counters independent across sessions and projects, then closes precisely", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("same")));
    act(() => result.current.popOut("project-a", session("other")));
    act(() => result.current.popOut("project-b", session("same")));
    act(() => result.current.popOut("project-a", session("same", "raised")));

    expect(result.current.entries.map((entry) => [entry.projectId, entry.session.id, entry.focusNonce, entry.cascadeSlot]))
      .toEqual([["project-a", "same", 2, 0], ["project-a", "other", 1, 1], ["project-b", "same", 1, 0]]);
    act(() => result.current.close("project-a", "other"));
    act(() => result.current.popOut("project-a", session("replacement")));
    expect(result.current.entries.find((entry) => entry.session.id === "replacement")?.cascadeSlot).toBe(1);
    expect(result.current.entries.map((entry) => entry.session.id)).toEqual(["same", "same", "replacement"]);
    act(() => result.current.closeAll());
    expect(result.current.entries).toEqual([]);
  });
});
