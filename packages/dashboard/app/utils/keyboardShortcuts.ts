/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
FN-7553 adds four more configurable actions (openFiles, openSettings, openCommandCenter, newTask) on top of the FN-7494/FN-7507 base (quickChat, terminal). Every helper below (resolve/conflict/validate) derives its action list from DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS' keys instead of a hardcoded pair, so future actions only need an entry in the three maps below plus a category assignment.
*/
export type DashboardShortcutAction =
  | "quickChat"
  | "terminal"
  | "openFiles"
  | "openSettings"
  | "openCommandCenter"
  | "newTask";

export type DashboardKeyboardShortcutMap = Partial<Record<DashboardShortcutAction, string>>;

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
New defaults were chosen to avoid colliding with the existing Space/Ctrl+` bindings and with each other: Ctrl+E (open Files), Ctrl+, (open Settings, mirrors the common OS/app "preferences" comma-accelerator), Ctrl+K (open Command Center, the conventional command-palette binding), Ctrl+Shift+N (new Task, avoids the browser-reserved plain Ctrl+N "new window").
*/
export const DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS: Required<DashboardKeyboardShortcutMap> = {
  quickChat: "Space",
  terminal: "Ctrl+`",
  openFiles: "Ctrl+E",
  openSettings: "Ctrl+,",
  openCommandCenter: "Ctrl+K",
  newTask: "Ctrl+Shift+N",
};

const ACTION_LABELS: Record<DashboardShortcutAction, string> = {
  quickChat: "Quick Chat",
  terminal: "Terminal",
  openFiles: "Open Files",
  openSettings: "Open Settings",
  openCommandCenter: "Open Command Center",
  newTask: "New Task",
};

