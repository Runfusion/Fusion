import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDashboardKeyboardShortcuts } from "../useDashboardKeyboardShortcuts";

function baseHandlers() {
  return {
    openFiles: vi.fn(),
    openSettings: vi.fn(),
    openCommandCenter: vi.fn(),
    openNewTask: vi.fn(),
  };
}

function press(init: KeyboardEventInit, target: Document | HTMLElement = document) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("useDashboardKeyboardShortcuts", () => {
  it("opens Quick Chat with the default Space binding from document focus", () => {
    const openQuickChat = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), openQuickChat, toggleTerminal: vi.fn() }));

    const event = press({ key: " " });

    expect(openQuickChat).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("opens Terminal with custom shortcuts and honors disabled actions", () => {
    const openQuickChat = vi.fn();
    const toggleTerminal = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      shortcuts: { quickChat: "", terminal: "Alt+T" },
      openQuickChat,
      toggleTerminal,
    }));

    press({ key: " " });
    expect(openQuickChat).not.toHaveBeenCalled();

    const event = press({ key: "t", altKey: true });
    expect(toggleTerminal).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores shortcuts from editable and interactive targets", () => {
    const openQuickChat = vi.fn();
    const toggleTerminal = vi.fn();
    const input = document.createElement("input");
    const button = document.createElement("button");
    document.body.append(input, button);
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), openQuickChat, toggleTerminal }));

    input.focus();
    press({ key: " " }, input);
    press({ key: "`", ctrlKey: true }, input);
    button.focus();
    press({ key: " " }, button);

    expect(openQuickChat).not.toHaveBeenCalled();
    expect(toggleTerminal).not.toHaveBeenCalled();
    input.remove();
    button.remove();
  });

  it("does not handle default-prevented nested menu events", () => {
    const openQuickChat = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(), openQuickChat, toggleTerminal: vi.fn() }));

    const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    Object.defineProperty(event, "defaultPrevented", { value: true });
    document.dispatchEvent(event);

    expect(openQuickChat).not.toHaveBeenCalled();
  });

  it("delegates Escape to the topmost popup closer once", () => {
    const closeTopmostPopup = vi.fn(() => true);
    renderHook(() => useDashboardKeyboardShortcuts({
      ...baseHandlers(),
      openQuickChat: vi.fn(),
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
      openQuickChat: vi.fn(),
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
  it("dispatches openFiles, openSettings, openCommandCenter, and newTask on their default bindings", () => {
    const openFiles = vi.fn();
    const openSettings = vi.fn();
    const openCommandCenter = vi.fn();
    const openNewTask = vi.fn();
    renderHook(() => useDashboardKeyboardShortcuts({
      openQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      openFiles,
      openSettings,
      openCommandCenter,
      openNewTask,
    }));

    const filesEvent = press({ key: "e", ctrlKey: true });
    expect(openFiles).toHaveBeenCalledTimes(1);
    expect(filesEvent.defaultPrevented).toBe(true);

    press({ key: ",", ctrlKey: true });
    expect(openSettings).toHaveBeenCalledTimes(1);

    press({ key: "k", ctrlKey: true });
    expect(openCommandCenter).toHaveBeenCalledTimes(1);

    press({ key: "n", ctrlKey: true, shiftKey: true });
    expect(openNewTask).toHaveBeenCalledTimes(1);
  });

  it("no-ops new actions when their binding is disabled and ignores editable targets", () => {
    const openFiles = vi.fn();
    const input = document.createElement("input");
    document.body.appendChild(input);
    renderHook(() => useDashboardKeyboardShortcuts({
      shortcuts: { openFiles: "" },
      openQuickChat: vi.fn(),
      toggleTerminal: vi.fn(),
      openFiles,
      openSettings: vi.fn(),
      openCommandCenter: vi.fn(),
      openNewTask: vi.fn(),
    }));

    press({ key: "e", ctrlKey: true });
    expect(openFiles).not.toHaveBeenCalled();

    input.focus();
    press({ key: "k", ctrlKey: true }, input);
    input.remove();
  });
});
