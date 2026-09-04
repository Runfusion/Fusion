import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { ChatSessionInfo } from "../useChat";
import {
  resolveChatVisibilityToggleAction,
  shouldCloseQuickChatOnOutsideClick,
  useChatVisibilityToggle,
} from "../useChatVisibilityToggle";
import { usePoppedOutChats } from "../usePoppedOutChats";

const session = (id: string): ChatSessionInfo => ({
  id,
  agentId: "agent-1",
  title: id,
  status: "active",
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
});

function useHarness(initialQuickChatOpen = false) {
  const [quickChatOpen, setQuickChatOpen] = useState(initialQuickChatOpen);
  const poppedOutChats = usePoppedOutChats();
  const visibility = useChatVisibilityToggle({
    quickChatOpen,
    setQuickChatOpen,
    poppedOutChatEntries: poppedOutChats.entries,
    minimizeAllPoppedOutChats: poppedOutChats.minimizeAll,
    restoreAllPoppedOutChats: poppedOutChats.restoreAll,
  });
  return { quickChatOpen, poppedOutChats, visibility };
}

describe("resolveChatVisibilityToggleAction", () => {
  it.each([
    ["no chat surfaces", false, false, [], "open-quick-chat"],
    ["Quick Chat visible", true, false, [], "minimize-all"],
    ["one popped-out chat visible", false, false, [false], "minimize-all"],
    ["several popped-out chats visible", false, false, [false, false], "minimize-all"],
    ["mixed popped-out visibility", false, false, [true, false], "minimize-all"],
    ["all popped-out chats minimized with Quick Chat memory", false, true, [true, true], "restore-all"],
    ["all popped-out chats minimized without Quick Chat memory", false, false, [true, true], "restore-all"],
    ["Quick Chat memory without popped-out chats", false, true, [], "restore-all"],
  ] as const)("resolves %s", (_label, quickChatOpen, quickChatMinimized, minimizedStates, expected) => {
    expect(resolveChatVisibilityToggleAction({
      quickChatOpen,
      quickChatMinimized,
      poppedOutChatEntries: minimizedStates.map((minimized) => ({ minimized })),
    })).toBe(expected);
  });
});

describe("shouldCloseQuickChatOnOutsideClick", () => {
  it.each([
    ["setting off with no entries", false, [], false],
    ["setting on with no entries", true, [], true],
    ["setting off with all minimized", false, [true, true], false],
    ["setting on with all minimized", true, [true, true], true],
    ["setting off with a visible entry", false, [true, false], false],
    ["setting on with a visible entry", true, [true, false], false],
  ] as const)("handles %s", (_label, quickChatCloseOnOutsideClick, minimizedStates, expected) => {
    expect(shouldCloseQuickChatOnOutsideClick({
      quickChatCloseOnOutsideClick,
      poppedOutChatEntries: minimizedStates.map((minimized) => ({ minimized })),
    })).toBe(expected);
  });
});

describe("useChatVisibilityToggle", () => {
  it("opens Quick Chat when nothing is open", () => {
    const { result } = renderHook(() => useHarness());

    act(() => result.current.visibility.toggle());

    expect(result.current.quickChatOpen).toBe(true);
    expect(result.current.poppedOutChats.entries).toEqual([]);
  });

  it("minimizes and restores Quick Chat by itself", () => {
    const { result } = renderHook(() => useHarness(true));

    act(() => result.current.visibility.toggle());
    expect(result.current.quickChatOpen).toBe(false);
    expect(result.current.visibility.action).toBe("restore-all");

    act(() => result.current.visibility.toggle());
    expect(result.current.quickChatOpen).toBe(true);
  });

  it("minimizes and restores Quick Chat with every popped-out chat", () => {
    const { result } = renderHook(() => useHarness(true));
    act(() => {
      result.current.poppedOutChats.popOut("project-a", session("a"));
      result.current.poppedOutChats.popOut("project-a", session("b"));
    });

    act(() => result.current.visibility.toggle());
    expect(result.current.quickChatOpen).toBe(false);
    expect(result.current.poppedOutChats.entries.every((entry) => entry.minimized)).toBe(true);

    act(() => result.current.visibility.toggle());
    expect(result.current.quickChatOpen).toBe(true);
    expect(result.current.poppedOutChats.entries.every((entry) => !entry.minimized)).toBe(true);
  });

  it("restores popped-out chats without opening a Quick Chat that was closed", () => {
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.poppedOutChats.popOut("project-a", session("a"));
      result.current.poppedOutChats.popOut("project-a", session("b"));
    });

    act(() => result.current.visibility.toggle());
    expect(result.current.poppedOutChats.entries.every((entry) => entry.minimized)).toBe(true);
    act(() => result.current.visibility.toggle());

    expect(result.current.quickChatOpen).toBe(false);
    expect(result.current.poppedOutChats.entries.every((entry) => !entry.minimized)).toBe(true);
  });

  it("reveals a new pop-out alone, then minimizes and restores the whole set", () => {
    const { result } = renderHook(() => useHarness());
    act(() => {
      result.current.poppedOutChats.popOut("project-a", session("a"));
      result.current.poppedOutChats.popOut("project-a", session("b"));
    });
    act(() => result.current.visibility.toggle());

    act(() => result.current.poppedOutChats.popOut("project-a", session("c")));
    expect(result.current.poppedOutChats.entries.map((entry) => entry.minimized)).toEqual([true, true, false]);

    act(() => result.current.visibility.toggle());
    expect(result.current.poppedOutChats.entries.every((entry) => entry.minimized)).toBe(true);
    act(() => result.current.visibility.toggle());

    expect(result.current.quickChatOpen).toBe(false);
    expect(result.current.poppedOutChats.entries.every((entry) => !entry.minimized)).toBe(true);
  });

  it("reset prevents minimized Quick Chat memory from crossing a teardown", () => {
    const { result } = renderHook(() => useHarness(true));
    act(() => result.current.poppedOutChats.popOut("project-a", session("a")));
    act(() => result.current.visibility.toggle());
    expect(result.current.quickChatOpen).toBe(false);

    act(() => result.current.visibility.reset());
    act(() => result.current.visibility.toggle());

    expect(result.current.quickChatOpen).toBe(false);
    expect(result.current.poppedOutChats.entries[0].minimized).toBe(false);
  });
});
