import "./QuickChatFAB.css";
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare } from "lucide-react";

interface QuickChatFABProps {
  /** When false, the launcher is hidden. */
  showFAB?: boolean;
  /** When true, the full Chat modal is open; the launcher remains visible as the minimized entry point. */
  open?: boolean;
  /** Opens the full Chat modal. */
  onOpenChange?: (open: boolean) => void;
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
*/
export function QuickChatFAB({ showFAB = true, open = false, onOpenChange }: QuickChatFABProps) {
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

  const openChat = useCallback(() => {
    onOpenChange?.(true);
  }, [onOpenChange]);

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
      return;
    }
    openChat();
  }, [openChat]);

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    openChat();
  }, [openChat]);

  if (!showFAB) {
    return null;
  }

  return (
    <button
      type="button"
      className="quick-chat-fab"
      aria-label={t("chat.openQuickChat", "Open quick chat")}
      data-chat-open={open ? "true" : "false"}
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
