import { useState, useCallback, useRef } from "react";
import type { ToastType } from "../hooks/useToast";

interface QuickEntryBoxProps {
  onCreate: (description: string) => Promise<void>;
  addToast: (message: string, type?: ToastType) => void;
}

export function QuickEntryBox({ onCreate, addToast }: QuickEntryBoxProps) {
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async () => {
    const trimmed = description.trim();
    if (!trimmed || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onCreate(trimmed);
      // Clear input and keep focus for rapid entry
      setDescription("");
      // Focus stays on input for next entry
      inputRef.current?.focus();
    } catch (err: any) {
      addToast(err.message || "Failed to create task", "error");
      // Keep input content on failure so user can retry
    } finally {
      setIsSubmitting(false);
    }
  }, [description, isSubmitting, onCreate, addToast]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (description.trim()) {
          // Clear non-empty input on Escape
          setDescription("");
        }
      }
    },
    [handleSubmit, description],
  );

  return (
    <div className="quick-entry-box" data-testid="quick-entry-box">
      <input
        ref={inputRef}
        type="text"
        className="quick-entry-input"
        placeholder={isSubmitting ? "Creating..." : "Add a task..."}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={isSubmitting}
        data-testid="quick-entry-input"
      />
    </div>
  );
}
