import { useState, useCallback, useEffect, useRef } from "react";
import { Link } from "lucide-react";
import type { Task, TaskCreateInput } from "@hai/core";
import type { ToastType } from "../hooks/useToast";

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
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
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
          addToast(`Created ${task.id}`, "success");
        } catch (err: any) {
          addToast(err.message, "error");
        } finally {
          setSubmitting(false);
        }
      }
    },
    [description, dependencies, submitting, onSubmit, onCancel, addToast],
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
      <input
        ref={inputRef}
        type="text"
        className="inline-create-input"
        placeholder="What needs to be done?"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={submitting}
      />
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
