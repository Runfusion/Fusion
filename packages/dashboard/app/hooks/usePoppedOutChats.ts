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
  /*
  FNXC:ChatWindows 2026-09-14-23:48:
  FN-396: the session captured at open time is only the REQUEST that opened a window, never the durable identity of
  the conversation. Renaming a conversation used to leave the old title on an open window until the operator closed
  and reopened it, because popOut was the single writer of `entry.session`. syncSession replaces that snapshot in
  place from the live conversation, deliberately leaving focusNonce and composerPrefill untouched: advancing either
  would re-raise the window and reseed a draft the operator is typing.
  */
  syncSession: (projectId: string, session: ChatSessionInfo) => void;
  close: (projectId: string, sessionId: string) => void;
  closeAll: () => void;
}

/** Fields a detached window renders or keys on; an echo of these is not a state change. */
function sameRenderedIdentity(a: ChatSessionInfo, b: ChatSessionInfo): boolean {
  return a.id === b.id
    && (a.title ?? null) === (b.title ?? null)
    && a.updatedAt === b.updatedAt
    && a.status === b.status
    && a.agentId === b.agentId
    && (a.modelProvider ?? null) === (b.modelProvider ?? null)
    && (a.modelId ?? null) === (b.modelId ?? null)
    && (a.pinnedAt ?? null) === (b.pinnedAt ?? null);
}

export function usePoppedOutChats(): UsePoppedOutChatsResult {
  const [entries, setEntries] = useState<PoppedOutChatEntry[]>([]);

  const popOut = useCallback((projectId: string, session: ChatSessionInfo, options?: PoppedOutChatOpenOptions) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.projectId === projectId && entry.session.id === session.id);
      /*
      FNXC:ChatWindows 2026-09-14-21:10:
      FN-394 removed the chat-only cascade slot. Separation between freshly opened windows is now the
      shared dashboard window-manager cohort, identical for every window type, so Chat no longer owns a
      private placement rule. Deduplication, focus nonce, and composer prefill are unchanged.
      */
      if (index === -1) {
        return [...current, {
          projectId,
          session,
          focusNonce: 1,
          ...(options?.composerPrefill ? { composerPrefill: { text: options.composerPrefill, nonce: 1 } } : {}),
        }];
      }
      const refreshed = [...current];
      const previous = refreshed[index];
      refreshed[index] = {
        projectId,
        session,
        focusNonce: previous.focusNonce + 1,
        composerPrefill: options?.composerPrefill
          ? { text: options.composerPrefill, nonce: (previous.composerPrefill?.nonce ?? 0) + 1 }
          : previous.composerPrefill,
      };
      return refreshed;
    });
  }, []);

  const syncSession = useCallback((projectId: string, session: ChatSessionInfo) => {
    setEntries((current) => {
      const index = current.findIndex((entry) => entry.projectId === projectId && entry.session.id === session.id);
      if (index === -1 || sameRenderedIdentity(current[index].session, session)) return current;
      const refreshed = [...current];
      refreshed[index] = { ...refreshed[index], session };
      return refreshed;
    });
  }, []);

  const close = useCallback((projectId: string, sessionId: string) => {
    setEntries((current) => current.filter((entry) => entry.projectId !== projectId || entry.session.id !== sessionId));
  }, []);

  const closeAll = useCallback(() => setEntries([]), []);

  return { entries, popOut, syncSession, close, closeAll };
}
