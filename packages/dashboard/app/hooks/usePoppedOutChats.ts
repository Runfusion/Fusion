/*
FNXC:ChatWindows 2026-08-21-18:24:
FN-116 keeps secondary Quick Chats in App memory and keys them by project and session.
Reopening a conversation refreshes its snapshot without cloning its independent window.

FNXC:ChatWindows 2026-08-23-03:33:
FN-169 requires refreshed entries to signal focus because their FloatingWindow remains mounted.
A monotonically increasing nonce re-raises the existing window without reordering the Escape stack.
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
}

export interface UsePoppedOutChatsResult {
  entries: PoppedOutChatEntry[];
  popOut: (projectId: string, session: ChatSessionInfo) => void;
  close: (projectId: string, sessionId: string) => void;
  closeAll: () => void;
}

export function usePoppedOutChats(): UsePoppedOutChatsResult {
  const [entries, setEntries] = useState<PoppedOutChatEntry[]>([]);

  const popOut = useCallback((projectId: string, session: ChatSessionInfo) => {
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
        return [...current, { projectId, session, focusNonce: 1, cascadeSlot }];
      }
      const refreshed = [...current];
      const previous = refreshed[index];
      refreshed[index] = { projectId, session, focusNonce: previous.focusNonce + 1, cascadeSlot: previous.cascadeSlot };
      return refreshed;
    });
  }, []);

  const close = useCallback((projectId: string, sessionId: string) => {
    setEntries((current) => current.filter((entry) => entry.projectId !== projectId || entry.session.id !== sessionId));
  }, []);

  const closeAll = useCallback(() => setEntries([]), []);

  return { entries, popOut, close, closeAll };
}
