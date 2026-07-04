import { describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS,
  describeShortcutValidation,
  findShortcutConflicts,
  isEditableShortcutTarget,
  isTextEntryShortcutTarget,
  normalizeKeyboardShortcut,
  resolveDashboardKeyboardShortcuts,
  shortcutMatchesEvent,
} from "../keyboardShortcuts";

function keydown(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

describe("keyboard shortcut utilities", () => {
  it("normalizes defaults, Space, Escape, modifiers, and disabled values", () => {
    expect(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS).toEqual({ quickChat: "Space", terminal: "Ctrl+`" });
    expect(normalizeKeyboardShortcut(" ").disabled).toBe(true);
    expect(normalizeKeyboardShortcut("Space")).toMatchObject({ valid: true, normalized: "Space", key: "Space" });
    expect(normalizeKeyboardShortcut("Esc")).toMatchObject({ valid: true, normalized: "Escape", key: "Escape" });
    expect(normalizeKeyboardShortcut("cmd+k")).toMatchObject({ valid: true, normalized: "Meta+K", key: "K" });
    expect(normalizeKeyboardShortcut("Control + Shift + p")).toMatchObject({ valid: true, normalized: "Ctrl+Shift+P", key: "P" });
  });

  it("rejects invalid strings and duplicate modifiers", () => {
    expect(normalizeKeyboardShortcut("Ctrl+Alt").valid).toBe(false);
    expect(normalizeKeyboardShortcut("Ctrl+Ctrl+K").valid).toBe(false);
    expect(normalizeKeyboardShortcut("Ctrl+K+P").valid).toBe(false);
    expect(describeShortcutValidation({ quickChat: "Ctrl+Alt", terminal: "Ctrl+`" })).toContain("Quick Chat shortcut is invalid");
  });

  it("detects duplicate populated shortcut combinations while ignoring disabled actions", () => {
    expect(findShortcutConflicts({ quickChat: "Ctrl+K", terminal: "Control+k" })).toEqual([
      { shortcut: "Ctrl+K", actions: ["quickChat", "terminal"], labels: ["Quick Chat", "Terminal"] },
    ]);
    expect(findShortcutConflicts({ quickChat: "", terminal: "" })).toEqual([]);
    expect(describeShortcutValidation({ quickChat: "Ctrl+K", terminal: "Control+k" })).toContain("both use Ctrl+K");
  });

  it("matches printable, Space, Escape, and modifier keydown events", () => {
    expect(shortcutMatchesEvent("Space", keydown({ key: " " }))).toBe(true);
    expect(shortcutMatchesEvent("Escape", keydown({ key: "Escape" }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+`", keydown({ key: "`", ctrlKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Meta+K", keydown({ key: "k", metaKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+K", keydown({ key: "k" }))).toBe(false);
    expect(shortcutMatchesEvent("", keydown({ key: " " }))).toBe(false);
  });

  it("resolves missing settings to documented defaults", () => {
    expect(resolveDashboardKeyboardShortcuts(undefined)).toEqual(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS);
    expect(resolveDashboardKeyboardShortcuts({ quickChat: "", terminal: "Alt+T" })).toEqual({ quickChat: "", terminal: "Alt+T" });
  });

  it("identifies editable and interactive targets that should not be captured by global shortcuts", () => {
    const input = document.createElement("input");
    input.type = "text";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const ignored = document.createElement("div");
    ignored.setAttribute("data-shortcuts-ignore", "true");

    expect(isEditableShortcutTarget(input)).toBe(true);
    expect(isEditableShortcutTarget(checkbox)).toBe(true);
    expect(isEditableShortcutTarget(editor)).toBe(true);
    expect(isEditableShortcutTarget(ignored)).toBe(true);
    expect(isEditableShortcutTarget(document.createElement("button"))).toBe(true);
    expect(isEditableShortcutTarget(document.createElement("div"))).toBe(false);
    expect(isTextEntryShortcutTarget(input)).toBe(true);
    expect(isTextEntryShortcutTarget(checkbox)).toBe(false);
    expect(isTextEntryShortcutTarget(document.createElement("button"))).toBe(false);
  });
});
