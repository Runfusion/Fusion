import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Task } from "@fusion/core";
import {
  startSubtaskBreakdown,
  connectSubtaskStream,
  createTasksFromBreakdown,
  cancelSubtaskBreakdown,
  fetchAiSession,
  type SubtaskItem,
} from "../api";
import {
  saveSubtaskDescription,
  getSubtaskDescription,
  clearSubtaskDescription,
} from "../hooks/modalPersistence";
import { CheckCircle, Loader2, ListTree, Plus, Trash2, X, GripVertical, ArrowUp, ArrowDown } from "lucide-react";

interface SubtaskBreakdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialDescription: string;
  onTasksCreated: (tasks: Task[]) => void;
  parentTaskId?: string;
  projectId?: string;
  resumeSessionId?: string;
}

type ViewState =
  | { type: "initial" }
  | { type: "generating"; sessionId: string }
  | { type: "editing"; sessionId: string }
  | { type: "creating"; sessionId: string };

function createEmptySubtask(index: number): SubtaskItem {
  return {
    id: `subtask-${index}`,
    title: "",
    description: "",
    suggestedSize: "M",
    dependsOn: [],
  };
}

function hasDependencyCycle(subtasks: SubtaskItem[]): boolean {
  const graph = new Map(subtasks.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) {
      if (graph.has(dep) && visit(dep)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return subtasks.some((item) => visit(item.id));
}

export function SubtaskBreakdownModal({ isOpen, onClose, initialDescription, onTasksCreated, parentTaskId, projectId, resumeSessionId }: SubtaskBreakdownModalProps) {
  const [view, setView] = useState<ViewState>({ type: "initial" });
  const [subtasks, setSubtasks] = useState<SubtaskItem[]>([]);
  const [thinkingOutput, setThinkingOutput] = useState("");
  const [showThinking, setShowThinking] = useState(true);
  // Local description: synced from prop, can fall back to localStorage
  const [localDescription, setLocalDescription] = useState(initialDescription);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  
  // Drag-and-drop state
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dragOverPosition, setDragOverPosition] = useState<'before' | 'after' | null>(null);
  
  const streamRef = useRef<{ close: () => void; isConnected: () => boolean } | null>(null);
  const titleRefs = useRef<Array<HTMLInputElement | null>>([]);
  const autoStartedRef = useRef(false);

  const sessionId = view.type === "generating" || view.type === "editing" || view.type === "creating"
    ? view.sessionId
    : null;

  const isInvalid = useMemo(() => {
    if (subtasks.length === 0) return true;
    if (subtasks.some((subtask) => !subtask.title.trim())) return true;
    return hasDependencyCycle(subtasks);
  }, [subtasks]);

  const resetState = useCallback(() => {
    // Save to localStorage before cleanup (preserve for re-entry)
    if (localDescription) {
      saveSubtaskDescription(localDescription);
    }
    streamRef.current?.close();
    streamRef.current = null;
    setView({ type: "initial" });
    setSubtasks([]);
    setThinkingOutput("");
    setShowThinking(true);
    setError(null);
    setDirty(false);
    autoStartedRef.current = false;
  }, [localDescription]);

  const handleClose = useCallback(async () => {
    if ((dirty || view.type === "editing" || view.type === "creating") && !confirm("Close subtask breakdown? Unsaved changes will be lost.")) {
      return;
    }
    if (sessionId) {
      try {
        await cancelSubtaskBreakdown(sessionId, projectId);
      } catch {
        // ignore cancel errors
      }
    }
    resetState();
    onClose();
  }, [dirty, onClose, resetState, sessionId, view.type, projectId]);

  const beginBreakdown = useCallback(async () => {
    if (!localDescription.trim()) return;
    setError(null);
    setThinkingOutput("");

    try {
      const { sessionId } = await startSubtaskBreakdown(localDescription.trim(), projectId);
      setView({ type: "generating", sessionId });
      streamRef.current?.close();
      streamRef.current = connectSubtaskStream(sessionId, projectId, {
        onThinking: (data) => setThinkingOutput((prev) => prev + data),
        onSubtasks: (items) => {
          clearSubtaskDescription();
          setSubtasks(items);
          setView({ type: "editing", sessionId });
          setDirty(false);
        },
        onError: (message) => {
          setError(message);
          setView({ type: "initial" });
        },
      });
    } catch (err: any) {
      setError(err.message || "Failed to start subtask breakdown");
      setView({ type: "initial" });
    }
  }, [localDescription, projectId]);

  useEffect(() => {
    if (!isOpen) {
      resetState();
      return;
    }

    if (isOpen && initialDescription && !autoStartedRef.current) {
      setLocalDescription(initialDescription);
      autoStartedRef.current = true;
      void beginBreakdown();
    } else if (isOpen && !initialDescription && !autoStartedRef.current) {
      // Check localStorage for persisted description when no prop provided
      const persisted = getSubtaskDescription();
      if (persisted) {
        setLocalDescription(persisted);
      }
    }
  }, [isOpen, initialDescription, beginBreakdown, resetState]);

  useEffect(() => {
    if (!isOpen || !resumeSessionId || view.type !== "initial") return;

    void (async () => {
      try {
        const session = await fetchAiSession(resumeSessionId);
        if (!session) return;
        if (session.status === "generating" || session.status === "awaiting_input") {
          setThinkingOutput(session.thinkingOutput ?? "");
          setView({ type: "generating", sessionId: resumeSessionId });
          streamRef.current?.close();
          streamRef.current = connectSubtaskStream(resumeSessionId, projectId, {
            onThinking: (data) => setThinkingOutput((prev) => prev + data),
            onSubtasks: (items) => {
              clearSubtaskDescription();
              setSubtasks(items);
              setView({ type: "editing", sessionId: resumeSessionId });
              setDirty(false);
            },
            onError: (message) => {
              setError(message);
              setView({ type: "initial" });
            },
          });
        } else if (session.status === "complete" && session.result) {
          clearSubtaskDescription();
          const items = JSON.parse(session.result) as SubtaskItem[];
          setSubtasks(items);
          setView({ type: "editing", sessionId: resumeSessionId });
        } else if (session.status === "error") {
          setError(session.error ?? "Session encountered an error");
        }
      } catch (err: any) {
        setError(err.message || "Failed to resume session");
      }
    })();
  }, [isOpen, resumeSessionId, view.type, projectId]);

  useEffect(() => {
    return () => {
      streamRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  const updateSubtask = useCallback((id: string, patch: Partial<SubtaskItem>) => {
    setSubtasks((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
    setDirty(true);
  }, []);

  const addSubtask = useCallback(() => {
    setSubtasks((current) => [...current, createEmptySubtask(current.length + 1)]);
    setDirty(true);
  }, []);

  const removeSubtask = useCallback((id: string) => {
    setSubtasks((current) => current
      .filter((item) => item.id !== id)
      .map((item) => ({ ...item, dependsOn: item.dependsOn.filter((dep) => dep !== id) })));
    setDirty(true);
  }, []);

  // Drag-and-drop handlers
  const handleDragStart = useCallback((subtaskId: string) => (e: React.DragEvent) => {
    setDraggingId(subtaskId);
    e.dataTransfer.setData('text/plain', subtaskId);
    e.dataTransfer.effectAllowed = 'move';
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  }, []);

  const handleDragOver = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    if (targetId === draggingId) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    
    setDragOverId(targetId);
    setDragOverPosition(position);
  }, [draggingId]);

  const handleDrop = useCallback((targetId: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('text/plain');
    
    if (!draggedId || draggedId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      setDragOverPosition(null);
      return;
    }

    setSubtasks((current) => {
      const fromIndex = current.findIndex((s) => s.id === draggedId);
      const toIndex = current.findIndex((s) => s.id === targetId);
      
      if (fromIndex === -1 || toIndex === -1) return current;
      
      const newSubtasks = [...current];
      const [moved] = newSubtasks.splice(fromIndex, 1);
      
      let insertIndex = toIndex;
      if (dragOverPosition === 'after' && fromIndex < toIndex) insertIndex--;
      if (dragOverPosition === 'after') insertIndex++;
      
      newSubtasks.splice(insertIndex, 0, moved);
      return newSubtasks;
    });
    
    setDirty(true);
    setDraggingId(null);
    setDragOverId(null);
    setDragOverPosition(null);
  }, [dragOverPosition]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    // Only clear if leaving the element entirely, not just moving between children
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setDragOverId(null);
      setDragOverPosition(null);
    }
  }, []);

  // Keyboard reordering handlers
  const moveSubtask = useCallback((fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= subtasks.length) return;
    
    setSubtasks((current) => {
      const newSubtasks = [...current];
      const [moved] = newSubtasks.splice(fromIndex, 1);
      newSubtasks.splice(toIndex, 0, moved);
      return newSubtasks;
    });
    setDirty(true);
  }, [subtasks.length]);

  const moveFocusToNext = useCallback((index: number) => {
    titleRefs.current[index + 1]?.focus();
  }, []);

  const handleCreateTasks = useCallback(async () => {
    if (!sessionId || isInvalid) return;
    setError(null);
    setView({ type: "creating", sessionId });
    try {
      const result = await createTasksFromBreakdown(sessionId, subtasks, parentTaskId, projectId);
      onTasksCreated(result.tasks);
      resetState();
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to create tasks");
      setView({ type: "editing", sessionId });
    }
  }, [isInvalid, onClose, onTasksCreated, parentTaskId, resetState, sessionId, subtasks]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={(event) => event.target === event.currentTarget && void handleClose()}>
      <div className="modal modal-lg planning-modal">
        <div className="modal-header">
          <div className="detail-title-row">
            <ListTree size={20} style={{ color: "var(--triage)" }} />
            <h3>Subtask Breakdown</h3>
          </div>
          <button className="modal-close" onClick={() => void handleClose()} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="planning-modal-body">
          {error && <div className="form-error planning-error">{error}</div>}

          {view.type === "initial" && (
            <div className="planning-initial">
              <div className="planning-view-scroll">
                <p className="text-muted">Preparing to break this task into subtasks.</p>
                <pre className="planning-thinking-output">{localDescription}</pre>
              </div>
            </div>
          )}

          {view.type === "generating" && (
            <div className="planning-loading">
              <Loader2 size={40} className="spin" style={{ color: "var(--todo)" }} />
              <p>AI is generating subtasks...</p>
              <div className="planning-thinking-container">
                <button className="planning-thinking-toggle" onClick={() => setShowThinking(!showThinking)} type="button">
                  {showThinking ? "Hide thinking" : "Show thinking"}
                </button>
                {showThinking && thinkingOutput && (
                  <div className="planning-thinking-output">
                    <pre>{thinkingOutput}</pre>
                  </div>
                )}
              </div>
            </div>
          )}

          {(view.type === "editing" || view.type === "creating") && (
            <div className="planning-summary">
              <div className="planning-view-scroll planning-summary-scroll">
                <div className="planning-summary-header">
                  <CheckCircle size={24} style={{ color: "var(--color-success)" }} />
                  <h4>Review your subtasks</h4>
                  <p className="text-muted">Edit titles, descriptions, sizes, and dependencies before creating all tasks at once.</p>
                </div>

                <div className="planning-summary-form">
                  {subtasks.map((subtask, index) => {
                    const isDragging = draggingId === subtask.id;
                    const isDragOver = dragOverId === subtask.id;
                    const dragClasses = [
                      'task-detail-section',
                      'subtask-item',
                      isDragging ? 'subtask-item-dragging' : '',
                      isDragOver ? 'subtask-item-drop-target' : '',
                      isDragOver && dragOverPosition === 'before' ? 'subtask-item-drop-before' : '',
                      isDragOver && dragOverPosition === 'after' ? 'subtask-item-drop-after' : '',
                    ].filter(Boolean).join(' ');

                    return (
                      <div
                        key={subtask.id}
                        className={dragClasses}
                        data-testid={`subtask-item-${index}`}
                        draggable={view.type !== "creating"}
                        onDragStart={handleDragStart(subtask.id)}
                        onDragEnd={handleDragEnd}
                        onDragOver={handleDragOver(subtask.id)}
                        onDrop={handleDrop(subtask.id)}
                        onDragLeave={handleDragLeave}
                      >
                        <div className="detail-title-row subtask-item-header" style={{ justifyContent: "space-between" }}>
                          <div className="subtask-drag-handle" title="Drag to reorder">
                            <GripVertical size={16} />
                            <strong>{subtask.id}</strong>
                          </div>
                          <div className="subtask-item-actions">
                            <button
                              type="button"
                              className="btn btn-icon btn-sm"
                              onClick={() => moveSubtask(index, index - 1)}
                              disabled={view.type === "creating" || index === 0}
                              title="Move up"
                              aria-label="Move subtask up"
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              type="button"
                              className="btn btn-icon btn-sm"
                              onClick={() => moveSubtask(index, index + 1)}
                              disabled={view.type === "creating" || index === subtasks.length - 1}
                              title="Move down"
                              aria-label="Move subtask down"
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button type="button" className="btn btn-sm" onClick={() => removeSubtask(subtask.id)} disabled={view.type === "creating"}>
                              <Trash2 size={14} /> Remove
                            </button>
                          </div>
                        </div>

                      <div className="form-group">
                        <label>Title</label>
                        <input
                          ref={(element) => { titleRefs.current[index] = element; }}
                          value={subtask.title}
                          onChange={(event) => updateSubtask(subtask.id, { title: event.target.value })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              moveFocusToNext(index);
                            }
                          }}
                          disabled={view.type === "creating"}
                        />
                      </div>

                      <div className="form-group">
                        <label>Description</label>
                        <textarea
                          rows={3}
                          value={subtask.description}
                          onChange={(event) => updateSubtask(subtask.id, { description: event.target.value })}
                          disabled={view.type === "creating"}
                        />
                      </div>

                      <div className="form-group">
                        <label>Size</label>
                        <div className="planning-size-selector">
                          {(["S", "M", "L"] as const).map((size) => (
                            <button
                              key={size}
                              type="button"
                              className={`planning-size-btn ${subtask.suggestedSize === size ? "selected" : ""}`}
                              onClick={() => updateSubtask(subtask.id, { suggestedSize: size })}
                              disabled={view.type === "creating"}
                            >
                              {size}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Dependencies</label>
                        <div className="planning-deps-list">
                          {/* Only show subtasks that come BEFORE this one in the list (prevents cycles) */}
                          {subtasks.slice(0, index).filter((item) => item.id !== subtask.id).map((candidate) => {
                            const selected = subtask.dependsOn.includes(candidate.id);
                            return (
                              <label key={candidate.id} className={`planning-dep-chip ${selected ? "selected" : ""}`}>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => {
                                    const nextDeps = selected
                                      ? subtask.dependsOn.filter((dep) => dep !== candidate.id)
                                      : [...subtask.dependsOn, candidate.id];
                                    updateSubtask(subtask.id, { dependsOn: nextDeps });
                                  }}
                                  disabled={view.type === "creating"}
                                />
                                <span className="planning-dep-id">{candidate.id}</span>
                                <span className="planning-dep-title">{candidate.title || "Untitled"}</span>
                              </label>
                            );
                          })}
                          {index === 0 && (
                            <div className="text-muted">First subtask cannot have dependencies.</div>
                          )}
                          {index > 0 && subtasks.slice(0, index).filter((item) => item.id !== subtask.id).length === 0 && (
                            <div className="text-muted">No previous subtasks available.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                  })}

                  <button type="button" className="btn" onClick={addSubtask} disabled={view.type === "creating"}>
                    <Plus size={16} style={{ marginRight: 6 }} /> Add subtask
                  </button>

                  {hasDependencyCycle(subtasks) && (
                    <div className="form-error planning-error">Dependencies contain a cycle. Remove circular references before creating tasks.</div>
                  )}
                </div>
              </div>

              <div className="planning-actions planning-summary-actions">
                <button className="btn" onClick={() => void handleClose()} disabled={view.type === "creating"}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => void handleCreateTasks()} disabled={view.type === "creating" || isInvalid}>
                  {view.type === "creating" ? (
                    <>
                      <Loader2 size={16} className="spin" style={{ marginRight: 8 }} />
                      Creating...
                    </>
                  ) : (
                    <>Create Tasks</>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export type { SubtaskBreakdownModalProps };
