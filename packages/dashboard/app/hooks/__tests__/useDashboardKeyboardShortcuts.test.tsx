import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDashboardKeyboardShortcuts } from "../useDashboardKeyboardShortcuts";

function baseHandlers() {
  return {
    toggleFiles: vi.fn(),
    toggleSettings: vi.fn(),
    toggleCommandCenter: vi.fn(),
    toggleNewTask: vi.fn(),
  };
}

function press(init: KeyboardEventInit, target: Document | HTMLElement = document) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("useDashboardKeyboardShortcuts", () => {
  it("dispatches the Quick Chat toggle with the default Space binding from document focus", () => {
    const toggleQuickChat = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), toggleQuickChat, toggleTerminal: vi.fn() }));

    const event = press({ key: " " });

    expect(toggleQuickChat).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("dispatches Terminal toggles with custom shortcuts and honors disabled actions", () => {
    const toggleQuickChat = vi.fn();
    const toggleTerminal = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      shortcuts: { quickChat: "", terminal: "Alt+T" },
      toggleQuickChat,
      toggleTerminal,
    }));

    press({ key: " " });
    expect(toggleQuickChat).not.toHaveBeenCalled();

    const event = press({ key: "t", altKey: true });
    expect(toggleTerminal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores shortcuts from editable and interactive targets", () => {
    const toggleQuickChat = vi.fn();
    const toggleTerminal = vi.fn();
    const input = document.createElement("input");
    const button = document.createElement("button");
    document.body.append(input, button);
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), toggleQuickChat, toggleTerminal }));

    input.focus();
    press({ key: " " }, input);
    press({ key: "`", ctrlKey: true }, input);
    button.focus();
    press({ key: " " }, button);

    expect(toggleQuickChat).not.toHaveBeenCalled();
    expect(toggleTerminal).not.toHaveBeenCalled();
    input.remove();
    button.remove();
  });

  it("does not handle default-prevented nested menu events", () => {
    const toggleQuickChat = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), toggleQuickChat, toggleTerminal: vi.fn() }));

    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    Object.defineProperty(event, "defaultPrevented", { value: true });
    document.dispatchEvent(event);

    expect(toggleQuickChat).not.toHaveBeenCalled();
  });

  it("delegates Escape to the topmost popup closer once", () => {
    const closeTopmostPopup = vi.fn(() => true);
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      toggleQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    const event = press({ key: "Escape" });

    expect(closeTopmostPopup).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not globally close popups when Escape originates from text-entry targets", () => {
    const closeTopmostPopup = vi.fn(() => true);
    const input = document.createElement("input");
    document.body.appendChild(input);
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      toggleQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      closeTopmostPopup,
    }));

    input.focus();
    const inputEvent = press({ key: "Escape" }, input);

    expect(closeTopmostPopup).not.toHaveBeenCalled();
    expect(inputEvent.defaultPrevented).toBe(false);
    input.remove();
  });
});

describe("FN-7553 new actions", () => {
  it("dispatches Files, Settings, Command Center, and New Task toggles on their default bindings", () => {
    const toggleFiles = vi.fn();
    const toggleSettings = vi.fn();
    const toggleCommandCenter = vi.fn();
    const toggleNewTask = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      toggleQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      toggleFiles,
      toggleSettings,
      toggleCommandCenter,
      toggleNewTask,
    }));

    const filesEvent = press({ key: "e", ctrlKey: true });
    expect(toggleFiles).toHaveBeenCalledTimes(1);
    expect(filesEvent.defaultPrevented).toBe(true);

    press({ key: ",", ctrlKey: true });
    expect(toggleSettings).toHaveBeenCalledTimes(1);

    press({ key: "k", ctrlKey: true });
    expect(toggleCommandCenter).toHaveBeenCalledTimes(1);

    press({ key: "n", ctrlKey: true, shiftKey: true });
    expect(toggleNewTask).toHaveBeenCalledTimes(1);
  });

  it("no-ops new actions when their binding is disabled and ignores editable targets", () => {
    const toggleFiles = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    renderHook(() => useDashboardKeyboardShortcuts({
      shortcuts: { openFiles: "" },
      toggleQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      toggleFiles,
      toggleSettings: vi.fn(),
      toggleCommandCenter: vi.fn(),
      toggleNewTask: vi.fn(),
    }));

    press({ key: "e", ctrlKey: true });
    expect(toggleFiles).not.toHaveBeenCalled();

    input.focus();
    press({ key: "k", ctrlKey: true }, input);
    input.remove();
  });
});
