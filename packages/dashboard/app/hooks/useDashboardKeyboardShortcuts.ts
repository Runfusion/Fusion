import { useEffect } from "react";
import {
  isEditableShortcutTarget,
  isTextEntryShortcutTarget,
  resolveDashboardKeyboardShortcuts,
  shortcutMatchesEvent,
  type DashboardKeyboardShortcutMap,
} from "../utils/keyboardShortcuts";

export interface DashboardKeyboardShortcutHandlers {
  /*
  FNXC:DashboardShortcuts 2026-09-14-11:35:
  FN-390 makes the first shortcut callback modal-agnostic. The app's window manager owns the visibility snapshot; this listener only dispatches the configured action, whose binding is disabled by default.
  */
  toggleModalVisibility: () => void;
  toggleTerminal: () => void;
  closeTopmostPopup?: () => boolean;
  toggleFiles: () => void;
  toggleSettings: () => void;
  toggleCommandCenter: () => void;
  toggleNewTask: () => void;
  /*
  FNXC:DashboardShortcuts 2026-09-16-02:27:
  FN-441 : bascule de la liste des chats. L'action reste derrière LES DEUX gardes de saisie, donc un composer de
  chat, un éditeur ou un terminal conserve la frappe ; App choisit l'hôte (tiroir téléphone / popover pied de page).
  */
  toggleChatList: () => void;
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
  toggleModalVisibility,
  toggleTerminal,
  closeTopmostPopup,
  toggleFiles,
  toggleSettings,
  toggleCommandCenter,
  toggleNewTask,
  toggleChatList,
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

      if (isTextEntryShortcutTarget(event.target)) return;

      /*
      FNXC:DashboardShortcuts 2026-09-14-11:35:
      The visibility action runs before the broad non-text control guard so a second configured keypress can restore windows while focus sits on the footer toggle. Inputs, editors, terminals, and opt-out regions remain protected by the stricter text-entry guard above.
      */
      if (shortcutMatchesEvent(resolved.toggleModalVisibility, event)) {
        event.preventDefault();
        toggleModalVisibility();
        return;
      }

      if (isEditableShortcutTarget(event.target)) return;

      if (shortcutMatchesEvent(resolved.terminal, event)) {
        event.preventDefault();
        toggleTerminal();
        return;
      }

      if (shortcutMatchesEvent(resolved.openFiles, event)) {
        event.preventDefault();
        toggleFiles();
        return;
      }

      if (shortcutMatchesEvent(resolved.openSettings, event)) {
        event.preventDefault();
        toggleSettings();
        return;
      }

      if (shortcutMatchesEvent(resolved.openCommandCenter, event)) {
        event.preventDefault();
        toggleCommandCenter();
        return;
      }

      if (shortcutMatchesEvent(resolved.newTask, event)) {
        event.preventDefault();
        toggleNewTask();
        return;
      }

      if (shortcutMatchesEvent(resolved.openChatList, event)) {
        event.preventDefault();
        toggleChatList();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeTopmostPopup, enabled, shortcuts, toggleChatList, toggleCommandCenter, toggleFiles, toggleModalVisibility, toggleNewTask, toggleSettings, toggleTerminal]);
}
