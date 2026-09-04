import "./QuickChatFAB.css";
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";
import type { ChatVisibilityToggleAction } from "../hooks/useChatVisibilityToggle";

interface QuickChatFABProps {
  /** When false, the launcher is hidden. */
  showFAB?: boolean;
  /** When true, the shared Quick Chat window is visible; retained for the launcher's state data attribute. */
  open?: boolean;
  /** Toggles the visibility of the complete floating chat set. */
  onToggle?: () => void;
  /** The action that the next activation will perform. */
  toggleAction?: ChatVisibilityToggleAction;
}

const DEFAULT_OFFSET = 24;
const EDGE_OFFSET = 0;
const MOVE_THRESHOLD = 4;

export function clampQuickChatFabOffset(value: number, size: number): number {
  if (typeof window === "undefined") return Math.max(EDGE_OFFSET, value);
  return Math.min(Math.max(EDGE_OFFSET, value), Math.max(EDGE_OFFSET, size - 48));
}

/*
FNXC:ChatLauncher 2026-06-22-13:18:
Quick Chat is no longer a separate compact chat implementation. The floating icon is only the minimized launcher for the full Chat modal, so all conversation UX, model/session handling, and message rendering live in ChatView. Keep the launcher draggable because users already position it around the dashboard, but do not mount any quick-chat panel or hook state here.

FNXC:ChatLauncher 2026-06-22-14:36:
The launcher must remain visible when Quick Chat is enabled or the full Chat modal has been minimized/opened from the launcher. Do not hide it based on modal-open state; the button is the persistent way back into the Chat modal.

FNXC:ChatLauncher 2026-06-22-15:01:
The draggable FAB should be placeable flush with every viewport edge. Clamp drag offsets to 0 instead of the default visual inset; the initial placement can remain inset for readability, but user placement owns the edge alignment.

FNXC:ChatLauncher 2026-09-02-05:24:
The launcher is a whole-chat-set visibility toggle rather than an open-only entry point, and its accessible name must describe whether it will open, minimize, or restore chats.

FNXC:ChatLauncher 2026-09-02-05:51:
Pointer release only finalizes drag state; the resulting click owns activation so a normal pointer sequence toggles exactly once while keyboard-generated clicks still work. A completed drag suppresses only its immediate follow-up click.
*/
export function QuickChatFAB({ showFAB = true, open = false, onToggle, toggleAction }: QuickChatFABProps) {
  const { t } = useTranslation("app");
  const [position, setPosition] = useState({ right: DEFAULT_OFFSET, bottom: DEFAULT_OFFSET });
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const toggleChat = useCallback(() => {
    onToggle?.();
  }, [onToggle]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRight: position.right,
      startBottom: position.bottom,
      moved: false,
    };
  }, [position.bottom, position.right]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    if (Math.abs(deltaX) > MOVE_THRESHOLD || Math.abs(deltaY) > MOVE_THRESHOLD) {
      dragState.moved = true;
    }
    setPosition({
      right: clampQuickChatFabOffset(dragState.startRight - deltaX, window.innerWidth),
      bottom: clampQuickChatFabOffset(dragState.startBottom - deltaY, window.innerHeight),
    });
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragStateRef.current = null;
    if (dragState.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  }, []);

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    toggleChat();
  }, [toggleChat]);

  if (!showFAB) {
    return null;
  }

  const accessibleLabel = toggleAction === "minimize-all"
    ? t("chat.minimizeAllChats", "Minimize all chats")
    : toggleAction === "restore-all"
      ? t("chat.restoreAllChats", "Restore all chats")
      : t("chat.openQuickChat", "Open quick chat");

  return (
    <button
      type="button"
      className="quick-chat-fab"
      aria-label={accessibleLabel}
      data-chat-open={open ? "true" : "false"}
      data-chat-toggle-action={toggleAction}
      data-testid="quick-chat-fab"
      style={{ right: position.right, bottom: position.bottom }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragStateRef.current = null;
      }}
      onClick={handleClick}
    >
      <MessageSquare size={24} />
    </button>
  );
}
