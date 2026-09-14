/*
FNXC:ChatWindows 2026-09-14-11:35:
Detached Direct conversations remain keyed by project and session. Reopening refreshes and focuses the same persistent FloatingWindow; global window visibility, rather than chat-only minimization, owns temporary presentation state.
*/
import { useCallback, useState } from "react";
import type { ChatSessionInfo } from "./useChat";

export interface PoppedOutChatEntry {
  projectId: string;
  session: ChatSessionInfo;
  /** Increments for every open request so an in-place window can reclaim its stack position. */
  focusNonce: number;
  /** Stable per-project cascade slot used to visibly separate stacked chat windows. */
  cascadeSlot: number;
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: an external composer prefill (task hand-off, GitHub import, card action) belongs to the ONE conversation the
  request opened or created, never to every open conversation. Its nonce advances only when a request actually carries
  new text, so an ordinary reopen never overwrites a draft the operator is typing.
  */
  composerPrefill?: { text: string; nonce: number };
}

export interface PoppedOutChatOpenOptions {
  composerPrefill?: string;
}

export interface UsePoppedOutChatsResult {
  entries: PoppedOutChatEntry[];
  popOut: (projectId: string, session: ChatSessionInfo, options?: PoppedOutChatOpenOptions) => void;
  close: (projectId: string, sessionId: string) => void;
  closeAll: () => void;
}

export function usePoppedOutChats(): UsePoppedOutChatsResult {
  const [entries, setEntries] = useState<PoppedOutChatEntry[]>([]);

  const popOut = useCallback((projectId: string, session: ChatSessionInfo, options?: PoppedOutChatOpenOptions) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.projectId === projectId && entry.session.id === session.id);
      /*
      FNXC:ChatWindows 2026-08-23-04:29:
      Allocate the first available slot within a project so secondary chat windows cascade predictably.
      Refreshing retains its slot and closing releases it for the next conversation.
      */
      if (index === -1) {
        const occupiedSlots = new Set(current.filter((entry) => entry.projectId === projectId).map((entry) => entry.cascadeSlot));
        const cascadeSlot = Array.from({ length: current.length + 1 }, (_, slot) => slot).find((slot) => !occupiedSlots.has(slot)) ?? current.length;
        return [...current, {
          projectId,
          session,
          focusNonce: 1,
          cascadeSlot,
          ...(options?.composerPrefill ? { composerPrefill: { text: options.composerPrefill, nonce: 1 } } : {}),
        }];
      }
      const refreshed = [...current];
      const previous = refreshed[index];
      refreshed[index] = {
        projectId,
        session,
        focusNonce: previous.focusNonce + 1,
        cascadeSlot: previous.cascadeSlot,
        composerPrefill: options?.composerPrefill
          ? { text: options.composerPrefill, nonce: (previous.composerPrefill?.nonce ?? 0) + 1 }
          : previous.composerPrefill,
      };
      return refreshed;
    });
  }, []);

  const close = useCallback((projectId: string, sessionId: string) => {
    setEntries((current) => current.filter((entry) => entry.projectId !== projectId || entry.session.id !== sessionId));
  }, []);

  const closeAll = useCallback(() => setEntries([]), []);

  return { entries, popOut, close, closeAll };
}
