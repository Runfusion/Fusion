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
    });
    expect(result.current.entries[1]).toMatchObject({ focusNonce: 1 });
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

  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: an external prefill belongs to the single conversation its request opened or created. Opening another
  conversation must not carry it, and an ordinary reopen must not re-seed the composer over a draft being typed.
  */
  it("attaches an external composer prefill to only the requested conversation", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("a"), { composerPrefill: "Analyse cette issue" }));
    act(() => result.current.popOut("project-a", session("b")));

    expect(result.current.entries[0].composerPrefill).toEqual({ text: "Analyse cette issue", nonce: 1 });
    expect(result.current.entries[1].composerPrefill).toBeUndefined();

    // A plain reopen keeps the same prefill nonce, so the window does not re-seed over the operator's draft.
    act(() => result.current.popOut("project-a", session("a", "refreshed")));
    expect(result.current.entries[0]).toMatchObject({ focusNonce: 2, composerPrefill: { text: "Analyse cette issue", nonce: 1 } });

    // A new request carrying text does re-seed, with an advanced nonce.
    act(() => result.current.popOut("project-a", session("a"), { composerPrefill: "Autre lien" }));
    expect(result.current.entries[0].composerPrefill).toEqual({ text: "Autre lien", nonce: 2 });
    expect(result.current.entries[1].composerPrefill).toBeUndefined();
  });

  /* FNXC:ChatWindows 2026-09-14-21:10: FN-394 moved window separation to the shared window-manager cohort, so entries no longer carry a chat-only cascade slot; only identity and closing remain this hook.s concern. */
  it("closes precisely and closes all", () => {
    const { result } = renderHook(() => usePoppedOutChats());
    act(() => result.current.popOut("project-a", session("same")));
    act(() => result.current.popOut("project-a", session("other")));
    act(() => result.current.popOut("project-b", session("same")));

    act(() => result.current.close("project-a", "other"));
    expect(result.current.entries.map((entry) => [entry.projectId, entry.session.id]))
      .toEqual([["project-a", "same"], ["project-b", "same"]]);

    act(() => result.current.popOut("project-a", session("replacement")));
    expect(result.current.entries.find((entry) => entry.session.id === "replacement")).toMatchObject({ focusNonce: 1 });

    act(() => result.current.closeAll());
    expect(result.current.entries).toEqual([]);
  });
});
