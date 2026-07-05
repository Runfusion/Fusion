import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { closeTopmostDashboardPopupForShortcut } from "../App";
import { useDashboardKeyboardShortcuts } from "../hooks/useDashboardKeyboardShortcuts";

function baseHandlers() {
  return {
    openFiles: vi.fn(),
    openSettings: vi.fn(),
    openCommandCenter: vi.fn(),
    openNewTask: vi.fn(),
  };
}

/*
FNXC:DashboardShortcuts 2026-07-04-12:02:
FN-7507 closes the FN-7494 Code Review gap by proving the dashboard shortcut/Escape invariants at the App-owned seam without rendering every lazy dashboard surface. The hook assertions cover settings-to-document key handling, while closeTopmostDashboardPopupForShortcut covers the App shell's one-popup Escape ordering.
*/
function press(init: KeyboardEventInit, target: Document | HTMLElement = document) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("App dashboard keyboard shortcuts", () => {
  it("opens Quick Chat with the default Space binding from document focus", () => {
    const openQuickChat = vi.fn();

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), openQuickChat, toggleTerminal: vi.fn() }));
    const event = press({ key: " " });

    expect(openQuickChat).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("uses configured Terminal bindings and leaves disabled bindings inert", () => {
    const openQuickChat = vi.fn();
    const toggleTerminal = vi.fn();

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      shortcuts: { quickChat: "", terminal: "Alt+T" },
      openQuickChat,
      toggleTerminal,
    }));

    const disabledQuickChatEvent = press({ key: " " });
    expect(openQuickChat).not.toHaveBeenCalled();
    expect(disabledQuickChatEvent.defaultPrevented).toBe(false);

    const terminalEvent = press({ key: "t", altKey: true });
    expect(toggleTerminal).toHaveBeenCalledTimes(1);
    expect(terminalEvent.defaultPrevented).toBe(true);
  });

  it("does not capture Space or Escape while an editable field owns the key", () => {
    const openQuickChat = vi.fn();
    const closeTopmostPopup = vi.fn(() => true);
    const input = document.createElement("input");
    document.body.append(input);

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      openQuickChat,
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    input.focus();
    const spaceEvent = press({ key: " " }, input);
    const escapeEvent = press({ key: "Escape" }, input);

    expect(openQuickChat).not.toHaveBeenCalled();
    expect(closeTopmostPopup).not.toHaveBeenCalled();
    expect(spaceEvent.defaultPrevented).toBe(false);
    expect(escapeEvent.defaultPrevented).toBe(false);

    input.remove();
  });

  it("lets nested handlers keep default-prevented shortcut events", () => {
    const openQuickChat = vi.fn();
    const closeTopmostPopup = vi.fn(() => true);

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      openQuickChat,
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    const menuSpace = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    Object.defineProperty(menuSpace, "defaultPrevented", { value: true });
    document.dispatchEvent(menuSpace);

    const menuEscape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    Object.defineProperty(menuEscape, "defaultPrevented", { value: true });
    document.dispatchEvent(menuEscape);

    expect(openQuickChat).not.toHaveBeenCalled();
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
        poppedOutTaskIds: ["FN-1", "FN-2"],
        quickChatOpen: true,
        terminalOpen: true,
        modalClosers: [[true, closeSettings], [true, closeTaskDetail]],
      },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closePoppedOutTask).toHaveBeenCalledWith("FN-2");
    expect(closeQuickChat).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(closeSettings).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskIds: [], quickChatOpen: true, terminalOpen: true, modalClosers: [[true, closeSettings]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closeQuickChat).toHaveBeenCalledTimes(1);
    expect(closeTerminal).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskIds: [], quickChatOpen: false, terminalOpen: true, modalClosers: [[true, closeSettings]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskIds: [], quickChatOpen: false, terminalOpen: false, modalClosers: [[false, closeSettings], [true, closeTaskDetail]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(true);
    expect(closeTaskDetail).toHaveBeenCalledTimes(1);
    expect(closeSettings).not.toHaveBeenCalled();

    expect(closeTopmostDashboardPopupForShortcut(
      { poppedOutTaskIds: [], quickChatOpen: false, terminalOpen: false, modalClosers: [[false, closeSettings]] },
      { closePoppedOutTask, closeQuickChat, closeTerminal },
    )).toBe(false);
  });

  it("prevents Escape only when the App shell closes a popup", () => {
    const closeTopmostPopup = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      openQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    const handled = press({ key: "Escape" });
    const unhandled = press({ key: "Escape" });

    expect(closeTopmostPopup).toHaveBeenCalledTimes(2);
    expect(handled.defaultPrevented).toBe(true);
    expect(unhandled.defaultPrevented).toBe(false);
  });
  it("dispatches the FN-7553 openFiles/openSettings/openCommandCenter/newTask actions and ignores editable targets", () => {
    const openFiles = vi.fn();
    const openSettings = vi.fn();
    const openCommandCenter = vi.fn();
    const openNewTask = vi.fn();
    const input = document.createElement("input");
    document.body.append(input);

    renderHook(() => useDashboardKeyboardShortcuts({
      openQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      openFiles,
      openSettings,
      openCommandCenter,
      openNewTask,
    }));

    press({ key: "e", ctrlKey: true });
    press({ key: ",", ctrlKey: true });
    press({ key: "k", ctrlKey: true });
    press({ key: "n", ctrlKey: true, shiftKey: true });
    expect(openFiles).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);
    expect(openCommandCenter).toHaveBeenCalledTimes(1);
    expect(openNewTask).toHaveBeenCalledTimes(1);

    input.focus();
    press({ key: "e", ctrlKey: true }, input);
    expect(openFiles).toHaveBeenCalledTimes(1);
    input.remove();
  });
});
