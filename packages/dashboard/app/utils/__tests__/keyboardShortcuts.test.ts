import { describe, expect, it } from "vitest";
import {
  DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS,
  SHORTCUT_CATEGORIES,
  describeShortcutValidation,
  findShortcutConflicts,
  getShortcutActionLabel,
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
    expect(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS).toEqual({
      toggleModalVisibility: "",
      terminal: "Ctrl+`",
      openFiles: "Ctrl+E",
      openSettings: "Ctrl+,",
      openCommandCenter: "Ctrl+K",
      newTask: "Ctrl+Shift+N",
      openChatList: "Ctrl+Shift+L",
    });
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
    expect(describeShortcutValidation({ toggleModalVisibility: "Ctrl+Alt", terminal: "Ctrl+`" })).toContain("Toggle Modal Visibility shortcut is invalid");
  });

  it("detects duplicate populated shortcut combinations while ignoring disabled actions", () => {
    expect(findShortcutConflicts({ toggleModalVisibility: "Ctrl+K", terminal: "Control+k" })).toEqual([
      { shortcut: "Ctrl+K", actions: ["toggleModalVisibility", "terminal"], labels: ["Toggle Modal Visibility", "Terminal"] },
    ]);
    expect(findShortcutConflicts({ toggleModalVisibility: "", terminal: "" })).toEqual([]);
    expect(describeShortcutValidation({ toggleModalVisibility: "Ctrl+K", terminal: "Control+k" })).toContain("both use Ctrl+K");
  });

  it("matches printable, Space, Escape, and modifier keydown events", () => {
    expect(shortcutMatchesEvent("Space", keydown({ key: " " }))).toBe(true);
    expect(shortcutMatchesEvent("Escape", keydown({ key: "Escape" }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+`", keydown({ key: "`", ctrlKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Meta+K", keydown({ key: "k", metaKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Alt+T", keydown({ key: "t", altKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+K", keydown({ key: "k" }))).toBe(false);
    expect(shortcutMatchesEvent("", keydown({ key: " " }))).toBe(false);
  });

  it("resolves missing settings to documented defaults", () => {
    expect(resolveDashboardKeyboardShortcuts(undefined)).toEqual(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS);
    expect(resolveDashboardKeyboardShortcuts({ toggleModalVisibility: "", terminal: "Alt+T" })).toEqual({
      ...DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS,
      toggleModalVisibility: "",
      terminal: "Alt+T",
    });
  });

  it("covers every action in categories, labels, and default-conflict-free bindings (FN-7553)", () => {
    const categorizedActions = SHORTCUT_CATEGORIES.flatMap((category) => category.actions).sort();
    const allActions = Object.keys(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS).sort();
    expect(categorizedActions).toEqual(allActions);
    allActions.forEach((action) => {
      expect(getShortcutActionLabel(action as keyof typeof DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS)).toBeTruthy();
    });
    expect(findShortcutConflicts(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS)).toEqual([]);
    expect(describeShortcutValidation(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS)).toBeNull();
  });

  it("resolves, matches, and validates each new FN-7553 action", () => {
    expect(resolveDashboardKeyboardShortcuts({ openFiles: "" })).toMatchObject({ openFiles: "" });
    expect(shortcutMatchesEvent("Ctrl+E", keydown({ key: "e", ctrlKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+,", keydown({ key: ",", ctrlKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+K", keydown({ key: "k", ctrlKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+Shift+N", keydown({ key: "n", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(describeShortcutValidation({ openFiles: "" })).toBeNull();
  });

  /*
  FNXC:DashboardShortcuts 2026-09-16-02:27:
  FN-441 : le raccourci « Open Chat List » doit se résoudre à son défaut documenté quand aucun réglage n'est
  persisté, matcher exactement Ctrl+Shift+L (et pas Ctrl+L), rester vide quand l'opérateur le désactive, et
  n'introduire aucun conflit dans le jeu de défauts livré.
  */
  it("resolves, matches, and validates the FN-441 chat-list action", () => {
    expect(resolveDashboardKeyboardShortcuts(undefined).openChatList).toBe("Ctrl+Shift+L");
    expect(resolveDashboardKeyboardShortcuts({ terminal: "Alt+T" }).openChatList).toBe("Ctrl+Shift+L");
    expect(shortcutMatchesEvent("Ctrl+Shift+L", keydown({ key: "l", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(shortcutMatchesEvent("Ctrl+Shift+L", keydown({ key: "l", ctrlKey: true }))).toBe(false);

    expect(findShortcutConflicts(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS)).toEqual([]);

    const duplicated = { ...DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS, openChatList: "Ctrl+K" };
    expect(findShortcutConflicts(duplicated)).toEqual([
      { shortcut: "Ctrl+K", actions: ["openCommandCenter", "openChatList"], labels: ["Open Command Center", "Open Chat List"] },
    ]);
    expect(describeShortcutValidation(duplicated)).toContain("both use Ctrl+K");

    expect(resolveDashboardKeyboardShortcuts({ openChatList: "" }).openChatList).toBe("");
    expect(shortcutMatchesEvent("", keydown({ key: "l", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(getShortcutActionLabel("openChatList")).toBe("Open Chat List");
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
