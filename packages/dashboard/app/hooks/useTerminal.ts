import { useState, useEffect, useRef, useCallback } from "react";
import { execTerminalCommand, killTerminalSession, getTerminalStreamUrl } from "../api";

/**
 * Represents a single command execution entry in terminal history.
 */
export interface TerminalHistoryEntry {
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  timestamp: Date;
  isRunning: boolean;
}

/**
 * State of the current terminal session.
 */
export interface TerminalState {
  /** Command history entries */
  history: TerminalHistoryEntry[];
  /** Currently active session ID (null if no running command) */
  currentSessionId: string | null;
  /** Whether a command is currently executing */
  isRunning: boolean;
  /** Current input value in the terminal */
  inputValue: string;
  /** Index for navigating command history with up/down arrows (-1 means not navigating) */
  historyIndex: number;
  /** Error message if something went wrong */
  error: string | null;
}

/**
 * Actions available from the useTerminal hook.
 */
export interface TerminalActions {
  /** Execute a command in the terminal */
  executeCommand: (command: string) => Promise<void>;
  /** Clear the terminal history */
  clearHistory: () => void;
  /** Kill the currently running command */
  killCurrentCommand: () => Promise<void>;
  /** Set the input value */
  setInputValue: (value: string) => void;
  /** Navigate to previous command in history (for up arrow) */
  navigateHistoryUp: () => string | null;
  /** Navigate to next command in history (for down arrow) */
  navigateHistoryDown: () => string | null;
  /** Reset history navigation */
  resetHistoryNavigation: () => void;
  /** Clear the error message */
  clearError: () => void;
}

/**
 * Hook for managing an interactive terminal session.
 * 
 * Features:
 * - Execute shell commands with real-time output streaming via SSE
 * - Command history with Up/Down arrow navigation
 * - Kill running processes
 * - Clear history
 * - Automatic cleanup on unmount
 * 
 * @example
 * ```tsx
 * const { history, isRunning, inputValue, setInputValue, executeCommand, clearHistory } = useTerminal();
 * 
 * // In your component:
 * <input 
 *   value={inputValue} 
 *   onChange={(e) => setInputValue(e.target.value)}
 *   onKeyDown={(e) => {
 *     if (e.key === 'Enter') executeCommand(inputValue);
 *     if (e.key === 'ArrowUp') navigateHistoryUp();
 *     if (e.key === 'ArrowDown') navigateHistoryDown();
 *   }}
 * />
 * ```
 */
