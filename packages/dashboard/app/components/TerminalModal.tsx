import { useState, useEffect, useCallback, useRef } from "react";
import { X, Trash2, Terminal as TerminalIcon } from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";

interface TerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCommand?: string;
}

/**
 * Interactive terminal modal component.
 * 
 * Provides a fully functional shell terminal where users can execute commands
 * in the project's working directory. Features include:
 * - Real-time command output streaming via SSE
 * - Command history with Up/Down arrow navigation
 * - Keyboard shortcuts (Ctrl+C to kill, Ctrl+L to clear)
 * - Persistent session during modal lifetime
 * - Scrollable output history
 * 
 * The terminal is independent of task state and always available.
 */
export function TerminalModal({ isOpen, onClose, initialCommand }: TerminalModalProps) {
  const {
    history,
    isRunning,
    inputValue,
    setInputValue,
    executeCommand,
    clearHistory,
    killCurrentCommand,
    navigateHistoryUp,
    navigateHistoryDown,
    resetHistoryNavigation,
  } = useTerminal();

  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const [showWelcome, setShowWelcome] = useState(true);

  // Auto-scroll to bottom when output changes
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [history]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  // Execute initial command if provided
  useEffect(() => {
    if (isOpen && initialCommand && showWelcome) {
      setShowWelcome(false);
      executeCommand(initialCommand);
    }
  }, [isOpen, initialCommand, executeCommand, showWelcome]);

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

  // Handle command submission
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputValue.trim() || isRunning) return;

      setShowWelcome(false);
      resetHistoryNavigation();
      await executeCommand(inputValue.trim());
    },
    [inputValue, isRunning, executeCommand, resetHistoryNavigation],
  );

  // Handle keyboard shortcuts
  const handleKeyDown = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Ctrl+C - Kill running process
      if (e.key === "c" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (isRunning) {
          await killCurrentCommand();
        }
        return;
      }

      // Ctrl+L - Clear screen
      if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        clearHistory();
        setShowWelcome(true);
        return;
      }

      // Up arrow - Navigate history back
      if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateHistoryUp();
        return;
      }

      // Down arrow - Navigate history forward
      if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateHistoryDown();
        return;
      }
    },
    [isRunning, killCurrentCommand, clearHistory, navigateHistoryUp, navigateHistoryDown],
  );

  // Handle clear button click
  const handleClear = useCallback(() => {
    clearHistory();
    setShowWelcome(true);
  }, [clearHistory]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay open"
      onClick={handleOverlayClick}
      data-testid="terminal-modal-overlay"
    >
      <div className="modal terminal-modal" data-testid="terminal-modal">
        {/* Header */}
        <div className="terminal-header">
          <div className="terminal-title" data-testid="terminal-title">
            <TerminalIcon size={16} />
            <span>Interactive Terminal</span>
          </div>
          <div className="terminal-actions">
            <button
              className="terminal-clear-btn"
              onClick={handleClear}
              data-testid="terminal-clear-btn"
              title="Clear terminal (Ctrl+L)"
            >
              <Trash2 size={14} />
              <span>Clear</span>
            </button>
            <button
              className="terminal-close"
              onClick={onClose}
              data-testid="terminal-close-btn"
              title="Close terminal"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Output area */}
        <div
          className="terminal-output"
          ref={outputRef}
          data-testid="terminal-output"
        >
          {showWelcome && history.length === 0 ? (
            <div className="terminal-welcome" data-testid="terminal-welcome">
              <div className="terminal-welcome-icon">
                <TerminalIcon size={48} />
              </div>
              <h3>Interactive Terminal</h3>
              <p>
                Execute shell commands in the project directory. Available commands include:
              </p>
              <div className="terminal-commands-list">
                <span>git</span>
                <span>npm/pnpm/yarn</span>
                <span>ls/cat</span>
                <span>node</span>
                <span>python</span>
                <span>curl</span>
                <span>make</span>
                <span>ps</span>
              </div>
              <p className="terminal-shortcuts">
                <kbd>↑</kbd> <kbd>↓</kbd> Navigate history &nbsp;•&nbsp;
                <kbd>Ctrl</kbd>+<kbd>C</kbd> Kill process &nbsp;•&nbsp;
                <kbd>Ctrl</kbd>+<kbd>L</kbd> Clear
              </p>
            </div>
          ) : (
            <div className="terminal-history">
              {history.map((entry) => (
                <div
                  key={entry.id}
                  className="terminal-entry"
                  data-testid={`terminal-entry-${entry.id}`}
                >
                  <div className="terminal-prompt-line">
                    <span className="terminal-prompt">$</span>
                    <span className="terminal-command">{entry.command}</span>
                  </div>
                  {entry.output && (
                    <pre
                      className={`terminal-output-text ${
                        entry.exitCode !== 0 && !entry.isRunning
                          ? "terminal-output-error"
                          : ""
                      }`}
                    >
                      {entry.output}
                    </pre>
                  )}
                  {entry.isRunning && (
                    <div className="terminal-running-indicator">
                      <span className="terminal-spinner" />
                      <span>Running...</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Input area */}
        <div className="terminal-input-area" data-testid="terminal-input-area">
          <form onSubmit={handleSubmit} className="terminal-form">
            <span className="terminal-input-prompt">$</span>
            <input
              ref={inputRef}
              type="text"
              className="terminal-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRunning ? "Command running..." : "Type a command..."}
              disabled={isRunning}
              autoFocus
              data-testid="terminal-input"
            />
            {isRunning && (
              <button
                type="button"
                className="terminal-kill-btn"
                onClick={killCurrentCommand}
                data-testid="terminal-kill-btn"
                title="Kill process (Ctrl+C)"
              >
                Stop
              </button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
