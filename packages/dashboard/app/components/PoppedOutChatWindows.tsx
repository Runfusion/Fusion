/*
FNXC:ChatWindows 2026-08-21-18:24:
FN-116 renders every secondary Direct conversation as its own persistent FloatingWindow.
These windows deliberately omit outside dismissal so working in one cannot collapse another.

FNXC:ChatWindows 2026-08-23-03:33:
FN-169 forwards each entry's focus nonce to the shared window and ChatView: every open raises the
existing window and arrives on its requested thread without remounting an in-flight conversation.

FNXC:ChatWindows 2026-09-02-05:24:
A minimized chat window must retain its component identity and geometry rather than unmounting, while releasing read-acknowledgement and document Find ownership until it is visible again.
*/
import { Suspense } from "react";
import type { ChatSessionInfo } from "../hooks/useChat";
import type { PoppedOutChatEntry } from "../hooks/usePoppedOutChats";
import { ChatView, type ChatViewProps } from "./ChatView";
import { FloatingWindow } from "./FloatingWindow";

export interface QuickChatWindowProps extends Pick<ChatViewProps,
  | "addToast"
  | "experimentalFeatures"
  | "initialComposerDraft"
  | "initialComposerDraftNonce"
  | "onSendAsReport"
  | "onOpenSessionInNewWindow"
  | "onMaximize"
> {
  projectId: string;
  hidden: boolean;
  closeOnOutsidePointerDown: boolean;
  onClose: () => void;
}

/*
FNXC:AlphaChatHosts 2026-09-10-19:40:
Quick Chat exposes its production window host as a component so integration tests exercise the real FloatingWindow, ChatView, homemade Alpha controls, and portals together instead of proving only that App forwarded the Alpha flag to a mocked child. It shares the task-detail interaction layer, suspends persisted desktop geometry for mobile and short full-screen sheets, and retains the narrow resizable desktop contract.
*/
export function QuickChatWindow({
  projectId,
  hidden,
  closeOnOutsidePointerDown,
  onClose,
  ...chatProps
}: QuickChatWindowProps) {
  return (
    <FloatingWindow
      windowKey="chat-modal"
      hidden={hidden}
      title="Chat"
      onClose={onClose}
      closeOnOutsidePointerDown={closeOnOutsidePointerDown}
      hideHeader
      dragHandleSelector=".chat-view--floating .view-header"
      className="floating-window--chat"
      layer="task-detail"
      suspendGeometryPersistenceOnMobile
      suspendGeometryPersistenceOnShortViewport
      persistGeometryKey="kb-dashboard-chat-floating-window"
      defaultSize={{ width: 980, height: 680 }}
      minSize={{ width: 300, height: 420 }}
    >
      <Suspense fallback={null}>
        <ChatView
          {...chatProps}
          projectId={projectId}
          floating
          findActive={!hidden}
          active={!hidden}
          onClose={onClose}
        />
      </Suspense>
    </FloatingWindow>
  );
}

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
  FNXC:ChatWindows 2026-08-23-04:29:
  Slot zero still offsets by one step because Quick Chat owns the un-cascaded shared base.
  This makes every secondary chat visibly sit above the surface beneath it.
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
      cascadeOffsetIndex={entry.cascadeSlot + 1}
      defaultSize={{ width: 980, height: 680 }}
      minSize={{ width: 300, height: 420 }}
      ariaLabel={entry.session.title || "Chat"}
      raiseToFrontSignal={entry.focusNonce}
      hidden={entry.minimized}
    >
      <Suspense fallback={null}>
        <ChatView
          projectId={projectId}
          addToast={addToast}
          experimentalFeatures={experimentalFeatures}
          floating
          active={!entry.minimized}
          findActive={!entry.minimized}
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