export function useTerminal(): TerminalState & TerminalActions {
  // History of executed commands
  const [history, setHistory] = useState<TerminalHistoryEntry[]>([]);
  
  // Current session tracking
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  
  // Input state
  const [inputValue, setInputValue] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  
  // Refs for managing SSE and abort controllers
  const eventSourceRef = useRef<EventSource | null>(null);
  const currentEntryRef = useRef<TerminalHistoryEntry | null>(null);
  const historyRef = useRef(history);
  
  // Keep history ref in sync for access in event handlers
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  /**
   * Execute a shell command in the terminal.
   * Creates a new session and streams output via SSE.
   */
  const executeCommand = useCallback(async (command: string) => {
    if (!command.trim() || isRunning) return;
    
    setError(null);
    
    try {
      // Create new history entry
      const entry: TerminalHistoryEntry = {
        id: crypto.randomUUID(),
        command: command.trim(),
        output: "",
        exitCode: null,
        timestamp: new Date(),
        isRunning: true,
      };
      
      currentEntryRef.current = entry;
      setHistory((prev) => [...prev, entry]);
      setIsRunning(true);
      setInputValue("");
      setHistoryIndex(-1);
      
      // Execute command via API
      const { sessionId } = await execTerminalCommand(command.trim());
      setCurrentSessionId(sessionId);
      
      // Connect to SSE stream
      const streamUrl = getTerminalStreamUrl(sessionId);
      const es = new EventSource(streamUrl);
      eventSourceRef.current = es;
      
      es.addEventListener("connected", () => {
        // Connection established - ready to receive output
      });
      
      es.addEventListener("terminal:output", (e) => {
        try {
          const { type, data } = JSON.parse(e.data) as { type: "stdout" | "stderr"; data: string };
          
          setHistory((prev) => {
            const lastEntry = prev[prev.length - 1];
            if (!lastEntry || !lastEntry.isRunning) return prev;
            
            const updatedEntry = {
              ...lastEntry,
              output: lastEntry.output + data,
            };
            
            return [...prev.slice(0, -1), updatedEntry];
          });
        } catch {
          // Skip malformed events
        }
      });
      
      es.addEventListener("terminal:exit", (e) => {
        try {
          const { exitCode } = JSON.parse(e.data) as { exitCode: number };
          
          setHistory((prev) => {
            const lastEntry = prev[prev.length - 1];
            if (!lastEntry || !lastEntry.isRunning) return prev;
            
            const updatedEntry = {
              ...lastEntry,
              exitCode,
              isRunning: false,
            };
            
            return [...prev.slice(0, -1), updatedEntry];
          });
          
          setIsRunning(false);
          setCurrentSessionId(null);
          currentEntryRef.current = null;
          
          // Close the SSE connection
          es.close();
          eventSourceRef.current = null;
        } catch {
          // Skip malformed events
        }
      });
      
      es.addEventListener("error", () => {
        // Connection error - mark command as failed
        setHistory((prev) => {
          const lastEntry = prev[prev.length - 1];
          if (!lastEntry || !lastEntry.isRunning) return prev;
          
          const updatedEntry = {
            ...lastEntry,
            exitCode: -1,
            isRunning: false,
            output: lastEntry.output + "\n[Connection lost]\n",
          };
          
          return [...prev.slice(0, -1), updatedEntry];
        });
        
        setIsRunning(false);
        setCurrentSessionId(null);
        currentEntryRef.current = null;
        eventSourceRef.current = null;
      });
      
    } catch (err: any) {
      setError(err.message || "Failed to execute command");
      
      // Mark entry as failed
      setHistory((prev) => {
        const lastEntry = prev[prev.length - 1];
        if (!lastEntry || !lastEntry.isRunning) return prev;
        
        const updatedEntry = {
          ...lastEntry,
          exitCode: -1,
          isRunning: false,
          output: lastEntry.output + `\n[Error: ${err.message || "Failed to execute command"}]\n`,
        };
        
        return [...prev.slice(0, -1), updatedEntry];
      });
      
      setIsRunning(false);
      setCurrentSessionId(null);
      currentEntryRef.current = null;
    }
  }, [isRunning]);

  /**
   * Kill the currently running command.
   */
  const killCurrentCommand = useCallback(async () => {
    if (!currentSessionId || !isRunning) return;
    
    try {
      await killTerminalSession(currentSessionId, "SIGTERM");
      
      // Close SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      
      // Update history entry
      setHistory((prev) => {
        const lastEntry = prev[prev.length - 1];
        if (!lastEntry || !lastEntry.isRunning) return prev;
        
        const updatedEntry = {
          ...lastEntry,
          exitCode: 130, // Standard exit code for SIGINT
          isRunning: false,
          output: lastEntry.output + "\n[Process terminated]\n",
        };
        
        return [...prev.slice(0, -1), updatedEntry];
      });
      
      setIsRunning(false);
      setCurrentSessionId(null);
      currentEntryRef.current = null;
    } catch (err: any) {
      setError(err.message || "Failed to kill process");
    }
  }, [currentSessionId, isRunning]);

  /**
   * Clear all command history.
   */
  const clearHistory = useCallback(() => {
    // Kill any running process first
    if (isRunning && currentSessionId) {
      killTerminalSession(currentSessionId, "SIGKILL").catch(() => {
        // Ignore errors during cleanup
      });
    }
    
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    
    setHistory([]);
    setCurrentSessionId(null);
    setIsRunning(false);
    setHistoryIndex(-1);
    currentEntryRef.current = null;
  }, [isRunning, currentSessionId]);

  /**
   * Navigate to previous command in history (Up arrow).
   * Returns the command string or null if no history.
   */
  const navigateHistoryUp = useCallback(() => {
    if (historyRef.current.length === 0) return null;
    
    const newIndex = historyIndex + 1;
    if (newIndex >= historyRef.current.length) return null;
    
    setHistoryIndex(newIndex);
    const command = historyRef.current[historyRef.current.length - 1 - newIndex]?.command || "";
    setInputValue(command);
    return command;
  }, [historyIndex]);

  /**
   * Navigate to next command in history (Down arrow).
   * Returns the command string or null if at end.
   */
  const navigateHistoryDown = useCallback(() => {
    if (historyIndex <= 0) {
      setHistoryIndex(-1);
      setInputValue("");
      return "";
    }
    
    const newIndex = historyIndex - 1;
    setHistoryIndex(newIndex);
    const command = historyRef.current[historyRef.current.length - 1 - newIndex]?.command || "";
    setInputValue(command);
    return command;
  }, [historyIndex]);

  /**
   * Reset history navigation to default state.
   */
  const resetHistoryNavigation = useCallback(() => {
    setHistoryIndex(-1);
  }, []);

  /**
   * Clear the error message.
   */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  /**
   * Cleanup on unmount - kill running process and close SSE.
   */
  useEffect(() => {
    return () => {
      // Kill any running process
      if (currentSessionId) {
        killTerminalSession(currentSessionId, "SIGKILL").catch(() => {
          // Ignore errors during cleanup
        });
      }
      
      // Close SSE connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, [currentSessionId]);

  return {
    // State
    history,
    currentSessionId,
    isRunning,
    inputValue,
    historyIndex,
    error,
    
    // Actions
    executeCommand,
    clearHistory,
    killCurrentCommand,
    setInputValue,
    navigateHistoryUp,
    navigateHistoryDown,
    resetHistoryNavigation,
    clearError,
  };
}
