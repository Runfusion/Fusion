import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Target } from "lucide-react";
import { updateChatSession } from "../api";
import "./ChatFocusSelector.css";

/*
FNXC:ChatMemoryFocusSelector 2026-08-13:
Port (RUFU-068): per-conversation memory FOCUS selector reused by every chat composer host
(TaskPlannerChatTab, ChatView). The conversation topic is persisted on
chat_sessions.memory_focus via PATCH /api/chat/sessions/:id (which normalizes
empty -> null and bumps updatedAt) so it survives reconnect. Recall is then
scoped to that topic as a WITHIN-project read filter
(searchProjectMemory -> backend.search -> Stash REST topic param) NEVER a
client-side / post-query in-memory filter, and cross-project A/B isolation is
never weakened. A null/absent focus shows a cleared state (a "focus" chip to
set one), never a dangling chip, and an empty value or "all"/"*" collapses to
whole-project scope. Capture stays write-anywhere and topic-agnostic.
*/

export interface ChatFocusSelectorProps {
  /** The chat session whose memory_focus this control edits. null/undefined hides the control. */
  sessionId: string | null;
  /** Optional project scope forwarded to the session-update API call. */
  projectId?: string;
  /** The session's current focus topic; null means whole-project scope. */
  memoryFocus: string | null;
  /** Host callback to reflect the persisted focus in its local session state. */
  onPersist: (focus: string | null) => void;
  addToast: (message: string, type?: "success" | "error" | "warning") => void;
  disabled?: boolean;
}

/** True only for the bracket that surfaces whole-project scope back to the operator. */
function isWholeProjectCollapse(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return trimmed === "" || trimmed === "all" || trimmed === "*";
}

export function ChatFocusSelector({
  sessionId,
  projectId,
  memoryFocus,
  onPersist,
  addToast,
  disabled = false,
}: ChatFocusSelectorProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const normalizedFocus = memoryFocus && memoryFocus.trim() ? memoryFocus : null;
  const focusedTopic = normalizedFocus && !isWholeProjectCollapse(normalizedFocus) ? normalizedFocus : null;

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // When the session/focus changes out from under us (e.g. the active session
  // switched), close the popover and reset the draft so it never leaks the
  // previous session's topic or an unconsumed draft.
  useEffect(() => {
    setOpen(false);
    setDraft("");
  }, [normalizedFocus]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const setActiveFocus = (next: string | null) => {
    onPersist(next);
    setOpen(false);
    setDraft("");
  };

  const persistFocus = async (topic: string | null) => {
    if (!sessionId) return;
    setSaving(true);
    try {
      await updateChatSession(sessionId, { memoryFocus: topic }, projectId);
      setActiveFocus(topic);
      addToast(
        topic ? t("chat.focusSetToast", "Memory focus set to {{topic}}", { topic }) : t("chat.focusClearedToast", "Memory focus cleared"),
        "success",
      );
    } catch (error) {
      const message = error instanceof Error && error.message.trim() ? error.message : t("chat.focusFailedToast", "Failed to update memory focus");
      addToast(message, "error");
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      return void persistFocus(null);
    }
    return void persistFocus(trimmed);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      setDraft("");
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      saveDraft();
    }
  };

  const hasTopic = focusedTopic !== null;

  return (
    <div className="chat-focus-root" ref={rootRef} data-testid="chat-focus-root">
      <button
        type="button"
        className={`chat-focus-chip${hasTopic ? " chat-focus-chip--active" : ""}`}
        data-testid="chat-focus-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("chat.focusButton", "Memory focus topic")}
        title={hasTopic ? t("chat.focusTitleTopic", "Memory focus: {{topic}}", { topic: focusedTopic }) : t("chat.focusTitleNone", "Set memory focus topic (whole-project scope)")}
        disabled={disabled || !sessionId}
        onClick={() => {
          setDraft(focusedTopic ?? "");
          setOpen((value) => !value);
        }}
      >
        <Target size={14} aria-hidden="true" />
        {hasTopic ? (
          <span className="chat-focus-chip-topic">{focusedTopic}</span>
        ) : (
          <span className="chat-focus-chip-label">{t("chat.focusNone", "Focus")}</span>
        )}
      </button>

      {open && sessionId ? (
        <div className="chat-focus-popover" role="dialog" data-testid="chat-focus-popover">
          <div className="chat-focus-title">{t("chat.focusTitleDialog", "Memory focus topic")}</div>
          <p className="chat-focus-help">
            {t("chat.focusHelp", "Scopes this conversation's memory recall to a topic. Leave empty or use 'all' for whole-project scope.")}
          </p>
          <input
            ref={inputRef}
            className="input chat-focus-input"
            data-testid="chat-focus-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.focusPlaceholder", "topic (or 'all' to clear)")}
            aria-label={t("chat.focusInputLabel", "A memory focus topic")}
            disabled={saving}
          />
          <div className="chat-focus-actions">
            <button
              type="button"
              className="btn btn-primary chat-focus-save"
              data-testid="chat-focus-save"
              onClick={saveDraft}
              disabled={saving}
            >
              {saving ? t("chat.focusSaving", "Saving…") : t("chat.focusSave", "Set focus")}
            </button>
            {hasTopic ? (
              <button
                type="button"
                className="btn btn-ghost chat-focus-clear"
                data-testid="chat-focus-clear"
                onClick={() => persistFocus(null)}
                disabled={saving}
              >
                {t("chat.focusClear", "Clear to whole-project")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}