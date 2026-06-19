import "./SelectionCommentPopover.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquarePlus } from "lucide-react";
import type { SelectionCommentLineRange } from "../hooks/useSelectionComment";

interface SelectionCommentPopoverProps {
  selectedText: string;
  anchorRect: DOMRect | null;
  filePath?: string;
  lineRange?: SelectionCommentLineRange;
  onSubmit: (description: string) => void;
  onCancel?: () => void;
  onOpenChange?: (open: boolean) => void;
}

function buildFence(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return fence;
}

export function composeSelectionCommentDescription({
  filePath,
  selectedText,
  comment,
  lineRange,
}: {
  filePath?: string;
  selectedText: string;
  comment: string;
  lineRange?: SelectionCommentLineRange;
}): string {
  const normalizedSnippet = selectedText.trim();
  const normalizedComment = comment.trim();
  const fence = buildFence(normalizedSnippet);
  const lines = lineRange ? [`Lines: ${lineRange.start === lineRange.end ? lineRange.start : `${lineRange.start}-${lineRange.end}`}`, ""] : [];

  return [
    `File: ${filePath?.trim() || "Unknown file"}`,
    ...lines,
    "Selected snippet:",
    `${fence}text`,
    normalizedSnippet,
    fence,
    "",
    "Comment:",
    normalizedComment,
  ].join("\n");
}

/**
 * FNXC:SelectionComment 2026-06-16-23:56:
 * The selected text affordance is intentionally stateless beyond a short comment: it formats file path, optional line range, snippet, and user note into a New Task description instead of adding a persistent review/comment model.
 */
export function SelectionCommentPopover({
  selectedText,
  anchorRect,
  filePath,
  lineRange,
  onSubmit,
  onCancel,
  onOpenChange,
}: SelectionCommentPopoverProps) {
  const { t } = useTranslation("app");
  const [expanded, setExpanded] = useState(false);
  const [comment, setComment] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const trimmedSelectedText = selectedText.trim();
  const style = useMemo(() => {
    if (!anchorRect) return undefined;
    return {
      "--selection-comment-left": `${anchorRect.left + anchorRect.width / 2}px`,
      "--selection-comment-top": `${anchorRect.bottom}px`,
    } as CSSProperties;
  }, [anchorRect]);

  useEffect(() => {
    setExpanded(false);
    setComment("");
    onOpenChange?.(false);
  }, [onOpenChange, trimmedSelectedText]);

  useEffect(() => {
    if (!expanded) return;
    textareaRef.current?.focus();
  }, [expanded]);

  const setPanelExpanded = useCallback((open: boolean) => {
    setExpanded(open);
    onOpenChange?.(open);
  }, [onOpenChange]);

  const handleCancel = useCallback(() => {
    setPanelExpanded(false);
    setComment("");
    onCancel?.();
  }, [onCancel, setPanelExpanded]);

  useEffect(() => {
    if (!expanded) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        handleCancel();
      }
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        handleCancel();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [expanded, handleCancel]);

  const handleSubmit = useCallback(() => {
    const description = composeSelectionCommentDescription({
      filePath,
      selectedText: trimmedSelectedText,
      comment,
      lineRange,
    });
    onSubmit(description);
    setPanelExpanded(false);
    setComment("");
  }, [comment, filePath, lineRange, onSubmit, setPanelExpanded, trimmedSelectedText]);

  if (!style || !trimmedSelectedText) {
    return null;
  }

  if (!expanded) {
    return (
      <button
        type="button"
        className="btn btn-primary btn-sm selection-comment-trigger"
        style={style}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setPanelExpanded(true)}
        aria-label={t("selectionComment.addCommentAria", "Add a comment to the selected text and send it to a new task")}
      >
        <MessageSquarePlus size={14} />
        {t("selectionComment.addComment", "Add comment")}
      </button>
    );
  }

  return (
    <div ref={rootRef} className="card selection-comment-panel" style={style} role="dialog" aria-label={t("selectionComment.dialogAria", "Comment on selected text")}> 
      <p className="selection-comment-title">{t("selectionComment.title", "Comment on selection")}</p>
      <pre className="selection-comment-snippet" aria-label={t("selectionComment.selectedSnippet", "Selected snippet")}>{trimmedSelectedText}</pre>
      <textarea
        ref={textareaRef}
        className="input selection-comment-textarea"
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={t("selectionComment.commentPlaceholder", "Describe the task this snippet should become…")}
        aria-label={t("selectionComment.commentAria", "Comment for the new task")}
      />
      <div className="selection-comment-actions">
        <button type="button" className="btn btn-sm" onClick={handleCancel}>
          {t("selectionComment.cancel", "Cancel")}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSubmit} disabled={!comment.trim()}>
          {t("selectionComment.sendToNewTask", "Send to new task")}
        </button>
      </div>
    </div>
  );
}
