import { useState, useCallback, useEffect, useRef } from "react";
import type { Task, TaskCreateInput } from "@hai/core";
import type { ToastType } from "../hooks/useToast";

interface CreateTaskModalProps {
  onClose: () => void;
  onCreateTask: (input: TaskCreateInput) => Promise<Task>;
  addToast: (message: string, type?: ToastType) => void;
}

export function CreateTaskModal({ onClose, onCreateTask, addToast }: CreateTaskModalProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [deps, setDeps] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => titleRef.current?.focus(), 100);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedTitle = title.trim();
      if (!trimmedTitle) return;

      const dependencies = deps
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      try {
        const task = await onCreateTask({
          title: trimmedTitle,
          description: description.trim() || undefined,
          dependencies: dependencies.length ? dependencies : undefined,
        });
        addToast(`Created ${task.id}`, "success");
        onClose();
      } catch (err: any) {
        addToast(err.message, "error");
      }
    },
    [title, description, deps, onCreateTask, addToast, onClose],
  );

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick}>
      <div className="modal">
        <div className="modal-header">
          <h3>New Task</h3>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="task-title">Title</label>
            <input
              ref={titleRef}
              type="text"
              id="task-title"
              placeholder="What needs to be done?"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="task-desc">
              Description <span className="optional">(optional)</span>
            </label>
            <textarea
              id="task-desc"
              rows={4}
              placeholder="Add context, requirements, or rough notes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="task-deps">
              Dependencies <span className="optional">(comma-separated IDs)</span>
            </label>
            <input
              type="text"
              id="task-deps"
              placeholder="HAI-001, HAI-002"
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary">
              Create in Triage
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
