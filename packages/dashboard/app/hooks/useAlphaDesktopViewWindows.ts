import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UseNavigationHistoryResult } from "./useNavigationHistory";

export type AlphaDesktopPilotView = "patchnode";
export type AlphaDesktopGuardTarget = AlphaDesktopPilotView | "notes";
export type PilotCloseGuard = () => boolean | Promise<boolean>;
export type PilotCloseAccepted = () => void;

export interface AlphaDesktopWindowState {
  id: AlphaDesktopPilotView;
  raiseToFrontSignal: number;
}

interface UseAlphaDesktopViewWindowsOptions {
  enabled: boolean;
  projectId?: string;
  navigation: Pick<UseNavigationHistoryResult, "pushNav" | "removeNav" | "promoteNav">;
  showBoard: () => void;
  showNotesPage: () => void;
  notesDirty?: boolean;
}

/*
FNXC:AlphaDesktopWindows 2026-09-11-19:35:
Desktop Alpha keeps Board as the permanent main surface while History is the sole stable pilot window. Notes is inline in the right dock but registers with the same scope-exit guard registry, so its draft remains protected without retaining a second floating-window identity.
*/
export function useAlphaDesktopViewWindows({ enabled, projectId, navigation, showBoard, showNotesPage, notesDirty = false }: UseAlphaDesktopViewWindowsOptions) {
  const { pushNav, removeNav, promoteNav } = navigation;
  const [windows, setWindows] = useState<AlphaDesktopWindowState[]>([]);
  const guardsRef = useRef(new Map<AlphaDesktopGuardTarget, PilotCloseGuard>());
  const closeAcceptedCallbacksRef = useRef(new Map<AlphaDesktopGuardTarget, PilotCloseAccepted>());
  const pendingGuardRef = useRef(new Map<AlphaDesktopGuardTarget, Promise<boolean>>());
  const pendingCloseRef = useRef(new Map<AlphaDesktopPilotView, Promise<boolean>>());
  const windowsRef = useRef(windows);
  windowsRef.current = windows;

  const activate = useCallback((id: AlphaDesktopPilotView) => {
    setWindows((current) => {
      const match = current.find((entry) => entry.id === id);
      if (!match) return current;
      const next = [...current.filter((entry) => entry.id !== id), { ...match, raiseToFrontSignal: match.raiseToFrontSignal + 1 }];
      windowsRef.current = next;
      return next;
    });
    promoteNav(`alpha-pilot:${id}`);
  }, [promoteNav]);

  const closeAccepted = useCallback((id: AlphaDesktopPilotView, preserveHistoryPosition = false) => {
    setWindows((current) => {
      const next = current.filter((entry) => entry.id !== id);
      windowsRef.current = next;
      return next;
    });
    removeNav(`alpha-pilot:${id}`, { preserveHistoryPosition });
  }, [removeNav]);

  const requestGuardVerdict = useCallback((id: AlphaDesktopGuardTarget) => {
    const existing = pendingGuardRef.current.get(id);
    if (existing) return existing;
    const request = Promise.resolve(guardsRef.current.get(id)?.() ?? true)
      .finally(() => pendingGuardRef.current.delete(id));
    pendingGuardRef.current.set(id, request);
    return request;
  }, []);

  const commitAcceptedClose = useCallback((id: AlphaDesktopGuardTarget) => {
    closeAcceptedCallbacksRef.current.get(id)?.();
  }, []);

  const requestClose = useCallback((id: AlphaDesktopPilotView, options?: { preserveHistoryPosition?: boolean }) => {
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

  const open = useCallback((id: AlphaDesktopPilotView) => {
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
      id: `alpha-pilot:${id}`,
      close: () => requestClose(id, { preserveHistoryPosition: true }),
    });
  }, [activate, pushNav, requestClose, showBoard]);

  const requestCloseAll = useCallback(async (isStillValid: () => boolean = () => true) => {
    const snapshot = [...windowsRef.current];
    const guardedIds = [...guardsRef.current.keys()].filter((id) => !snapshot.some((entry) => entry.id === id));
    /*
    FNXC:AlphaDesktopWindows 2026-09-11-20:29:
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

  const registerGuard = useCallback((id: AlphaDesktopGuardTarget, guard: PilotCloseGuard, onAccepted?: PilotCloseAccepted) => {
    guardsRef.current.set(id, guard);
    if (onAccepted) closeAcceptedCallbacksRef.current.set(id, onAccepted);
    return () => {
      if (guardsRef.current.get(id) === guard) guardsRef.current.delete(id);
      if (onAccepted && closeAcceptedCallbacksRef.current.get(id) === onAccepted) closeAcceptedCallbacksRef.current.delete(id);
    };
  }, []);

  const clearGuard = useCallback((id: AlphaDesktopGuardTarget) => {
    /*
    FNXC:AlphaDesktopRightDock 2026-09-11-22:22:
    A sticky inline Notes guard belongs only to the Alpha desktop dock incarnation. Responsive or feature-mode transitions must retire that closure before the standard Notes page becomes authoritative, otherwise a saved page draft can still be blocked or cleared by stale dock state.
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
    requestCloseAll,
    registerGuard,
    clearGuard,
  }), [activate, clearGuard, open, registerGuard, requestClose, requestCloseAll, windows]);
}
