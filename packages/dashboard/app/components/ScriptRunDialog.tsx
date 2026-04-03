import { useState, useEffect, useRef, useCallback } from "react";
import { X, Loader2, CheckCircle, XCircle, Terminal } from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { killPtyTerminalSession } from "../api";
import type { ConnectionStatus } from "../hooks/useTerminal";

interface ScriptRunDialogProps {
  isOpen: boolean;
  onClose: () => void;
  scriptName: string;
  sessionId: string;
  command: string;
}

type RunStatus = "running" | "completed" | "error";

/**
 * ScriptRunDialog — read-only modal that shows the output of a saved script run.
 *
 * Uses the existing PTY terminal session WebSocket plumbing to stream
 * live stdout/stderr output. The dialog is non-interactive (no input),
 * focused on observing the script execution and reporting exit status.
 *
 * When the dialog closes before the process exits, the backing PTY session
 * is killed to prevent orphaned sessions.
 */
export function ScriptRunDialog({
  isOpen,
  onClose,
  scriptName,
  sessionId,
  command,
}: ScriptRunDialogProps) {
  const [output, setOutput] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [status, setStatus] = useState<RunStatus>("running");
  const outputEndRef = useRef<HTMLDivElement>(null);
  const isMountedRef = useRef(true);
  const hasKilledRef = useRef(false);

  // Connect to the PTY session via WebSocket
  const { connectionStatus, onData, onExit, onConnect, onScrollback } =
    useTerminal(isOpen ? sessionId : null);

  // Auto-scroll to bottom when new output arrives
  useEffect(() => {
    if (outputEndRef.current && typeof outputEndRef.current.scrollIntoView === "function") {
      outputEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [output]);

  // Subscribe to terminal data
  useEffect(() => {
    if (!isOpen) return;

    const unsubData = onData((data: string) => {
      if (isMountedRef.current) {
        setOutput((prev) => [...prev, data]);
      }
    });

    const unsubScrollback = onScrollback((data: string) => {
      if (isMountedRef.current) {
        setOutput([data]);
      }
    });

    const unsubExit = onExit((code: number) => {
      if (isMountedRef.current) {
        setExitCode(code);
        setStatus(code === 0 ? "completed" : "error");
      }
    });

    return () => {
      unsubData();
      unsubScrollback();
      unsubExit();
    };
  }, [isOpen, onData, onScrollback, onExit]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Kill the PTY session when dialog closes before the process exits
  const handleClose = useCallback(() => {
    if (status === "running" && sessionId && !hasKilledRef.current) {
      hasKilledRef.current = true;
      killPtyTerminalSession(sessionId).catch(() => {
        // Best-effort kill — ignore errors
      });
    }
    onClose();
  }, [status, sessionId, onClose]);

  // Reset state when dialog opens with a new session
  useEffect(() => {
    if (isOpen) {
      setOutput([]);
      setExitCode(null);
      setStatus("running");
      hasKilledRef.current = false;
    }
  }, [isOpen, sessionId]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const getStatusIcon = () => {
    switch (status) {
      case "running":
        return <Loader2 size={14} className="spin" />;
      case "completed":
        return <CheckCircle size={14} style={{ color: "var(--status-success, #22c55e)" }} />;
      case "error":
        return <XCircle size={14} style={{ color: "var(--status-error, #ef4444)" }} />;
    }
  };

  const getStatusText = () => {
    switch (status) {
      case "running":
        return connectionStatus === "connected"
          ? "Running..."
          : "Connecting...";
      case "completed":
        return "Completed";
      case "error":
        return `Failed (exit code ${exitCode})`;
    }
  };

  return (
    <div className="modal-overlay open" onClick={handleClose} data-testid="script-run-dialog-overlay">
      <div
        className="modal script-run-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`Running script: ${scriptName}`}
      >
        {/* Header */}
        <div className="modal-header">
          <h2>
            <Terminal size={18} style={{ marginRight: "8px", verticalAlign: "middle" }} />
            {scriptName}
          </h2>
          <button
            className="btn-icon"
            onClick={handleClose}
            aria-label="Close"
            data-testid="script-run-dialog-close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Command */}
        <div className="script-run-dialog__command" data-testid="script-run-command">
          <span className="script-run-dialog__command-label">Command:</span>
          <code className="script-run-dialog__command-text">{command}</code>
        </div>

        {/* Output area */}
        <div className="script-run-dialog__output" data-testid="script-run-output">
          {output.length === 0 && status === "running" ? (
            <div className="script-run-dialog__output-empty">
              <Loader2 size={16} className="spin" />
              <span>Waiting for output...</span>
            </div>
          ) : (
            <pre className="script-run-dialog__output-text">
              {output.join("")}
              <div ref={outputEndRef} />
            </pre>
          )}
        </div>

        {/* Status bar */}
        <div className="script-run-dialog__status" data-testid="script-run-status">
          <div className="script-run-dialog__status-indicator">
            {getStatusIcon()}
            <span>{getStatusText()}</span>
          </div>
          {exitCode !== null && (
            <span
              className={`script-run-dialog__exit-code ${
                exitCode === 0 ? "success" : "error"
              }`}
              data-testid="script-run-exit-code"
            >
              Exit code: {exitCode}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
