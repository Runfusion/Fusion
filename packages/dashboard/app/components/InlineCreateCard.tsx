import { useState, useCallback, useEffect, useRef } from "react";
import { Link } from "lucide-react";
import type { Task, TaskCreateInput } from "@hai/core";
import type { ToastType } from "../hooks/useToast";
import { uploadAttachment } from "../api";

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface PendingImage {
  file: File;
  previewUrl: string;
}

interface InlineCreateCardProps {
  tasks: Task[];
  onSubmit: (input: TaskCreateInput) => Promise<Task>;
  onCancel: () => void;
  addToast: (msg: string, type?: ToastType) => void;
}

export function InlineCreateCard({ tasks, onSubmit, onCancel, addToast }: InlineCreateCardProps) {
  const [description, setDescription] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [showDeps, setShowDeps] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cancel when focus leaves the card entirely and there's no content
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const handleFocusOut = (e: FocusEvent) => {
      // relatedTarget is the element receiving focus — if it's inside the card, ignore
      if (e.relatedTarget instanceof Node && card.contains(e.relatedTarget)) return;
      // Only cancel if empty
      if (description.trim() === "" && pendingImages.length === 0) {
        onCancel();
      }
    };
    card.addEventListener("focusout", handleFocusOut);
    return () => card.removeEventListener("focusout", handleFocusOut);
  }, [description, pendingImages, onCancel]);

  // Clean up object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only on unmount
  }, []);

  /**
   * Handles paste events on the textarea. Extracts image files from the
   * clipboard data, creates object URL previews, and appends them to
   * the pendingImages state. Non-image files are silently ignored.
   */
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (submitting) return;
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;

      const newImages: PendingImage[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (ALLOWED_IMAGE_TYPES.includes(file.type)) {
          newImages.push({ file, previewUrl: URL.createObjectURL(file) });
        }
      }
      if (newImages.length > 0) {
        setPendingImages((prev) => [...prev, ...newImages]);
      }
    },
    [submitting],
  );

  const removeImage = useCallback((index: number) => {
    setPendingImages((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!description.trim() || submitting) return;
        setSubmitting(true);
        try {
          const task = await onSubmit({
            description: description.trim(),
            column: "triage",
            dependencies: dependencies.length ? dependencies : undefined,
          });

          // Upload pending images as attachments
          if (pendingImages.length > 0) {
            const failures: string[] = [];
            for (const img of pendingImages) {
              try {
                await uploadAttachment(task.id, img.file);
              } catch {
                failures.push(img.file.name);
              }
            }
            if (failures.length > 0) {
              addToast(`Failed to upload: ${failures.join(", ")}`, "error");
            }
          }

          // Clean up preview URLs
          pendingImages.forEach((img) => URL.revokeObjectURL(img.previewUrl));
          setPendingImages([]);

          addToast(`Created ${task.id}`, "success");
        } catch (err: any) {
          addToast(err.message, "error");
        } finally {
          setSubmitting(false);
        }
      }
    },
    [description, dependencies, submitting, pendingImages, onSubmit, onCancel, addToast],
  );

  const toggleDep = useCallback((id: string) => {
    setDependencies((prev) =>
      prev.includes(id) ? prev.filter((d) => d !== id) : [...prev, id],
    );
  }, []);

  const truncate = (s: string, len: number) =>
    s.length > len ? s.slice(0, len) + "…" : s;

  return (
    <div className="inline-create-card" ref={cardRef}>
      <textarea
        ref={inputRef}
        rows={1}
        className="inline-create-input"
        placeholder="What needs to be done?"
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
          const el = e.target;
          el.style.height = "auto";
          el.style.height = el.scrollHeight + "px";
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        disabled={submitting}
      />
      {pendingImages.length > 0 && (
        <div className="inline-create-previews">
          {pendingImages.map((img, i) => (
            <div key={img.previewUrl} className="inline-create-preview">
              <img src={img.previewUrl} alt={img.file.name} />
              <button
                type="button"
                className="inline-create-preview-remove"
                onClick={() => removeImage(i)}
                disabled={submitting}
                title="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="inline-create-footer">
        <div className="dep-trigger-wrap">
          <button
            type="button"
            className="btn btn-sm dep-trigger"
            onClick={() => setShowDeps((v) => !v)}
          >
            <Link size={12} style={{ verticalAlign: 'middle' }} />{dependencies.length > 0 ? ` ${dependencies.length} deps` : " Deps"}
          </button>
          {showDeps && (
            <div className="dep-dropdown">
              {tasks.length === 0 ? (
                <div className="dep-dropdown-empty">No existing tasks</div>
              ) : (
                tasks.map((t) => (
                  <div
                    key={t.id}
                    className={`dep-dropdown-item${dependencies.includes(t.id) ? " selected" : ""}`}
                    onClick={() => toggleDep(t.id)}
                  >
                    <span className="dep-dropdown-id">{t.id}</span>
                    <span className="dep-dropdown-title">{truncate(t.title || t.description || t.id, 30)}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        <span className="inline-create-hint">Enter to create · Esc to cancel</span>
      </div>
    </div>
  );
}
