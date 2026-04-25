import "./SpecEditor.css";
import { useState, useCallback, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface SpecEditorProps {
  content: string;
  readOnly?: boolean;
  onSave?: (content: string) => Promise<void>;
  onRequestRevision?: (feedback: string) => Promise<void>;
  isSaving?: boolean;
  isRequesting?: boolean;
}

export function SpecEditor({
  content,
  readOnly = false,
  onSave,
  onRequestRevision,
  isSaving = false,
  isRequesting = false,
}: SpecEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [feedback, setFeedback] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  // Update edit content when external content changes (only when not editing)
  useEffect(() => {
    if (!isEditing) {
      setEditContent(content);
    }
  }, [content, isEditing]);

  const hasChanges = editContent !== content;
  const canSave = isEditing && hasChanges && !isSaving && onSave;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    await onSave(editContent);
    setIsEditing(false);
  }, [canSave, onSave, editContent]);

  const handleRequestRevision = useCallback(async () => {
    if (!onRequestRevision || !feedback.trim() || isRequesting) return;
    await onRequestRevision(feedback.trim());
    setFeedback("");
  }, [onRequestRevision, feedback, isRequesting]);

  // Keyboard shortcut: Ctrl/Cmd+Enter to save in edit mode, Escape to cancel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditing && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (canSave) {
          void handleSave();
        }
      } else if (isEditing && e.key === "Escape") {
        e.preventDefault();
        handleCancelEdit();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isEditing, canSave, handleSave]);

  const handleEnterEditMode = () => {
    setIsEditing(true);
    setEditContent(content);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditContent(content);
  };

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    if (!readOnly && !isEditing) {
      e.stopPropagation();
      handleEnterEditMode();
    }
  }, [readOnly, isEditing, content]);

  const stripLeadingHeading = (text: string): string => {
    return text.replace(/^#\s+[^\n]*\n+/, "");
  };

  return (
    <div className="spec-editor">
      {/* Toolbar */}
      <div className="spec-editor-toolbar">
        <div className="spec-editor-mode-toggle">
          <button
            className={`btn btn-sm ${!isEditing ? "btn-primary" : ""}`}
            onClick={() => isEditing ? handleCancelEdit() : undefined}
            disabled={!isEditing}
          >
            View
          </button>
          {!readOnly && (
            <button
              className={`btn btn-sm ${isEditing ? "btn-primary" : ""}`}
              onClick={handleEnterEditMode}
              disabled={isEditing}
            >
              Edit
            </button>
          )}
        </div>
        {isEditing && (
          <div className="spec-editor-actions">
            <button
              className="btn btn-sm"
              onClick={handleCancelEdit}
              disabled={isSaving}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleSave()}
              disabled={!canSave}
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>

      {/* Content Area */}
      <div className="spec-editor-content">
        {isEditing ? (
          <textarea
            ref={textareaRef}
            className="spec-editor-textarea"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            disabled={isSaving}
            placeholder="Enter task specification in Markdown..."
          />
        ) : content ? (
          <div className="markdown-body" onDoubleClick={handleDoubleClick}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {stripLeadingHeading(content)}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="spec-editor-empty">(no specification)</div>
        )}
      </div>

      {/* Keyboard hint for edit mode */}
      {isEditing && (
        <div className="spec-editor-hint">
          Press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (or <kbd>Cmd</kbd>+<kbd>Enter</kbd>) to save
        </div>
      )}

      {/* AI Revision Section */}
      {!readOnly && onRequestRevision && (
        <div className="spec-editor-revision">
          <h4>Ask AI to Revise</h4>
          <p className="spec-editor-revision-help">
            Provide feedback for the AI to improve this specification. The task will move to triage for re-specification.
          </p>
          <textarea
            ref={feedbackRef}
            className="spec-editor-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="e.g., 'Add more details about error handling', 'Split this into smaller steps', 'Include tests for the API endpoints'..."
            disabled={isRequesting}
            rows={4}
            maxLength={2000}
          />
          <div className="spec-editor-revision-actions">
            <span className="spec-editor-char-count">
              {feedback.length}/2000
            </span>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleRequestRevision()}
              disabled={!feedback.trim() || isRequesting}
            >
              {isRequesting ? "Requesting…" : "Request AI Revision"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
