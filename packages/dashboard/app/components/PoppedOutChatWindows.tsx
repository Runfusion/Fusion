/*
FNXC:ChatWindows 2026-09-14-11:35:
Every detached Direct conversation owns one persistent FloatingWindow keyed by project/session. Reopening refreshes and raises that exact window; the global declarative registry now owns temporary hide/restore without chat-specific minimization.
*/
import { Suspense } from "react";
import type { ChatSessionInfo } from "../hooks/useChat";
import type { PoppedOutChatEntry } from "../hooks/usePoppedOutChats";
import { ChatView } from "./ChatView";
import { FloatingWindow } from "./FloatingWindow";

export interface PoppedOutChatWindowsProps {
  entries: PoppedOutChatEntry[];
  projectId: string;
  addToast: (message: string, type?: "success" | "error" | "warning") => void;
  experimentalFeatures?: Record<string, boolean>;
  onClose: (projectId: string, sessionId: string) => void;
  onOpenSessionInNewWindow: (session: ChatSessionInfo) => void;
}

export function PoppedOutChatWindows({ entries, projectId, addToast, experimentalFeatures, onClose, onOpenSessionInNewWindow }: PoppedOutChatWindowsProps) {
  /*
  FNXC:ChatWindows 2026-09-14-11:35:
  The first detached conversation owns cascade slot zero so its persisted base geometry is not given an invisible extra offset.
  */
  return entries.filter((entry) => entry.projectId === projectId).map((entry) => (
    <FloatingWindow
      key={`${entry.projectId}:${entry.session.id}`}
      windowKey={`chat-window-${entry.projectId}-${entry.session.id}`}
      title={entry.session.title || "Chat"}
      onClose={() => onClose(entry.projectId, entry.session.id)}
      hideHeader
      dragHandleSelector=".chat-view--floating .view-header"
      className="floating-window--chat"
      layer="task-detail"
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      persistGeometryKey="kb-dashboard-chat-floating-window"
      cascadeOffsetIndex={entry.cascadeSlot}
      defaultSize={{ width: 980, height: 680 }}
      minSize={{ width: 300, height: 420 }}
      ariaLabel={entry.session.title || "Chat"}
      raiseToFrontSignal={entry.focusNonce}
      surfaceGroup="chat"
    >
      <Suspense fallback={null}>
        <ChatView
          projectId={projectId}
          addToast={addToast}
          experimentalFeatures={experimentalFeatures}
          floating
          dedicatedConversation
          initialDirectSession={entry.session}
          initialDirectSessionNonce={entry.focusNonce}
          persistChatPreferences={false}
          onOpenSessionInNewWindow={onOpenSessionInNewWindow}
          onClose={() => onClose(entry.projectId, entry.session.id)}
        />
      </Suspense>
    </FloatingWindow>
  ));
}
