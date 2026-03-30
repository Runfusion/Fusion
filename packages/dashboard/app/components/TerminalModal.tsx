import { useState, useEffect, useRef, useCallback } from "react";
import { X, Trash2, Terminal as TerminalIcon, RefreshCw } from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { createTerminalSession, killPtyTerminalSession } from "../api";
import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

import "@xterm/xterm/css/xterm.css";

interface TerminalModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialCommand?: string;
}

/**
 * Interactive terminal modal component using xterm.js and node-pty.
 * 
 * Provides a fully functional PTY terminal where users can execute commands
 * in the project's working directory. Features include:
 * - Real-time bidirectional communication via WebSocket
 * - xterm.js for proper terminal emulation
 * - Copy/paste support
 * - Terminal zoom (Ctrl++/Ctrl+-/Ctrl+0)
 * - Auto-resizing to container
 * - Reconnection support
 * 
 * The terminal spawns a real shell (bash/zsh/powershell based on platform).
 */
export function TerminalModal({ isOpen, onClose, initialCommand }: TerminalModalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [shellName, setShellName] = useState<string>("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  const hasInitialCommandRun = useRef(false);

  const { connectionStatus, sendInput, resize, onData, onConnect, onExit, onScrollback, reconnect } = useTerminal(sessionId);

  // Initialize xterm.js
  useEffect(() => {
    if (!isOpen || !terminalRef.current || xtermRef.current) return;

    let mounted = true;

    const initTerminal = async () => {
      // Dynamically import xterm modules
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);

      if (!mounted || !terminalRef.current) return;

      // Create terminal instance
      const terminal = new Terminal({
        cursorBlink: true,
        cursorStyle: "block",
        fontSize: 14,
        fontFamily: "monospace",
        theme: {
          background: "#1e1e1e",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          selectionBackground: "#264f78",
          black: "#1e1e1e",
          red: "#f48771",
          green: "#4ec9b0",
          yellow: "#dcdcaa",
          blue: "#569cd6",
          magenta: "#c586c0",
          cyan: "#9cdcfe",
          white: "#d4d4d4",
        },
        allowProposedApi: true,
        scrollback: 5000,
      });

      // Load addons
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      const webLinksAddon = new WebLinksAddon();
      terminal.loadAddon(webLinksAddon);

      // Try to load WebGL addon for better performance
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webglAddon = new WebglAddon();
        webglAddon.onContextLoss(() => {
          webglAddon.dispose();
        });
        terminal.loadAddon(webglAddon);
      } catch {
        // WebGL not available, fallback to canvas
      }

      // Open terminal in container
      terminal.open(terminalRef.current);

      // Initial fit
      setTimeout(() => {
        fitAddon.fit();
      }, 50);

      xtermRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Handle data from terminal (user input)
      const dataHandler = terminal.onData((data) => {
        sendInput(data);
      });

      // Handle resize
      const resizeHandler = () => {
        if (fitAddonRef.current && xtermRef.current) {
          try {
            (fitAddonRef.current as InstanceType<typeof FitAddon>).fit();
            const { cols, rows } = xtermRef.current;
            resize(cols, rows);
          } catch {
            // Ignore fit errors
          }
        }
      };

      window.addEventListener("resize", resizeHandler);

      return () => {
        dataHandler.dispose();
        window.removeEventListener("resize", resizeHandler);
      };
    };

    const cleanupPromise = initTerminal();

    return () => {
      mounted = false;
      cleanupPromise.then((cleanup) => cleanup?.());
      
      if (xtermRef.current) {
        xtermRef.current.dispose();
        xtermRef.current = null;
      }
      fitAddonRef.current = null;
    };
  }, [isOpen, sendInput, resize]);

  // Subscribe to terminal data
  useEffect(() => {
    if (!xtermRef.current) return;

    const unsubData = onData((data) => {
      xtermRef.current?.write(data);
    });

    const unsubScrollback = onScrollback((data) => {
      xtermRef.current?.write(data);
    });

    const unsubConnect = onConnect((info) => {
      setShellName(info.shell.split("/").pop() || info.shell);
    });

    const unsubExit = onExit((code) => {
      setExitCode(code);
      xtermRef.current?.write(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`);
    });

    return () => {
      unsubData();
      unsubScrollback();
      unsubConnect();
      unsubExit();
    };
  }, [onData, onScrollback, onConnect, onExit]);

  // Create session when modal opens
  useEffect(() => {
    if (!isOpen) {
      // Cleanup session on close
      if (sessionId) {
        killPtyTerminalSession(sessionId).catch(() => {
          // Ignore errors during cleanup
        });
        setSessionId(null);
      }
      hasInitialCommandRun.current = false;
      setError(null);
      setExitCode(null);
      setShellName("");
      return;
    }

    // Create new session
    const createSession = async () => {
      setIsCreating(true);
      setError(null);
      
      try {
        const session = await createTerminalSession();
        setSessionId(session.sessionId);
      } catch (err: any) {
        setError(err.message || "Failed to create terminal session");
      } finally {
        setIsCreating(false);
      }
    };

    createSession();
  }, [isOpen]);

  // Run initial command when connected
  useEffect(() => {
    if (connectionStatus === "connected" && initialCommand && !hasInitialCommandRun.current && sessionId) {
      hasInitialCommandRun.current = true;
      // Small delay to let shell initialize
      setTimeout(() => {
        sendInput(initialCommand + "\n");
      }, 500);
    }
  }, [connectionStatus, initialCommand, sendInput, sessionId]);

  // Handle keyboard shortcuts (zoom)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;

      // Zoom in: Ctrl/Cmd + Plus
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        if (xtermRef.current) {
          const currentSize = xtermRef.current.options.fontSize || 14;
          xtermRef.current.options.fontSize = Math.min(currentSize + 1, 32);
          fitAddonRef.current && (fitAddonRef.current as InstanceType<typeof FitAddon>).fit();
        }
        return;
      }

      // Zoom out: Ctrl/Cmd + Minus
      if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        if (xtermRef.current) {
          const currentSize = xtermRef.current.options.fontSize || 14;
          xtermRef.current.options.fontSize = Math.max(currentSize - 1, 8);
          fitAddonRef.current && (fitAddonRef.current as InstanceType<typeof FitAddon>).fit();
        }
        return;
      }

      // Reset zoom: Ctrl/Cmd + 0
      if (e.code === "Digit0" || e.code === "Numpad0") {
        e.preventDefault();
        if (xtermRef.current) {
          xtermRef.current.options.fontSize = 14;
          fitAddonRef.current && (fitAddonRef.current as InstanceType<typeof FitAddon>).fit();
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Handle escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  // Focus terminal when connected
  useEffect(() => {
    if (connectionStatus === "connected" && xtermRef.current) {
      setTimeout(() => {
        xtermRef.current?.focus();
      }, 100);
    }
  }, [connectionStatus]);

  // Handle overlay click to close
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose]
  );

  // Handle clear button
  const handleClear = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  // Handle restart
  const handleRestart = useCallback(async () => {
    // Kill current session
    if (sessionId) {
      await killPtyTerminalSession(sessionId).catch(() => {
        // Ignore errors
      });
    }
    
    // Clear terminal
    xtermRef.current?.clear();
    setExitCode(null);
    hasInitialCommandRun.current = false;
    
    // Create new session
    setIsCreating(true);
    setError(null);
    
    try {
      const session = await createTerminalSession();
      setSessionId(session.sessionId);
    } catch (err: any) {
      setError(err.message || "Failed to create terminal session");
    } finally {
      setIsCreating(false);
    }
  }, [sessionId]);

  if (!isOpen) return null;

  const getStatusIndicator = () => {
    switch (connectionStatus) {
      case "connected":
        return <span className="terminal-status connected" title="Connected" />;
      case "connecting":
      case "reconnecting":
        return <span className="terminal-status connecting" title="Connecting..." />;
      case "disconnected":
        return <span className="terminal-status disconnected" title="Disconnected" />;
      default:
        return null;
    }
  };

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
            <span>Terminal</span>
            {shellName && (
              <span className="terminal-shell-name">({shellName})</span>
            )}
            {getStatusIndicator()}
          </div>
          <div className="terminal-actions">
            {connectionStatus === "disconnected" && sessionId && (
              <button
                className="terminal-reconnect-btn"
                onClick={reconnect}
                title="Reconnect"
                data-testid="terminal-reconnect-btn"
              >
                <RefreshCw size={14} />
                <span>Reconnect</span>
              </button>
            )}
            {exitCode !== null && (
              <button
                className="terminal-restart-btn"
                onClick={handleRestart}
                title="New Session"
                data-testid="terminal-restart-btn"
              >
                <RefreshCw size={14} />
                <span>New Session</span>
              </button>
            )}
            <button
              className="terminal-clear-btn"
              onClick={handleClear}
              data-testid="terminal-clear-btn"
              title="Clear terminal"
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

        {/* Error message */}
        {error && (
          <div className="terminal-error" data-testid="terminal-error">
            {error}
          </div>
        )}

        {/* Terminal container */}
        <div className="terminal-container" data-testid="terminal-container">
          {isCreating ? (
            <div className="terminal-loading" data-testid="terminal-loading">
              <div className="terminal-spinner" />
              <span>Starting terminal...</span>
            </div>
          ) : (
            <div
              ref={terminalRef}
              className="terminal-xterm"
              data-testid="terminal-xterm"
            />
          )}
        </div>

        {/* Connection status bar */}
        <div className="terminal-status-bar" data-testid="terminal-status-bar">
          <span className={`terminal-connection-status ${connectionStatus}`}>
            {connectionStatus === "connected" && "Connected"}
            {connectionStatus === "connecting" && "Connecting..."}
            {connectionStatus === "reconnecting" && "Reconnecting..."}
            {connectionStatus === "disconnected" && "Disconnected"}
          </span>
          {exitCode !== null && (
            <span className="terminal-exit-code" data-testid="terminal-exit-code">
              Exit: {exitCode}
            </span>
          )}
          <span className="terminal-shortcuts">
            Ctrl++/- zoom • Ctrl+L clear • Esc close
          </span>
        </div>
      </div>
    </div>
  );
}
