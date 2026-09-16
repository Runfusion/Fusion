/*
FNXC:ChatWindows 2026-09-14-11:35:
Every detached Direct conversation owns one persistent FloatingWindow keyed by project/session. Reopening refreshes and raises that exact window; the global declarative registry now owns temporary hide/restore without chat-specific minimization.
*/
import { Suspense, type ComponentProps } from "react";
import type { ChatSessionInfo } from "../hooks/useChat";
import type { PoppedOutChatEntry } from "../hooks/usePoppedOutChats";
import { ChatView } from "./ChatView";
import {
  FLOATING_WINDOW_TASK_STANDARD_HEIGHT,
  FLOATING_WINDOW_TASK_STANDARD_WIDTH,
  FloatingWindow,
} from "./FloatingWindow";

export interface PoppedOutChatWindowsProps {
  entries: PoppedOutChatEntry[];
  projectId: string;
  addToast: (message: string, type?: "success" | "error" | "warning") => void;
  experimentalFeatures?: Record<string, boolean>;
  onClose: (projectId: string, sessionId: string) => void;
  onOpenSessionInNewWindow: (session: ChatSessionInfo) => void;
  /*
  FNXC:ChatSurfaceUnification 2026-09-14-17:46:
  FN-392: a detached conversation can hand its message to Mailbox like any other Chat host. Handing off closes only the
  primary dock host; the emitting window and every other conversation stay mounted with their streams intact.
  */
  onSendAsReport?: ComponentProps<typeof ChatView>["onSendAsReport"];
  /*
  FNXC:ChatWindows 2026-09-14-23:48:
  FN-396: the hosted conversation owns its own identity. A rename (dialog or `chat:session:updated` event) reaches
  the window header and its accessible name through this callback, so the window never has to be closed and reopened
  to show the current title.
  */
  onSessionSynced?: (projectId: string, session: ChatSessionInfo) => void;
}

export function PoppedOutChatWindows({ entries, projectId, addToast, experimentalFeatures, onClose, onOpenSessionInNewWindow, onSendAsReport, onSessionSynced }: PoppedOutChatWindowsProps) {
  /*
  FNXC:ChatWindows 2026-09-16-18:31:
  FN-469: the operator asked for bottom docking "aussi pour les chats". A detached conversation gains it with NO chat
  specific geometry: it is already a `FloatingWindow`, and the bottom band lives in the shared snap contract
  (`floatingWindowGeometry`), so dragging its bottom edge onto the work area's bottom wall docks it full width over
  the lower half, and one drag past the click threshold releases it in any direction. The narrow `minSize` below does
  not fight the band either: a snapped rectangle is applied as-is and `.floating-window--snapped` neutralizes the CSS
  minimums. Do not add a chat-owned bottom panel here; that would fork the geometry the shared contract now owns.

  FNXC:ChatWindows 2026-09-14-22:36:
  FN-394 removed Chat's own cascade bookkeeping and its durable geometry. Every detached conversation opens at the standard Chat size, centred, and the shared window manager decides whether an untouched neighbour earns one cascade offset — the same rule as every other dashboard window.
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
      /* FNXC:ChatWindows 2026-09-15-04:01: FN-401 — a detached conversation opens at exactly the task-window standard size; the narrower minSize keeps it usable inside a half-width snap column. */
      defaultSize={{ width: FLOATING_WINDOW_TASK_STANDARD_WIDTH, height: FLOATING_WINDOW_TASK_STANDARD_HEIGHT }}
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
          initialComposerDraft={entry.composerPrefill?.text}
          initialComposerDraftNonce={entry.composerPrefill?.nonce}
          onOpenSessionInNewWindow={onOpenSessionInNewWindow}
          onActiveSessionChange={(session) => onSessionSynced?.(entry.projectId, session)}
          onSendAsReport={onSendAsReport}
          onClose={() => onClose(entry.projectId, entry.session.id)}
        />
      </Suspense>
    </FloatingWindow>
  ));
}