export interface DashboardShortcutCategory {
  id: string;
  label: string;
  actions: DashboardShortcutAction[];
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
Category grouping backs the dedicated Keyboard Shortcuts settings section (FN-7553) so actions render under headings instead of one flat list. This is UI-only metadata; resolution/conflict/validation logic never depends on category membership.
*/
export const SHORTCUT_CATEGORIES: DashboardShortcutCategory[] = [
  { id: "communication", label: "Communication", actions: ["quickChat"] },
  { id: "workspace", label: "Workspace", actions: ["terminal", "openFiles"] },
  { id: "navigation", label: "Navigation", actions: ["openCommandCenter", "openSettings"] },
  { id: "tasks", label: "Tasks", actions: ["newTask"] },
];

export function getShortcutActionLabel(action: DashboardShortcutAction): string {
  return ACTION_LABELS[action];
}

const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type ShortcutModifier = (typeof MODIFIER_ORDER)[number];

export interface NormalizedShortcut {
  input: string;
  normalized: string;
  display: string;
  key: string;
  modifiers: Record<ShortcutModifier, boolean>;
  disabled: boolean;
  valid: boolean;
  error?: string;
}

export interface ShortcutConflict {
  shortcut: string;
  actions: DashboardShortcutAction[];
  labels: string[];
}

function titleKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key === "`" ? "`" : key.toUpperCase();
  const lower = key.toLowerCase();
  if (lower === "space" || lower === "spacebar") return "Space";
  if (lower === "esc") return "Escape";
  if (lower === "arrowup") return "ArrowUp";
  if (lower === "arrowdown") return "ArrowDown";
  if (lower === "arrowleft") return "ArrowLeft";
  if (lower === "arrowright") return "ArrowRight";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

function emptyModifiers(): Record<ShortcutModifier, boolean> {
  return { Ctrl: false, Alt: false, Shift: false, Meta: false };
}

function modifierForToken(token: string): ShortcutModifier | null {
  const lower = token.toLowerCase();
  if (lower === "ctrl" || lower === "control" || lower === "cmdorctrl" || lower === "mod") return "Ctrl";
  if (lower === "alt" || lower === "option") return "Alt";
  if (lower === "shift") return "Shift";
  if (lower === "meta" || lower === "cmd" || lower === "command" || lower === "super") return "Meta";
  return null;
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
Shortcut parsing is shared by Settings validation and the App runtime so persisted labels, duplicate detection, and keydown matching cannot diverge. Empty strings are valid disabled bindings; unsupported strings are invalid and must not install runtime listeners.
*/
export function normalizeKeyboardShortcut(value: unknown): NormalizedShortcut {
  const input = typeof value === "string" ? value : "";
  const trimmed = input.trim();
  if (!trimmed) {
    return { input, normalized: "", display: "Disabled", key: "", modifiers: emptyModifiers(), disabled: true, valid: true };
  }

  const parts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) {
    return { input, normalized: "", display: "Disabled", key: "", modifiers: emptyModifiers(), disabled: true, valid: true };
  }

  const modifiers = emptyModifiers();
  let key = "";
  for (const part of parts) {
    const modifier = modifierForToken(part);
    if (modifier) {
      if (modifiers[modifier]) {
        return { input, normalized: trimmed, display: trimmed, key: "", modifiers, disabled: false, valid: false, error: `Duplicate modifier ${modifier}.` };
      }
      modifiers[modifier] = true;
      continue;
    }
    if (key) {
      return { input, normalized: trimmed, display: trimmed, key: "", modifiers, disabled: false, valid: false, error: "Use one non-modifier key per shortcut." };
    }
    key = titleKey(part);
  }

  if (!key) {
    return { input, normalized: trimmed, display: trimmed, key: "", modifiers, disabled: false, valid: false, error: "Add a key after the modifier." };
  }

  if (key.length !== 1 && !/^(Space|Escape|Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F\d{1,2})$/.test(key)) {
    return { input, normalized: trimmed, display: trimmed, key, modifiers, disabled: false, valid: false, error: "Use a printable key, Space, Escape, arrows, Tab, Enter, Delete, Backspace, or F1-F12." };
  }

  const normalizedParts: string[] = MODIFIER_ORDER.filter((modifier) => modifiers[modifier]);
  normalizedParts.push(key);
  const normalized = normalizedParts.join("+");
  return { input, normalized, display: normalized, key, modifiers, disabled: false, valid: true };
}

export function resolveDashboardKeyboardShortcuts(settings: DashboardKeyboardShortcutMap | null | undefined): Required<DashboardKeyboardShortcutMap> {
  const resolved = {} as Required<DashboardKeyboardShortcutMap>;
  (Object.keys(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS) as DashboardShortcutAction[]).forEach((action) => {
    resolved[action] = settings?.[action] ?? DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS[action];
  });
  return resolved;
}

export function findShortcutConflicts(shortcuts: DashboardKeyboardShortcutMap): ShortcutConflict[] {
  const seen = new Map<string, DashboardShortcutAction[]>();
  (Object.keys(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS) as DashboardShortcutAction[]).forEach((action) => {
    const parsed = normalizeKeyboardShortcut(shortcuts[action] ?? "");
    if (!parsed.valid || parsed.disabled) return;
    const actions = seen.get(parsed.normalized) ?? [];
    actions.push(action);
    seen.set(parsed.normalized, actions);
  });

  return Array.from(seen.entries())
    .filter(([, actions]) => actions.length > 1)
    .map(([shortcut, actions]) => ({ shortcut, actions, labels: actions.map((action) => ACTION_LABELS[action]) }));
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
Space and interface-opening shortcuts must ignore both text-entry and interactive controls so they do not steal typing or button/menu activation. Escape uses the narrower text-entry guard so document-level popup dismissal still works from ordinary controls while editors and terminal input keep ownership.
*/
const TEXT_ENTRY_SHORTCUT_TARGET_SELECTOR = "input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='textbox'], [data-shortcuts-ignore='true']";
const INTERACTIVE_SHORTCUT_TARGET_SELECTOR = `${TEXT_ENTRY_SHORTCUT_TARGET_SELECTOR}, button, a[href], summary, [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='switch'], [role='tab'], [role='menuitem']`;

function closestShortcutTarget(target: EventTarget | null, selector: string): Element | null {
  if (typeof Element === "undefined" || !(target instanceof Element)) return null;
  return target.closest(selector);
}

export function isTextEntryShortcutTarget(target: EventTarget | null): boolean {
  const editable = closestShortcutTarget(target, TEXT_ENTRY_SHORTCUT_TARGET_SELECTOR);
  if (!editable) return false;
  if (editable instanceof HTMLInputElement) {
    const type = editable.type.toLowerCase();
    return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  return true;
}

export function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return Boolean(closestShortcutTarget(target, INTERACTIVE_SHORTCUT_TARGET_SELECTOR));
}

export function shortcutMatchesEvent(shortcut: string | undefined, event: KeyboardEvent): boolean {
  const parsed = normalizeKeyboardShortcut(shortcut ?? "");
  if (!parsed.valid || parsed.disabled) return false;
  const eventKey = event.key === " " ? "Space" : titleKey(event.key);
  return eventKey === parsed.key
    && event.ctrlKey === parsed.modifiers.Ctrl
    && event.altKey === parsed.modifiers.Alt
    && event.shiftKey === parsed.modifiers.Shift
    && event.metaKey === parsed.modifiers.Meta;
}

export function describeShortcutValidation(shortcuts: DashboardKeyboardShortcutMap): string | null {
  const invalid = (Object.keys(DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS) as DashboardShortcutAction[])
    .map((action) => ({ action, parsed: normalizeKeyboardShortcut(shortcuts[action] ?? "") }))
    .find(({ parsed }) => !parsed.valid);
  if (invalid) return `${ACTION_LABELS[invalid.action]} shortcut is invalid: ${invalid.parsed.error ?? "Use a supported key combination."}`;
  const conflict = findShortcutConflicts(shortcuts)[0];
  if (conflict) return `${conflict.labels.join(" and ")} both use ${conflict.shortcut}. Choose unique shortcuts or disable one.`;
  return null;
}
