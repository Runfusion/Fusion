import { useState, useCallback, useRef, useEffect } from "react";
import { execTerminalCommand, killTerminalSession, getTerminalStreamUrl } from "../api";

/**
 * Single command entry in terminal history.
 */
export interface TerminalHistoryEntry {
  /** The command that was executed */
  command: string;
  /** Combined stdout/stderr output */
  output: string;
  /** Exit code (null if still running) */
  exitCode: number | null;
  /** Whether the command is currently running */
  isRunning: boolean;
  /** Timestamp when command was executed */
  timestamp: Date;
}

/**
 * Terminal state managed by the useTerminal hook.
 */
export interface TerminalState {
  /** Command history - newest entries at the end */
  history: TerminalHistoryEntry[];
  /** Current input value */
  input: string;
  /** Whether a command is currently executing */
  isRunning: boolean;
  /** ID of the current session (if running) */
  currentSessionId: string | null;
  /** Current working directory (tracked via cd commands) */
  currentDirectory: string;
}

/**
 * Actions provided by the useTerminal hook.
 */
export interface TerminalActions {
  /** Execute a command */
  executeCommand: (command: string) => Promise<void>;
  /** Clear command history */
  clearHistory: () => void;
  /** Set input value */
  setInput: (input: string) => void;
  /** Kill the currently running command */
  killCurrentCommand: () => Promise<void>;
  /** Navigate command history (for up/down arrow) */
  navigateHistory: (direction: "up" | "down") => string | null;
}

/**
 * Hook for managing an interactive terminal session.
 * Handles command execution, output streaming via SSE, and history management.
 */
