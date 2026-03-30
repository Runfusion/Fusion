import { useState, useCallback, useRef, useEffect } from "react";
import { X, Trash2, Terminal as TerminalIcon } from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";

interface TerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCommand?: string;
}

export function TerminalModal({ isOpen, onClose, initialCommand }: TerminalModalProps) {
  const {
    history,
    input,
    isRunning,
    currentDirectory,
    executeCommand,
    clearHistory,
    setInput,
    killCurrentCommand,
    navigateHistory,
  } = useTerminal();

  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const [historyOffset, setHistoryOffset] = useState(-1);

  // Auto-scroll to bottom when history changes
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Execute initial command if provided
  useEffect(() => {
    if (isOpen && initialCommand && !isRunning && history.length === 0) {
      executeCommand(initialCommand);
    }
  }, [isOpen, initialCommand, isRunning, history.length, executeCommand]);

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent) => {
      // Ctrl+C - Kill running command
      if (e.ctrlKey && e.key === "c" && isRunning) {
        e.preventDefault();
        await killCurrentCommand();
        return;
      }

      // Ctrl+L - Clear screen
      if (e.ctrlKey && e.key === "l") {
        e.preventDefault();
        clearHistory();
        return;
      }

      // Enter - Execute command
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const command = input.trim();
        if (command) {
          await executeCommand(command);
          setHistoryOffset(-1);
        }
        return;
      }

      // Up arrow - Navigate history backward (older)
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const historyCmd = navigateHistory("up", input);
        if (historyCmd !== null) {
          setInput(historyCmd);
        }
        return;
      }

      // Down arrow - Navigate history forward (newer)
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const historyCmd = navigateHistory("down", input);
        if (historyCmd !== null) {
          setInput(historyCmd);
        }
        return;
      }
    },
    [input, isRunning, executeCommand, killCurrentCommand, clearHistory, navigateHistory, setInput]
  );

  // Handle overlay click to close
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay open" onClick={handleOverlayClick} data-testid="terminal-modal-overlay">
      <div className="modal terminal-modal interactive" data-testid="terminal-modal">
        {/* Header */}
        <div className="terminal-header">
          <div className="terminal-title">
            <TerminalIcon size={16} />
            <span>Terminal</span>
          </div>
          <div className="terminal-actions">
            <button
              className="terminal-clear-btn"
              onClick={clearHistory}
              disabled={history.length === 0}
              title="Clear history (Ctrl+L)"
              data-testid="terminal-clear-btn"
            >
              <Trash2 size={14} />
              <span>Clear</span>
            </button>
            <button
              className="terminal-close"
              onClick={onClose}
              data-testid="terminal-close-btn"
              title="Close terminal (Esc)"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Output area */}
        <div className="terminal-content" ref={outputRef} data-testid="terminal-content">
          {history.length === 0 ? (
            <div className="terminal-welcome" data-testid="terminal-welcome">
              <p>Interactive Terminal</p>
              <p>Type commands and press Enter to execute.</p>
              <div className="terminal-shortcuts">
                <span>Ctrl+C</span> Kill process
                <span>Ctrl+L</span> Clear screen
                <span>↑/↓</span> Command history
                <span>Esc</span> Close
              </div>
            </div>
          ) : (
            <div className="terminal-output" data-testid="terminal-output">
              {history.map((entry, index) => (
                <div key={index} className="terminal-entry" data-testid={`terminal-entry-${index}`}>
                  <div className="terminal-prompt-line">
                    <span className="terminal-prompt">$</span>
                    <span className="terminal-command">{entry.command}</span>
                    {entry.isRunning && <span className="terminal-running-indicator">●</span>}
                  </div>
                  {entry.output && (
                    <pre className="terminal-output-text" data-testid={`terminal-output-${index}`}>
                      {entry.output}
                    </pre>
                  )}
                  {!entry.isRunning && entry.exitCode !== null && (
                    <div
                      className={`terminal-exit-code ${entry.exitCode !== 0 ? "error" : ""}`}
                      data-testid={`terminal-exit-${index}`}
                    >
                      {entry.exitCode === 0 ? "✓" : `✗ Exit code: ${entry.exitCode}`}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="terminal-input-area" data-testid="terminal-input-area">
          <div className="terminal-input-line">
            <span className="terminal-prompt">$</span>
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command..."
              disabled={isRunning}
              data-testid="terminal-input"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
            />
            {isRunning && (
              <button
                className="terminal-kill-btn"
                onClick={killCurrentCommand}
                title="Kill process (Ctrl+C)"
                data-testid="terminal-kill-btn"
              >
                Stop
              </button>
            )}
          </div>
          <div className="terminal-status">
            {currentDirectory}
            {isRunning && <span className="terminal-status-running">Running...</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
