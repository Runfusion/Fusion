import { useState, useEffect, useRef, useCallback } from "react";
import { X, Trash2, Terminal as TerminalIcon, RefreshCw } from "lucide-react";
import { useTerminal } from "../hooks/useTerminal";
import { useTerminalSessions } from "../hooks/useTerminalSessions";
import "@xterm/xterm/css/xterm.css";

import type { Terminal as XTerm, ITerminalAddon } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

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
 * - Multiple terminal tabs with session persistence
 * - xterm.js for proper terminal emulation
 * - Copy/paste support
 * - Terminal zoom (Ctrl++/Ctrl+-/Ctrl+0)
 * - Auto-resizing to container
 * - Reconnection support
 * 
 * The terminal spawns a real shell (bash/zsh/powershell based on platform).
 */
export function TerminalModal({ isOpen, onClose, initialCommand }: TerminalModalProps) {
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [xtermReady, setXtermReady] = useState(false);
  const [openGeneration, setOpenGeneration] = useState(0);
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<ITerminalAddon | null>(null);
  const hasInitialCommandRun = useRef<string | false>(false);
  const xtermInitializedRef = useRef<string | false>(false);

  // Bump open generation whenever the modal opens so the initialCommand
  // effect re-evaluates after a close/reopen cycle (deps may be identical).
  useEffect(() => {
    if (isOpen) {
      setOpenGeneration((g) => g + 1);
    }
  }, [isOpen]);

  // Use the session management hook
  const { 
    tabs, 
    activeTab, 
    isReady,
    createTab, 
    closeTab, 
    setActiveTab, 
    updateTabTitle,
    restartActiveTab 
  } = useTerminalSessions();

  // Get the WebSocket connection for the active session
  const { connectionStatus, sendInput, resize, onData, onConnect, onExit, onScrollback, reconnect } = 
    useTerminal(activeTab?.sessionId ?? null);

  // Initialize xterm.js when session is ready
  // Depends on `isReady`, `activeTab`, and xtermReady to properly reinitialize on tab switch
  useEffect(() => {
    if (!isOpen || !isReady || !activeTab || !terminalRef.current) return;

    // If session changed, we need to reinitialize xterm
    const currentSessionId = activeTab.sessionId;
    
    // Clean up existing xterm if switching sessions
    if (xtermRef.current && xtermInitializedRef.current !== currentSessionId) {
      xtermRef.current.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      xtermInitializedRef.current = false;
      setXtermReady(false);
    }

    // If already initialized for this session, skip
    if (xtermInitializedRef.current === currentSessionId && xtermRef.current) {
      return;
    }

    let mounted = true;

    const initTerminal = async () => {
      // Dynamically import xterm modules
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);

      if (!mounted || !terminalRef.current || xtermRef.current) return;

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
      xtermInitializedRef.current = currentSessionId;

      // Signal that xterm is ready so the subscription effect re-runs
      setXtermReady(true);

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
      
      // Don't dispose xterm here - it should persist across tab switches
      // Only dispose when the modal is fully closed
    };
  }, [isOpen, isReady, activeTab?.sessionId, sendInput, resize]);

  // Cleanup xterm when modal closes
  useEffect(() => {
    if (isOpen) return;

    // Modal is closed - cleanup xterm
    if (xtermRef.current) {
      xtermRef.current.dispose();
      xtermRef.current = null;
    }
    fitAddonRef.current = null;
    xtermInitializedRef.current = false;
    setXtermReady(false);
    hasInitialCommandRun.current = false;
    setError(null);
    setExitCode(null);
  }, [isOpen]);

  // Subscribe to terminal data.
  // Depends on `xtermReady` so subscriptions are established after the
  // async xterm initialization completes and xtermRef.current is set.
  useEffect(() => {
    if (!xtermReady || !xtermRef.current) return;

    const unsubData = onData((data) => {
      xtermRef.current?.write(data);
    });

    const unsubScrollback = onScrollback((data) => {
      xtermRef.current?.write(data);
    });

    const unsubConnect = onConnect((info) => {
      // Update tab title with shell name
      if (activeTab) {
        updateTabTitle(activeTab.id, info.shell.split("/").pop() || info.shell);
      }
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
  }, [xtermReady, activeTab?.id, onData, onScrollback, onConnect, onExit, updateTabTitle]);

  // Run initial command when connected.
  // Tracks the last command that was sent so that a new command provided
  // while the terminal is already open (e.g., running a different script)
  // will be executed immediately without requiring a modal close/reopen.
  // Depends on openGeneration so the command re-fires after close/reopen.
  useEffect(() => {
    if (connectionStatus === "connected" && initialCommand && hasInitialCommandRun.current !== initialCommand && activeTab) {
      hasInitialCommandRun.current = initialCommand;
      // Small delay to let shell initialize
      setTimeout(() => {
        sendInput(initialCommand + "\n");
      }, 500);
    }
  }, [connectionStatus, initialCommand, sendInput, activeTab, openGeneration]);

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

  // Handle restart - create new session in the current tab
  const handleRestart = useCallback(async () => {
    // Clear terminal display
    xtermRef.current?.clear();
    setExitCode(null);
    hasInitialCommandRun.current = false;
    
    // Restart the active tab's session
    try {
      await restartActiveTab();
    } catch (err: any) {
      setError(err.message || "Failed to restart terminal session");
    }
  }, [restartActiveTab]);

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

  // Determine loading state
  const isLoading = !isReady || !activeTab || !xtermReady;

  return (
    <div
      className="modal-overlay open"
      onClick={handleOverlayClick}
      data-testid="terminal-modal-overlay"
    >
      <div className="modal terminal-modal" data-testid="terminal-modal">
        {/* Header — on mobile (≤768px) flex-wrap stacks tabs and actions on separate rows;
            .terminal-title is hidden; action button labels are hidden (icons only) */}
        <div className="terminal-header">
          {/* Tab Bar */}
          <div className="terminal-tabs" data-testid="terminal-tabs">
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`terminal-tab ${tab.isActive ? "terminal-tab--active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.title}
                role="tab"
                aria-selected={tab.isActive}
              >
                <span className="terminal-tab-label">{tab.title}</span>
                {tabs.length > 1 && (
                  <button
                    className="terminal-tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(tab.id);
                    }}
                    title="Close tab"
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
            <button
              className="terminal-tab terminal-tab--new"
              onClick={createTab}
              title="New terminal"
            >
              +
            </button>
          </div>
          
          {/* Status indicator */}
          <div className="terminal-title" data-testid="terminal-title">
            <TerminalIcon size={16} />
            {getStatusIndicator()}
          </div>
          
          {/* Actions — labels hidden on mobile via .terminal-action-label */}
          <div className="terminal-actions" data-testid="terminal-actions">
            {connectionStatus === "disconnected" && activeTab && (
              <button
                className="terminal-reconnect-btn"
                onClick={reconnect}
                title="Reconnect"
                data-testid="terminal-reconnect-btn"
              >
                <RefreshCw size={14} />
                <span className="terminal-action-label">Reconnect</span>
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
                <span className="terminal-action-label">New Session</span>
              </button>
            )}
            <button
              className="terminal-clear-btn"
              onClick={handleClear}
              data-testid="terminal-clear-btn"
              title="Clear terminal"
            >
              <Trash2 size={14} />
              <span className="terminal-action-label">Clear</span>
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
          {isLoading && (
            <div className="terminal-loading" data-testid="terminal-loading">
              <div className="terminal-spinner" />
              <span>Starting terminal...</span>
            </div>
          )}
          {/* Use key to force remount on session change */}
          <div
            ref={terminalRef}
            className="terminal-xterm"
            data-testid="terminal-xterm"
            style={isLoading ? { display: "none" } : undefined}
          />
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
