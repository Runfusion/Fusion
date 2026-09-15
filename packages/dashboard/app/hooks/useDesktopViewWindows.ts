import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseNavigationHistoryResult } from "./useNavigationHistory";

export type DesktopPilotView = "patchnode";
export type DesktopGuardTarget = DesktopPilotView | "notes" | `note:${string}:${string}`;
export type PilotCloseGuard = () => boolean | Promise<boolean>;
export type PilotCloseAccepted = () => void;

export interface DesktopWindowState {
  id: DesktopPilotView;
  raiseToFrontSignal: number;
}

interface UseDesktopViewWindowsOptions {
  enabled: boolean;
  projectId?: string;
  navigation: Pick<UseNavigationHistoryResult, "pushNav" | "removeNav" | "promoteNav">;
  showBoard: () => void;
  showNotesPage: () => void;
  notesDirty?: boolean;
}

/*
FNXC:DesktopViewWindows 2026-09-11-19:35:
The desktop shell keeps Board as the permanent main surface while History is the sole stable pilot window. Notes list is inline in the right dock, while every dedicated note window registers a project/note guard in the same scope-exit registry so all dirty drafts are confirmed independently before navigation or project changes.
*/
export function useDesktopViewWindows({ enabled, projectId, navigation, showBoard, showNotesPage, notesDirty = false }: UseDesktopViewWindowsOptions) {
  const { pushNav, removeNav, promoteNav } = navigation;
  const [windows, setWindows] = useState<DesktopWindowState[]>([]);
  const guardsRef = useRef(new Map<DesktopGuardTarget, PilotCloseGuard>());
  const closeAcceptedCallbacksRef = useRef(new Map<DesktopGuardTarget, PilotCloseAccepted>());
  const pendingGuardRef = useRef(new Map<DesktopGuardTarget, Promise<boolean>>());
  const pendingCloseRef = useRef(new Map<DesktopPilotView, Promise<boolean>>());
  const windowsRef = useRef(windows);
  windowsRef.current = windows;

  const activate = useCallback((id: DesktopPilotView) => {
    setWindows((current) => {
      const match = current.find((entry) => entry.id === id);
      if (!match) return current;
      const next = [...current.filter((entry) => entry.id !== id), { ...match, raiseToFrontSignal: match.raiseToFrontSignal + 1 }];
      windowsRef.current = next;
      return next;
    });
    promoteNav(`fusion-window:${id}`);
  }, [promoteNav]);

  const closeAccepted = useCallback((id: DesktopPilotView, preserveHistoryPosition = false) => {
    setWindows((current) => {
      const next = current.filter((entry) => entry.id !== id);
      windowsRef.current = next;
      return next;
    });
    removeNav(`fusion-window:${id}`, { preserveHistoryPosition });
  }, [removeNav]);

  const requestGuardVerdict = useCallback((id: DesktopGuardTarget) => {
    const existing = pendingGuardRef.current.get(id);
    if (existing) return existing;
    const request = Promise.resolve(guardsRef.current.get(id)?.() ?? true)
      .finally(() => pendingGuardRef.current.delete(id));
    pendingGuardRef.current.set(id, request);
    return request;
  }, []);

  const commitAcceptedClose = useCallback((id: DesktopGuardTarget) => {
    closeAcceptedCallbacksRef.current.get(id)?.();
  }, []);

  const requestGuardedClose = useCallback((id: DesktopGuardTarget) => requestGuardVerdict(id).then((accepted) => {
    if (accepted) commitAcceptedClose(id);
    return accepted;
  }), [commitAcceptedClose, requestGuardVerdict]);

  const requestClose = useCallback((id: DesktopPilotView, options?: { preserveHistoryPosition?: boolean }) => {
    const existing = pendingCloseRef.current.get(id);
    if (existing) return existing;
    const request = requestGuardVerdict(id).then((accepted) => {
      if (accepted) {
        commitAcceptedClose(id);
        closeAccepted(id, options?.preserveHistoryPosition);
      }
      return accepted;
    }).finally(() => pendingCloseRef.current.delete(id));
    pendingCloseRef.current.set(id, request);
    return request;
  }, [closeAccepted, commitAcceptedClose, requestGuardVerdict]);

  const open = useCallback((id: DesktopPilotView) => {
    showBoard();
    if (windowsRef.current.some((entry) => entry.id === id)) {
      activate(id);
      return;
    }
    setWindows((current) => {
      const next = [...current, { id, raiseToFrontSignal: 0 }];
      windowsRef.current = next;
      return next;
    });
    pushNav({
      type: "modal",
      id: `fusion-window:${id}`,
      close: () => requestClose(id, { preserveHistoryPosition: true }),
    });
  }, [activate, pushNav, requestClose, showBoard]);

  const requestCloseAll = useCallback(async (isStillValid: () => boolean = () => true) => {
    const snapshot = [...windowsRef.current];
    const guardedIds = [...guardsRef.current.keys()].filter((id) => !snapshot.some((entry) => entry.id === id));
    /*
    FNXC:DesktopViewWindows 2026-09-11-20:29:
    Scope-changing callers need a two-phase close: resolve every user guard without mutating drafts, revalidate the scope synchronously, then commit draft disposal and window removal together. A stale automatic node fallback must therefore leave Notes and every window intact even when the user accepted the now-obsolete confirmation.
    */
    for (const id of [...snapshot.map((entry) => entry.id), ...guardedIds].reverse()) {
      if (!await requestGuardVerdict(id)) return false;
    }
    if (!isStillValid()) return false;
    for (const id of guardedIds) commitAcceptedClose(id);
    for (const entry of snapshot) {
      if (windowsRef.current.some((current) => current.id === entry.id)) {
        commitAcceptedClose(entry.id);
        closeAccepted(entry.id, true);
      }
    }
    return true;
  }, [closeAccepted, commitAcceptedClose, requestGuardVerdict]);

  const registerGuard = useCallback((id: DesktopGuardTarget, guard: PilotCloseGuard, onAccepted?: PilotCloseAccepted) => {
    guardsRef.current.set(id, guard);
    if (onAccepted) closeAcceptedCallbacksRef.current.set(id, onAccepted);
    return () => {
      if (guardsRef.current.get(id) === guard) guardsRef.current.delete(id);
      if (onAccepted && closeAcceptedCallbacksRef.current.get(id) === onAccepted) closeAcceptedCallbacksRef.current.delete(id);
    };
  }, []);

  const clearGuard = useCallback((id: DesktopGuardTarget) => {
    /*
    FNXC:DesktopRightDock 2026-09-11-22:22:
    A sticky inline Notes guard belongs only to the desktop dock incarnation. Responsive or feature-mode transitions must retire that closure before the standard Notes page becomes authoritative, otherwise a saved page draft can still be blocked or cleared by stale dock state.
    */
    guardsRef.current.delete(id);
    closeAcceptedCallbacksRef.current.delete(id);
    pendingGuardRef.current.delete(id);
  }, []);

  useEffect(() => {
    if (enabled) return;
    if (notesDirty) showNotesPage();
    for (const entry of windowsRef.current) closeAccepted(entry.id, true);
  }, [closeAccepted, enabled, notesDirty, showNotesPage]);

  useEffect(() => {
    for (const entry of windowsRef.current) closeAccepted(entry.id, true);
    guardsRef.current.clear();
    closeAcceptedCallbacksRef.current.clear();
  }, [projectId, closeAccepted]);

  return useMemo(() => ({
    windows,
    topmost: windows.at(-1)?.id ?? null,
    open,
    activate,
    requestClose,
    requestGuardedClose,
    requestCloseAll,
    registerGuard,
    clearGuard,
  }), [activate, clearGuard, open, registerGuard, requestClose, requestGuardedClose, requestCloseAll, windows]);
}
