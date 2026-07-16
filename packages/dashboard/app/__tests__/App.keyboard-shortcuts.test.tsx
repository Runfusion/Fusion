import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { closeTopmostDashboardPopupForShortcut } from "../App";
import { useDashboardKeyboardShortcuts } from "../hooks/useDashboardKeyboardShortcuts";
import { useNavigationHistory } from "../hooks/useNavigationHistory";
import { closeViewShortcut, retainViewNavRevert } from "../utils/dashboardShortcutToggles";

function baseHandlers() {
  return {
    toggleFiles: vi.fn(),
    toggleSettings: vi.fn(),
    toggleCommandCenter: vi.fn(),
    toggleNewTask: vi.fn(),
  };
}

/*
FNXC:DashboardShortcuts 2026-07-04-12:02:
FN-7507 closes the FN-7494 Code Review gap by proving the dashboard shortcut/Escape invariants at the App-owned seam without rendering every lazy dashboard surface. The hook assertions cover settings-to-document key handling, while closeTopmostDashboardPopupForShortcut covers the App shell's one-popup Escape ordering.

FNXC:DashboardShortcuts 2026-07-16-00:00:
FN-8069 adds live navigation-history coverage for the App helper that retains and closes Settings/Command Center view entries. It verifies callback identity removal, prior-view restoration, and Browser Back self-cleanup rather than relying on dispatcher spies alone (Runfusion/Fusion#2118).
*/
function press(init: KeyboardEventInit, target: Document | HTMLElement = document) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("App dashboard keyboard shortcuts", () => {
  it("opens Quick Chat with the default Space binding from document focus", () => {
    const toggleQuickChat = vi.fn();

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), toggleQuickChat, toggleTerminal: vi.fn() }));
    const event = press({ key: " " });

    expect(toggleQuickChat).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("dispatches every default shortcut twice so App toggle callbacks own both directions", () => {
    const toggleQuickChat = vi.fn();
    const toggleTerminal = vi.fn();
    const handlers = {
      toggleQuickChat,
      toggleTerminal,
      toggleFiles: vi.fn(),
      toggleSettings: vi.fn(),
      toggleCommandCenter: vi.fn(),
      toggleNewTask: vi.fn(),
    };
    renderHook(() => useDashboardKeyboardShortcuts(handlers));

    const bindings: KeyboardEventInit[] = [
      { key: " " },
      { key: "`", ctrlKey: true },
      { key: "e", ctrlKey: true },
      { key: ",", ctrlKey: true },
      { key: "k", ctrlKey: true },
      { key: "n", ctrlKey: true, shiftKey: true },
    ];
    for (const binding of bindings) {
      press(binding);
      press(binding);
    }

    for (const handler of Object.values(handlers)) {
      expect(handler).toHaveBeenCalledTimes(2);
    }
  });

  it("uses configured Terminal bindings and leaves disabled bindings inert", () => {
    const toggleQuickChat = vi.fn();
    const toggleTerminal = vi.fn();

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      shortcuts: { quickChat: "", terminal: "Alt+T" },
      toggleQuickChat,
      toggleTerminal,
    }));

    const disabledQuickChatEvent = press({ key: " " });
    expect(toggleQuickChat).not.toHaveBeenCalled();
    expect(disabledQuickChatEvent.defaultPrevented).toBe(false);

    const terminalEvent = press({ key: "t", altKey: true });
    expect(toggleTerminal).toHaveBeenCalledTimes(1);
    expect(terminalEvent.defaultPrevented).toBe(true);
  });

  it("does not capture Space or Escape while an editable field owns the key", () => {
    const toggleQuickChat = vi.fn();
    const closeTopmostPopup = vi.fn(() => true);
    const input = document.createElement("input");
    document.body.append(input);

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      toggleQuickChat,
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    input.focus();
    const spaceEvent = press({ key: " " }, input);
    const escapeEvent = press({ key: "Escape" }, input);

    expect(toggleQuickChat).not.toHaveBeenCalled();
    expect(closeTopmostPopup).not.toHaveBeenCalled();
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(escapeEvent.defaultPrevented).toBe(false);

    input.remove();
  });

  it("lets nested handlers keep default-prevented shortcut events", () => {
    const toggleQuickChat = vi.fn();
    const closeTopmostPopup = vi.fn(() => true);

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      toggleQuickChat,
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    const menuSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    Object.defineProperty(menuSpace, "defaultPrevented", { value: true });
    document.dispatchEvent(menuSpace);

    const menuEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(menuEscape, "defaultPrevented", { value: true });
    document.dispatchEvent(menuEscape);

    expect(toggleQuickChat).not.toHaveBeenCalled();
    expect(closeTopmostPopup).not.toHaveBeenCalled();
  });

  it("closes exactly one topmost App popup per Escape in shell order", () => {
    const closePoppedOutTask = vi.fn();
    const closeQuickChat = vi.fn();
    const closeTerminal = vi.fn();
    const closeSettings = vi.fn();
    const closeTaskDetail = vi.fn();

    expect(closeTopmostDashboardPopupForShortcut(
      {
        // FN-8016: explicit globally-visible opt-out can expose both same-id entries;
        // Escape must preserve origin identity and close only the topmost one.
        poppedOutTaskEntries: [{ task: { id: "FN-1" }, originTaskView: "board" }, { task: { id: "FN-1" }, originTaskView: "planning" }],
        quickChatOpen: true,
        terminalOpen: true,
        modalClosers: [[true, closeSettings], [true, closeTaskDetail]],
      },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closePoppedOutTask).toHaveBeenCalledWith("FN-1", "planning");
    expect(closeQuickChat).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskEntries: [], quickChatOpen: true, terminalOpen: true, modalClosers: [[true, closeSettings]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closeQuickChat).toHaveBeenCalledTimes(1);
    expect(closeTerminal).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskEntries: [], quickChatOpen: false, terminalOpen: true, modalClosers: [[true, closeSettings]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskEntries: [], quickChatOpen: false, terminalOpen: false, modalClosers: [[false, closeSettings], [true, closeTaskDetail]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closeTaskDetail).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskEntries: [], quickChatOpen: false, terminalOpen: false, modalClosers: [[false, closeSettings]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(false);
  });

  it("prevents Escape only when the App shell closes a popup", () => {
    const closeTopmostPopup = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      toggleQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    const handled = press({ key: "Escape" });
    const unhandled = press({ key: "Escape" });

    expect(closeTopmostPopup).toHaveBeenCalledTimes(2);
    expect(handled.defaultPrevented).toBe(true);
    expect(unhandled.defaultPrevented).toBe(false);
  });
  it("dispatches the FN-7553 toggleFiles/toggleSettings/toggleCommandCenter/newTask actions and ignores editable targets", () => {
    const toggleFiles = vi.fn();
    const toggleSettings = vi.fn();
    const toggleCommandCenter = vi.fn();
    const toggleNewTask = vi.fn();
    const input = document.createElement("input");
    document.body.append(input);

    renderHook(() => useDashboardKeyboardShortcuts({
      toggleQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      toggleFiles,
      toggleSettings,
      toggleCommandCenter,
      toggleNewTask,
    }));

    press({ key: "e", ctrlKey: true });
    press({ key: ",", ctrlKey: true });
    press({ key: "k", ctrlKey: true });
    press({ key: "n", ctrlKey: true, shiftKey: true });
    expect(toggleFiles).toHaveBeenCalledTimes(1);
    expect(toggleSettings).toHaveBeenCalledTimes(1);
    expect(toggleCommandCenter).toHaveBeenCalledTimes(1);
    expect(toggleNewTask).toHaveBeenCalledTimes(1);

    press({ key: "e", ctrlKey: true });
    press({ key: ",", ctrlKey: true });
    press({ key: "k", ctrlKey: true });
    press({ key: "n", ctrlKey: true, shiftKey: true });
    expect(toggleFiles).toHaveBeenCalledTimes(2);
    expect(toggleSettings).toHaveBeenCalledTimes(2);
    expect(toggleCommandCenter).toHaveBeenCalledTimes(2);
    expect(toggleNewTask).toHaveBeenCalledTimes(2);

    input.focus();
    press({ key: "e", ctrlKey: true }, input);
    expect(toggleFiles).toHaveBeenCalledTimes(2);
    input.remove();
  });

  it("keeps invalid bindings inert without preventing their key event", () => {
    const toggleQuickChat = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      shortcuts: { quickChat: "Ctrl+Alt" },
      toggleQuickChat,
      toggleTerminal: vi.fn(),
    }));

    const event = press({ key: "a", ctrlKey: true, altKey: true });
    expect(toggleQuickChat).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("removes the exact retained view entry and restores the prior view", () => {
    const { result } = renderHook(() => useNavigationHistory({ enabled: true }));
    const reverts = new Map<string, (() => void)[]>();
    const restoreView = vi.fn();
    const revert = retainViewNavRevert("settings", "list", reverts, restoreView);
    const removeNav = vi.fn(result.current.removeNav);
    result.current.pushNav({ type: "view", revert });

    expect(closeViewShortcut("settings", reverts, removeNav, vi.fn())).toBe(true);
    expect(removeNav).toHaveBeenCalledWith(revert);
    expect(restoreView).toHaveBeenCalledWith("list");
    expect(reverts.has("settings")).toBe(false);
  });

  it("self-cleans retained view callbacks when Browser Back closes a view", () => {
    const { result } = renderHook(() => useNavigationHistory({ enabled: true }));
    const reverts = new Map<string, (() => void)[]>();
    const restoreView = vi.fn();
    const revert = retainViewNavRevert("command-center", "list", reverts, restoreView);
    result.current.pushNav({ type: "view", revert });

    act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } })));

    expect(restoreView).toHaveBeenCalledWith("list");
    expect(reverts.has("command-center")).toBe(false);
  });

  it("preserves an earlier Settings entry after closing a later Settings shortcut", () => {
    const reverts = new Map<string, (() => void)[]>();
    const restoreView = vi.fn();
    const removeNav = vi.fn();
    const firstSettingsRevert = retainViewNavRevert("settings", "list", reverts, restoreView);
    const boardRevert = retainViewNavRevert("board", "settings", reverts, restoreView);
    const secondSettingsRevert = retainViewNavRevert("settings", "board", reverts, restoreView);

    expect(closeViewShortcut("settings", reverts, removeNav, vi.fn())).toBe(true);
    expect(removeNav).toHaveBeenCalledWith(secondSettingsRevert);
    expect(restoreView).toHaveBeenLastCalledWith("board");
    expect(reverts.get("settings")).toEqual([firstSettingsRevert]);

    boardRevert();
    expect(closeViewShortcut("settings", reverts, removeNav, vi.fn())).toBe(true);
    expect(removeNav).toHaveBeenLastCalledWith(firstSettingsRevert);
    expect(restoreView).toHaveBeenLastCalledWith("list");
    expect(reverts.has("settings")).toBe(false);
  });
});