export function useTerminal(): TerminalState & TerminalActions {
  const [history, setHistory] = useState<TerminalHistoryEntry[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [currentDirectory, setCurrentDirectory] = useState("~");

  // Refs for managing SSE and history navigation
  const eventSourceRef = useRef<EventSource | null>(null);
  const historyIndexRef = useRef<number>(-1);
  const inputBeforeHistoryRef = useRef<string>("");

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Kill any running command
      if (currentSessionId) {
        killTerminalSession(currentSessionId).catch(() => {
          // Ignore errors during cleanup
        });
      }
      // Close SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [currentSessionId]);

  /**
   * Execute a command by creating a session and streaming output via SSE.
   */
  const executeCommand = useCallback(async (command: string) => {
    const trimmedCommand = command.trim();
    if (!trimmedCommand || isRunning) return;

    // Handle clear command locally - don't add to history at all
    if (trimmedCommand === "clear" || trimmedCommand === "cls") {
      setHistory([]);
      historyIndexRef.current = -1;
      setInput("");
      return;
    }

    // Add to history as running
    const entry: TerminalHistoryEntry = {
      command: trimmedCommand,
      output: "",
      exitCode: null,
      isRunning: true,
      timestamp: new Date(),
    };

    setHistory((prev) => [...prev, entry]);
    setIsRunning(true);
    setInput("");
    historyIndexRef.current = -1;

    // Handle cd commands locally to track directory
    if (trimmedCommand.startsWith("cd ") || trimmedCommand === "cd") {
      const newDir = trimmedCommand === "cd" ? "~" : trimmedCommand.slice(3).trim();
      setCurrentDirectory(newDir);
      setHistory((prev) => {
        const updated = [...prev];
        const lastEntry = updated[updated.length - 1];
        if (lastEntry) {
          lastEntry.output = "";
          lastEntry.exitCode = 0;
          lastEntry.isRunning = false;
        }
        return updated;
      });
      setIsRunning(false);
      return;
    }

    try {
      // Create session
      const { sessionId } = await execTerminalCommand(trimmedCommand);
      setCurrentSessionId(sessionId);

      // Open SSE connection
      const eventSource = new EventSource(getTerminalStreamUrl(sessionId));
      eventSourceRef.current = eventSource;

      // Collect output
      let output = "";

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (event.type === "terminal:output") {
            output += data.data;
            // Update history with new output
            setHistory((prev) => {
              const updated = [...prev];
              const lastEntry = updated[updated.length - 1];
              if (lastEntry) {
                lastEntry.output = output;
              }
              return updated;
            });
          } else if (event.type === "terminal:exit") {
            // Command completed
            setHistory((prev) => {
              const updated = [...prev];
              const lastEntry = updated[updated.length - 1];
              if (lastEntry) {
                lastEntry.exitCode = data.exitCode ?? 0;
                lastEntry.isRunning = false;
              }
              return updated;
            });
            setIsRunning(false);
            setCurrentSessionId(null);
            eventSource.close();
            eventSourceRef.current = null;
          } else if (event.type === "terminal:error") {
            // Error from server
            output += `\n[Error: ${data.message}]\n`;
            setHistory((prev) => {
              const updated = [...prev];
              const lastEntry = updated[updated.length - 1];
              if (lastEntry) {
                lastEntry.output = output;
                lastEntry.exitCode = 1;
                lastEntry.isRunning = false;
              }
              return updated;
            });
            setIsRunning(false);
            setCurrentSessionId(null);
            eventSource.close();
            eventSourceRef.current = null;
          }
        } catch {
          // Ignore parse errors
        }
      };

      eventSource.onerror = () => {
        // Connection error or closed
        if (eventSourceRef.current === eventSource) {
          setIsRunning(false);
          setCurrentSessionId(null);
          eventSourceRef.current = null;
        }
      };
    } catch (err: any) {
      // Execution failed
      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setHistory((prev) => {
        const updated = [...prev];
        const lastEntry = updated[updated.length - 1];
        if (lastEntry) {
          lastEntry.output = `Error: ${errorMessage}`;
          lastEntry.exitCode = 1;
          lastEntry.isRunning = false;
        }
        return updated;
      });
      setIsRunning(false);
      setCurrentSessionId(null);
    }
  }, [isRunning]);

  /**
   * Kill the currently running command.
   */
  const killCurrentCommand = useCallback(async () => {
    if (!currentSessionId || !isRunning) return;

    try {
      await killTerminalSession(currentSessionId);

      // Close SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      // Update history
      setHistory((prev) => {
        const updated = [...prev];
        const lastEntry = updated[updated.length - 1];
        if (lastEntry) {
          lastEntry.output += "\n[Process terminated]\n";
          lastEntry.exitCode = 130; // SIGINT exit code
          lastEntry.isRunning = false;
        }
        return updated;
      });

      setIsRunning(false);
      setCurrentSessionId(null);
    } catch {
      // Ignore errors - process might have already exited
    }
  }, [currentSessionId, isRunning]);

  /**
   * Clear all command history.
   */
  const clearHistory = useCallback(() => {
    setHistory([]);
    historyIndexRef.current = -1;
  }, []);

  /**
   * Navigate command history with up/down arrows.
   * Returns the command to set in input, or null if no change.
   */
  const navigateHistory = useCallback((direction: "up" | "down", currentInput?: string): string | null => {
    // Filter to commands with non-empty content (include running ones for navigation)
    // Reverse to have newest first for navigation
    const commandHistory = history
      .filter((h) => h.command.trim())
      .map((h) => h.command)
      .reverse();

    if (commandHistory.length === 0) return null;

    // Get current input value (passed as param or from closure)
    const inputValue = currentInput ?? input;

    if (direction === "up") {
      // Save current input if starting navigation
      if (historyIndexRef.current === -1) {
        inputBeforeHistoryRef.current = inputValue;
      }

      // Move up in history (towards more recent commands)
      const newIndex = historyIndexRef.current + 1;
      if (newIndex < commandHistory.length) {
        historyIndexRef.current = newIndex;
        return commandHistory[newIndex];
      }
    } else {
      // Move down in history (towards older commands or back to input)
      const newIndex = historyIndexRef.current - 1;
      if (newIndex >= 0) {
        historyIndexRef.current = newIndex;
        return commandHistory[newIndex];
      } else if (newIndex === -1) {
        // Back to original input
        historyIndexRef.current = -1;
        return inputBeforeHistoryRef.current;
      }
    }

    return null;
  }, [history, input]);

  return {
    history,
    input,
    isRunning,
    currentSessionId,
    currentDirectory,
    executeCommand,
    clearHistory,
    setInput,
    killCurrentCommand,
    navigateHistory,
  };
}
