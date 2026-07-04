import { useEffect } from "react";
import {
  isEditableShortcutTarget,
  isTextEntryShortcutTarget,
  resolveDashboardKeyboardShortcuts,
  shortcutMatchesEvent,
  type DashboardKeyboardShortcutMap,
} from "../utils/keyboardShortcuts";

export interface DashboardKeyboardShortcutHandlers {
  openQuickChat: () => void;
  toggleTerminal: () => void;
  closeTopmostPopup?: () => boolean;
}

export interface UseDashboardKeyboardShortcutsOptions extends DashboardKeyboardShortcutHandlers {
  shortcuts?: DashboardKeyboardShortcutMap | null;
  enabled?: boolean;
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
The global dashboard listener only handles document-level shortcuts after target/editable guards and default-prevented checks. This lets chat composers, task editors, Settings inputs, terminal fields, and nested widgets keep ownership of typed keys and Escape while the dashboard still opens high-value interfaces from page focus.
*/
export function useDashboardKeyboardShortcuts({
  shortcuts,
  enabled = true,
  openQuickChat,
  toggleTerminal,
  closeTopmostPopup,
}: UseDashboardKeyboardShortcutsOptions): void {
  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;
    const resolved = resolveDashboardKeyboardShortcuts(shortcuts);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;

      if (event.key === "Escape") {
        if (isTextEntryShortcutTarget(event.target)) return;
        if (closeTopmostPopup?.()) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        }
        return;
      }

      if (isEditableShortcutTarget(event.target)) return;

      if (shortcutMatchesEvent(resolved.quickChat, event)) {
        event.preventDefault();
        openQuickChat();
        return;
      }

      if (shortcutMatchesEvent(resolved.terminal, event)) {
        event.preventDefault();
        toggleTerminal();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeTopmostPopup, enabled, openQuickChat, shortcuts, toggleTerminal]);
}
