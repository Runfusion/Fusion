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
  /** Current input value in the terminal (alias for inputValue) */
  input: string;
  /** Current input value in the terminal */
  inputValue: string;
  /** Index for navigating command history with up/down arrows (-1 means not navigating) */
  historyIndex: number;
  /** Error message if something went wrong */
  error: string | null;
  /** Current working directory */
  currentDirectory: string;
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
  /** Set the input value (alias for setInputValue) */
  setInput: (value: string) => void;
  /** Navigate command history with direction and current input */
  navigateHistory: (direction: "up" | "down", currentInput?: string) => string | null;
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
 * const { history, isRunning, input, setInput, executeCommand, clearHistory } = useTerminal();
 * 
 * // In your component:
 * <input 
 *   value={input} 
 *   onChange={(e) => setInput(e.target.value)}
 *   onKeyDown={(e) => {
 *     if (e.key === 'Enter') executeCommand(input);
 *     if (e.key === 'ArrowUp') navigateHistory('up', input);
 *     if (e.key === 'ArrowDown') navigateHistory('down', input);
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
  const [originalInput, setOriginalInput] = useState("");  // Store original input when navigating history
  const [error, setError] = useState<string | null>(null);
  
  // Current directory state (tracked locally for cd commands)
  const [currentDirectory, setCurrentDirectory] = useState("~");
  
  // Refs for managing SSE and abort controllers
  const eventSourceRef = useRef<EventSource | null>(null);
  const currentEntryRef = useRef<TerminalHistoryEntry | null>(null);
  const historyRef = useRef(history);
  const currentDirRef = useRef(currentDirectory);
  const historyIndexRef = useRef(historyIndex);  // Track historyIndex in ref for navigation
  
  // Keep history ref in sync for access in event handlers
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  
  // Keep current dir ref in sync
  useEffect(() => {
    currentDirRef.current = currentDirectory;
  }, [currentDirectory]);
  
  // Keep historyIndex ref in sync
  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);

  /**
   * Handle local commands (cd, clear, cls) without API call.
   * Returns true if command was handled locally.
   */
  const handleLocalCommand = useCallback((command: string): boolean => {
    const trimmed = command.trim();
    
    // Handle clear/cls commands locally - just clear history, don't add command
    if (trimmed === "clear" || trimmed === "cls") {
      setHistory([]);
      setInputValue("");
      setHistoryIndex(-1);
      return true;
    }
    
    // Handle cd command locally
    if (trimmed === "cd" || trimmed.startsWith("cd ")) {
      const args = trimmed.slice(2).trim();
      
      if (!args || args === "~" || args === "~/") {
        setCurrentDirectory("~");
      } else if (args.startsWith("/")) {
        setCurrentDirectory(args);
      } else if (args === "..") {
        // Simple parent directory handling
        if (currentDirRef.current === "~") {
          setCurrentDirectory("~");
        } else {
          const parts = currentDirRef.current.split("/").filter(Boolean);
          parts.pop();
          setCurrentDirectory(parts.length === 0 ? "~" : "/" + parts.join("/"));
        }
      } else {
        // Relative path
        if (currentDirRef.current === "~") {
          setCurrentDirectory("~/" + args);
        } else if (currentDirRef.current === "/") {
          setCurrentDirectory("/" + args);
        } else {
          setCurrentDirectory(currentDirRef.current + "/" + args);
        }
      }
      
      // Add to history with success
      const entry: TerminalHistoryEntry = {
        id: crypto.randomUUID(),
        command: trimmed,
        output: "",
        exitCode: 0,
        timestamp: new Date(),
        isRunning: false,
      };
      setHistory((prev) => [...prev, entry]);
      return true;
    }
    
    return false;
  }, []);

  /**
   * Execute a shell command in the terminal.
   * Creates a new session and streams output via SSE.
   */
  const executeCommand = useCallback(async (command: string) => {
    if (!command.trim()) return;
    
    // Try to handle local commands first (these can run even while another command is running)
    if (handleLocalCommand(command)) {
      setInputValue("");
      setHistoryIndex(-1);
      return;
    }
    
    // For API commands, check if one is already running
    if (isRunning) return;
    
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
      setOriginalInput("");  // Clear original input on new command
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
      
      // Mark entry as failed with exit code 1 (as expected by tests)
      setHistory((prev) => {
        const lastEntry = prev[prev.length - 1];
        if (!lastEntry || !lastEntry.isRunning) return prev;
        
        const updatedEntry = {
          ...lastEntry,
          exitCode: 1,  // Changed from -1 to 1 to match test expectations
          isRunning: false,
          output: lastEntry.output + `\n[Error: ${err.message || "Failed to execute command"}]\n`,
        };
        
        return [...prev.slice(0, -1), updatedEntry];
      });
      
      setIsRunning(false);
      setCurrentSessionId(null);
      currentEntryRef.current = null;
    }
  }, [isRunning, handleLocalCommand]);

  /**
   * Kill the currently running command.
   */
  const killCurrentCommand = useCallback(async () => {
    if (!currentSessionId || !isRunning) return;
    
    try {
      await killTerminalSession(currentSessionId);  // No signal argument
      
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
      killTerminalSession(currentSessionId).catch(() => {
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
    setOriginalInput("");
    currentEntryRef.current = null;
  }, [isRunning, currentSessionId]);

  /**
   * Navigate command history with direction parameter.
   * This is the interface expected by TerminalModal component.
   * Also handles setting the input value.
   */
  const navigateHistory = useCallback((direction: "up" | "down", currentInput?: string): string | null => {
    if (historyRef.current.length === 0) return null;
    
    // Read current index from the ref (most up-to-date value)
    const currentIndex = historyIndexRef.current;
    
    if (direction === "up") {
      // Store original input on first navigation up
      if (currentIndex === -1 && currentInput !== undefined) {
        setOriginalInput(currentInput);
      } else if (currentIndex === -1) {
        setOriginalInput(inputValue);
      }
      
      const newIndex = currentIndex + 1;
      if (newIndex >= historyRef.current.length) return null;
      
      // Update both state and ref immediately
      setHistoryIndex(newIndex);
      historyIndexRef.current = newIndex;
      
      // Calculate which command to return (most recent first)
      // history = [first, second], length = 2
      // newIndex = 0: return history[2 - 1 - 0] = history[1] = "second" 
      // newIndex = 1: return history[2 - 1 - 1] = history[0] = "first"
      const commandIndex = historyRef.current.length - 1 - newIndex;
      const command = historyRef.current[commandIndex]?.command || "";
      
      setInputValue(command);
      return command;
    } else {
      // Down direction
      if (currentIndex <= 0) {
        // Restore original input and reset index
        setHistoryIndex(-1);
        historyIndexRef.current = -1;
        setInputValue(originalInput);
        return originalInput;
      }
      
      const newIndex = currentIndex - 1;
      setHistoryIndex(newIndex);
      historyIndexRef.current = newIndex;
      
      const commandIndex = historyRef.current.length - 1 - newIndex;
      const command = historyRef.current[commandIndex]?.command || "";
      
      setInputValue(command);
      return command;
    }
  }, [inputValue, originalInput]);

  /**
   * Navigate to previous command in history (Up arrow).
   * Wrapper around navigateHistory for direct use.
   */
  const navigateHistoryUp = useCallback((): string | null => {
    return navigateHistory("up", inputValue);
  }, [navigateHistory, inputValue]);

  /**
   * Navigate to next command in history (Down arrow).
   * Wrapper around navigateHistory for direct use.
   */
  const navigateHistoryDown = useCallback((): string | null => {
    return navigateHistory("down");
  }, [navigateHistory]);

  /**
   * Reset history navigation to default state.
   */
  const resetHistoryNavigation = useCallback(() => {
    setHistoryIndex(-1);
    historyIndexRef.current = -1;
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
        killTerminalSession(currentSessionId).catch(() => {
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
    input: inputValue,      // Alias for compatibility
    inputValue,
    historyIndex,
    error,
    currentDirectory,
    
    // Actions
    executeCommand,
    clearHistory,
    killCurrentCommand,
    setInputValue,
    setInput: setInputValue,  // Alias for compatibility
    navigateHistory,
    navigateHistoryUp,
    navigateHistoryDown,
    resetHistoryNavigation,
    clearError,
  };
}
