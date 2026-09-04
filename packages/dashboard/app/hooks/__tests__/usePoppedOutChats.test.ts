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
    expect(result.current.entries[0].minimized).toBe(false);
    act(() => result.current.popOut("project-a", session("b")));
    const firstNonce = result.current.entries[0].focusNonce;

    // App.tsx:2152 depends on length remaining stable for Quick Chat outside dismissal.
    act(() => result.current.popOut("project-a", session("a", "refreshed")));
    expect(result.current.entries).toHaveLength(2);
    expect(result.current.entries.map((entry) => entry.session.id)).toEqual(["a", "b"]);
    expect(result.current.entries[0]).toMatchObject({ session: { title: "refreshed" }, focusNonce: firstNonce + 1, cascadeSlot: 0 });
    expect(result.current.entries[1].focusNonce).toBe(1);
  });

  it("minimizes and restores every project while preserving entry state", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("a")));
    act(() => result.current.popOut("project-a", session("b")));
    act(() => result.current.popOut("project-b", session("c")));
    act(() => result.current.popOut("project-a", session("a", "raised")));
    const before = result.current.entries.map(({ projectId, session: currentSession, focusNonce, cascadeSlot }) => ({
      projectId,
      sessionId: currentSession.id,
      focusNonce,
      cascadeSlot,
    }));

    act(() => result.current.minimizeAll());
    expect(result.current.entries.every((entry) => entry.minimized)).toBe(true);
    expect(result.current.entries.map(({ projectId, session: currentSession, focusNonce, cascadeSlot }) => ({
      projectId,
      sessionId: currentSession.id,
      focusNonce,
      cascadeSlot,
    }))).toEqual(before);

    act(() => result.current.restoreAll());
    expect(result.current.entries.every((entry) => !entry.minimized)).toBe(true);
    expect(result.current.entries.map(({ projectId, session: currentSession, focusNonce, cascadeSlot }) => ({
      projectId,
      sessionId: currentSession.id,
      focusNonce,
      cascadeSlot,
    }))).toEqual(before);
  });

  it("reveals only a re-raised minimized entry and preserves its slot", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("a")));
    act(() => result.current.popOut("project-a", session("b")));
    act(() => result.current.minimizeAll());
    const firstBefore = result.current.entries[0];

    act(() => result.current.popOut("project-a", session("a", "refreshed")));

    expect(result.current.entries[0]).toMatchObject({
      session: { id: "a", title: "refreshed" },
      focusNonce: firstBefore.focusNonce + 1,
      cascadeSlot: firstBefore.cascadeSlot,
      minimized: false,
    });
    expect(result.current.entries[1]).toMatchObject({ session: { id: "b" }, minimized: true });
  });

  it("closes a minimized entry precisely and releases its cascade slot", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("same")));
    act(() => result.current.popOut("project-a", session("other")));
    act(() => result.current.popOut("project-b", session("same")));
    act(() => result.current.minimizeAll());

    act(() => result.current.close("project-a", "other"));
    expect(result.current.entries.map((entry) => [entry.projectId, entry.session.id, entry.minimized]))
      .toEqual([["project-a", "same", true], ["project-b", "same", true]]);
    act(() => result.current.popOut("project-a", session("replacement")));
    expect(result.current.entries.find((entry) => entry.session.id === "replacement")).toMatchObject({
      cascadeSlot: 1,
      minimized: false,
    });
    act(() => result.current.closeAll());
    expect(result.current.entries).toEqual([]);
  });
});
