import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Pin } from "lucide-react";
import type { ChatSessionInfo } from "../hooks/useChat";
import "./ChatThreadTitleSwitcher.css";

export const CHAT_TITLE_SWITCHER_MAX_ITEMS = 12;

export interface ChatThreadTitleSwitcherProps {
  title: string;
  sessions: ChatSessionInfo[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onViewAll: () => void;
  isUnread?: (session: ChatSessionInfo) => boolean;
  maxItems?: number;
}

/*
FNXC:ChatTitleSwitcher 2026-08-23-03:13:
FN-9192 makes the Direct thread title own conversation switching because every ChatView host hides
its conversation list while detail is open. Retain the chat-thread-header-title class and title
attribute on the trigger so the established header tooltip and ellipsis-truncation contract remains
unchanged while the title becomes interactive.
*/
export function ChatThreadTitleSwitcher({
  title,
  sessions,
  activeSessionId,
  onSelect,
  onViewAll,
  isUnread,
  maxItems = CHAT_TITLE_SWITCHER_MAX_ITEMS,
}: ChatThreadTitleSwitcherProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousActiveSessionId = useRef(activeSessionId);
  const initialCappedSessions = sessions.slice(0, maxItems);
  // FNXC:ChatTitleSwitcher 2026-08-23-03:13: Keep the current thread visible even when it is older than the recency cap.
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const cappedSessions = activeSession && !initialCappedSessions.some((session) => session.id === activeSession.id)
    ? [...initialCappedSessions.slice(0, -1), activeSession]
    : initialCappedSessions;
  const hasOtherSessions = cappedSessions.some((session) => session.id !== activeSessionId);
  const displayedSessions = hasOtherSessions ? cappedSessions : [];

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const handleOutsidePress = (event: PointerEvent | TouchEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) close();
    };
    document.addEventListener("pointerdown", handleOutsidePress);
    document.addEventListener("touchstart", handleOutsidePress);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePress);
      document.removeEventListener("touchstart", handleOutsidePress);
    };
  }, [open]);

  useEffect(() => {
    if (previousActiveSessionId.current !== activeSessionId) {
      previousActiveSessionId.current = activeSessionId;
      close();
    }
  }, [activeSessionId]);

  const selectSession = (sessionId: string) => {
    close();
    onSelect(sessionId);
  };

  const viewAll = () => {
    close();
    onViewAll();
  };

  const focusItem = (index: number) => {
    itemRefs.current[index]?.focus();
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      close(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    setOpen(true);
    requestAnimationFrame(() => focusItem(event.key === "ArrowDown" ? 0 : displayedSessions.length - 1));
  };

  const handleMenuItemKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, sessionId: string) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown"
        ? (index + 1) % displayedSessions.length
        : (index - 1 + displayedSessions.length) % displayedSessions.length;
      focusItem(nextIndex);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSession(sessionId);
    }
  };

  return (
    <div className="chat-thread-title-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="chat-thread-header-title chat-thread-title-trigger"
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("chat.switchConversation", "Switch conversation")}
        data-testid="chat-thread-title-trigger"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className="chat-thread-title-text">{title}</span>
        <ChevronDown size={14} className="chat-thread-title-caret" aria-hidden="true" />
      </button>

      {open ? (
        <div className="chat-thread-title-menu" role="menu" data-testid="chat-thread-title-menu">
          {displayedSessions.length === 0 ? (
            <div className="chat-thread-title-menu-empty" data-testid="chat-thread-title-menu-empty">
              {t("chat.noOtherConversations", "No other conversations")}
            </div>
          ) : displayedSessions.map((session, index) => {
            const label = session.title?.trim() || t("chat.untitledConversation", "Untitled conversation");
            const active = session.id === activeSessionId;
            return (
              <button
                key={session.id}
                ref={(element) => { itemRefs.current[index] = element; }}
                type="button"
                role="menuitem"
                className={`chat-thread-title-menu-item${active ? " chat-thread-title-menu-item--active" : ""}`}
                data-testid={`chat-thread-title-menu-item-${session.id}`}
                aria-current={active ? "true" : undefined}
                onClick={() => selectSession(session.id)}
                onKeyDown={(event) => handleMenuItemKeyDown(event, index, session.id)}
              >
                <span className="chat-thread-title-menu-label">{label}</span>
                {session.pinnedAt ? <Pin size={14} className="chat-thread-title-menu-pin" aria-label={t("chat.pinned", "Pinned")} /> : null}
                {isUnread?.(session) ? <span className="status-dot" aria-label={t("chat.unread", "Unread")} /> : null}
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            className="chat-thread-title-menu-all"
            data-testid="chat-thread-title-menu-all"
            onClick={viewAll}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close(true);
              } else if (event.key === "Tab") {
                close();
              }
            }}
          >
            {t("chat.allConversations", "All conversations")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
