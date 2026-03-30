import { useState, useCallback, useRef, useEffect } from "react";
import type { ToastType } from "../hooks/useToast";

interface QuickEntryBoxProps {
  onCreate?: (description: string) => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
}

export function QuickEntryBox({ onCreate, addToast }: QuickEntryBoxProps) {
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // If onCreate is not provided, the component is disabled
  const isDisabled = !onCreate;

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
      }
    };
  }, []);

  // Auto-resize textarea based on content
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get accurate scrollHeight
    textarea.style.height = "auto";
    // Set to scrollHeight (capped at max-height via CSS)
    const newHeight = Math.min(textarea.scrollHeight, 200);
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Resize when description changes
  useEffect(() => {
    if (isExpanded) {
      autoResize();
    }
  }, [description, isExpanded, autoResize]);

  // Restore focus after submission completes (when textarea is re-enabled)
  useEffect(() => {
    if (!isSubmitting && description === "" && textareaRef.current) {
      // Use setTimeout to ensure focus happens after React re-enables the textarea
      const focusTimeout = setTimeout(() => {
        textareaRef.current?.focus();
      }, 0);
      return () => clearTimeout(focusTimeout);
    }
  }, [isSubmitting, description]);

  const handleSubmit = useCallback(async () => {
    const trimmed = description.trim();
    if (!trimmed || isSubmitting || !onCreate) return;

    setIsSubmitting(true);
    try {
      await onCreate(trimmed);
      // Clear input for rapid entry
      setDescription("");
      // Reset height after clearing
      if (textareaRef.current) {
        textareaRef.current.style.height = "auto";
      }
      // Note: Focus restoration is handled by useEffect when isSubmitting becomes false
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
      // Keep input content on failure so user can retry
    } finally {
      setIsSubmitting(false);
    }
  }, [description, isSubmitting, onCreate, addToast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter") {
        if (e.shiftKey && isExpanded) {
          // Allow Shift+Enter to insert newline when expanded
          // Don't prevent default - let the newline be inserted
          return;
        }
        // Enter without Shift submits
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (description.trim()) {
          // Clear non-empty input on Escape
          setDescription("");
          // Reset height
          if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
          }
        }
        // Collapse on escape
        setIsExpanded(false);
        // Clear any pending blur timeout
        if (blurTimeoutRef.current) {
          clearTimeout(blurTimeoutRef.current);
          blurTimeoutRef.current = null;
        }
        textareaRef.current?.blur();
      }
    },
    [handleSubmit, description, isExpanded],
  );

  const handleFocus = useCallback(() => {
    setIsExpanded(true);
  }, []);

  const handleBlur = useCallback(() => {
    // Clear any existing timeout
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }

    // Collapse if empty (after a short delay to allow click events)
    blurTimeoutRef.current = setTimeout(() => {
      // Check current textarea value directly for most accurate state
      const currentValue = textareaRef.current?.value || "";
      if (!currentValue.trim()) {
        setIsExpanded(false);
        // Reset height when collapsing
        if (textareaRef.current) {
          textareaRef.current.style.height = "auto";
        }
      }
      blurTimeoutRef.current = null;
    }, 200);
  }, []);

  return (
    <div className="quick-entry-box" data-testid="quick-entry-box">
      <textarea
        ref={textareaRef}
        className={`quick-entry-input ${isExpanded ? "quick-entry-input--expanded" : ""}`}
        placeholder={isSubmitting ? "Creating..." : "Add a task..."}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        disabled={isSubmitting || isDisabled}
        data-testid="quick-entry-input"
        rows={1}
      />
    </div>
  );
}
