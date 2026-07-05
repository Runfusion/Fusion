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
  /*
  FNXC:DashboardShortcuts 2026-07-04-00:00:
  FN-7553 adds four more configurable actions. Each handler reuses an existing App nav callback (openFilesWithNav, openSettingsWithNav, a thin command-center nav wrapper, openNewTaskWithNav) so this hook never introduces a second/duplicate nav destination — it only dispatches to whatever the caller already uses for its header/sidebar entry points.
  */
  openFiles: () => void;
  openSettings: () => void;
  openCommandCenter: () => void;
  openNewTask: () => void;
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
  openFiles,
  openSettings,
  openCommandCenter,
  openNewTask,
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
        return;
      }

      if (shortcutMatchesEvent(resolved.openFiles, event)) {
        event.preventDefault();
        openFiles();
        return;
      }

      if (shortcutMatchesEvent(resolved.openSettings, event)) {
        event.preventDefault();
        openSettings();
        return;
      }

      if (shortcutMatchesEvent(resolved.openCommandCenter, event)) {
        event.preventDefault();
        openCommandCenter();
        return;
      }

      if (shortcutMatchesEvent(resolved.newTask, event)) {
        event.preventDefault();
        openNewTask();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeTopmostPopup, enabled, openCommandCenter, openFiles, openNewTask, openQuickChat, openSettings, shortcuts, toggleTerminal]);
}
