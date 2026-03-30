import { useState, useEffect, useCallback } from "react";
import { X, Trash2 } from "lucide-react";
import type { Task, AgentLogEntry } from "@kb/core";
import { useMultiAgentLogs } from "../hooks/useMultiAgentLogs";
import { AgentLogViewer } from "./AgentLogViewer";

interface TerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: Task[];
}

interface LogEntryWithTask extends AgentLogEntry {
  taskId: string;
}

export function TerminalModal({ isOpen, onClose, tasks }: TerminalModalProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  
  // Get task IDs for all in-progress tasks
  const inProgressTaskIds = tasks.map((t) => t.id);
  
  // Get log state for all tasks
  const logState = useMultiAgentLogs(inProgressTaskIds);

  // Set initial active task when modal opens
  useEffect(() => {
    if (isOpen && tasks.length > 0) {
      // If no active task or active task not in current list, set first task
      if (!activeTaskId || !tasks.find((t) => t.id === activeTaskId)) {
        setActiveTaskId(tasks[0].id);
      }
    }
    // Reset when modal closes
    if (!isOpen) {
      setActiveTaskId(null);
    }
  }, [isOpen, tasks, activeTaskId]);

  // Handle escape key to close modal
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Handle overlay click to close
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  if (!isOpen) return null;

  // Get active task info
  const activeTask = tasks.find((t) => t.id === activeTaskId);
  const activeLogState = activeTaskId ? logState[activeTaskId] : null;

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} data-testid="terminal-modal-overlay">
      <div className="modal terminal-modal" data-testid="terminal-modal">
        {/* Header with tabs and close button */}
        <div className="terminal-header">
          <div className="terminal-tabs" data-testid="terminal-tabs">
            {tasks.length === 0 ? (
              <div className="terminal-tab terminal-tab--empty" data-testid="terminal-no-tasks">
                No active tasks
              </div>
            ) : (
              tasks.map((task) => (
                <button
                  key={task.id}
                  className={`terminal-tab ${activeTaskId === task.id ? "terminal-tab--active" : ""}`}
                  onClick={() => setActiveTaskId(task.id)}
                  data-testid={`terminal-tab-${task.id}`}
                  title={task.title || task.description}
                >
                  <span className="terminal-tab-label">{task.id}</span>
                  {activeTaskId === task.id && (
                    <span
                      className="terminal-tab-indicator"
                      data-testid={`terminal-tab-indicator-${task.id}`}
                    />
                  )}
                </button>
              ))
            )}
          </div>
          <button className="terminal-close" onClick={onClose} data-testid="terminal-close-btn" title="Close terminal">
            <X size={20} />
          </button>
        </div>

        {/* Log content area */}
        <div className="terminal-content" data-testid="terminal-content">
          {tasks.length === 0 ? (
            <div className="terminal-empty-state" data-testid="terminal-empty-state">
              <p>No tasks currently in progress.</p>
              <p>Start a task to see live logs here.</p>
            </div>
          ) : activeTask && activeLogState ? (
            <>
              <div className="terminal-toolbar" data-testid="terminal-toolbar">
                <div className="terminal-task-info">
                  <span className="terminal-task-id" data-testid="terminal-active-task-id">
                    {activeTask.id}
                  </span>
                  <span className="terminal-task-title" data-testid="terminal-active-task-title">
                    {activeTask.title || activeTask.description}
                  </span>
                </div>
                <button
                  className="terminal-clear-btn"
                  onClick={activeLogState.clear}
                  data-testid="terminal-clear-btn"
                  title="Clear log buffer"
                >
                  <Trash2 size={14} />
                  <span>Clear</span>
                </button>
              </div>
              <div className="terminal-log-container" data-testid="terminal-log-container">
                <AgentLogViewer entries={activeLogState.entries} loading={activeLogState.loading} />
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
