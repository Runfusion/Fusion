import { useState, useEffect, useCallback } from "react";
import { createTerminalSession, killPtyTerminalSession, listTerminalSessions } from "../api";

const STORAGE_KEY = "kb-terminal-tabs";

/**
 * Represents a terminal tab with its metadata and session information.
 */
export interface TerminalTab {
  /** Unique tab ID (client-generated) */
  id: string;
  /** PTY session ID from server */
  sessionId: string;
  /** Display title (e.g., "bash", "zsh", or "Terminal 1") */
  title: string;
  /** Whether this tab is currently active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: number;
}

interface StoredTab extends TerminalTab {
  /** Marked as unverified during server validation */
  _verified?: boolean;
}

interface UseTerminalSessionsReturn {
  /** All terminal tabs */
  tabs: TerminalTab[];
  /** Currently active tab */
  activeTab: TerminalTab | null;
  /** Whether sessions have been validated and restored from server */
  isReady: boolean;
  /** Error during bootstrap/session creation, or null if no error */
  bootstrapError: string | null;
  /** Creates a new tab with a fresh server session */
  createTab: () => Promise<TerminalTab>;
  /** Closes a specific tab (kills server session) */
  closeTab: (tabId: string) => void;
  /** Switches to a different tab */
  setActiveTab: (tabId: string) => void;
  /** Updates the display title of a tab */
  updateTabTitle: (tabId: string, title: string) => void;
  /** Restarts the active tab's session with a new PTY session */
  restartActiveTab: () => Promise<void>;
  /** Retry bootstrap after a creation failure. Clears error and re-attempts auto-create. */
  retryBootstrap: () => void;
}

/**
 * Generates a unique ID for a new tab.
 */
function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function isRelativeUrlFetchError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes("Failed to parse URL") || message.includes("Invalid URL");
}

/**
 * Hook for managing multiple terminal sessions with localStorage persistence.
 * 
 * Features:
 * - Multiple terminal tabs with independent sessions
 * - Sessions persist when modal is closed
 * - Automatic session restoration on page reload
 * - Stale session cleanup via server validation
 * - `isReady` flag indicates when session validation is complete
 * 
 * @example
 * ```tsx
 * const { tabs, activeTab, isReady, createTab, closeTab, setActiveTab, updateTabTitle, restartActiveTab } = useTerminalSessions();
 * ```
 */
export function useTerminalSessions(): UseTerminalSessionsReturn {
  // Initialize state synchronously from localStorage (no async here)
  const [tabs, setTabs] = useState<TerminalTab[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        return JSON.parse(stored) as TerminalTab[];
      }
    } catch {
      // Ignore localStorage errors
    }
    return [];
  });

  // Track whether validation has completed
  const [isReady, setIsReady] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(true);
  // Track bootstrap creation failure so callers can show error/retry UI
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  // Generation counter bumped by retryBootstrap to re-trigger auto-create effect
  const [retryGeneration, setRetryGeneration] = useState(0);

  // Persist tabs to localStorage whenever they change
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // Ignore localStorage errors
    }
  }, [tabs]);

  // Validate and restore tabs from server on mount
  useEffect(() => {
    let cancelled = false;

    const validateAndRestore = async () => {
      if (cancelled) return;
      
      try {
        // Get active server sessions
        const serverSessions = await listTerminalSessions();
        if (cancelled) return;
        
        const validSessionIds = new Set(serverSessions.map((s) => s.id));
        setServerAvailable(true);

        setTabs((currentTabs) => {
          if (cancelled) return currentTabs;
          
          // Filter out tabs whose sessions no longer exist on server
          const validTabs = currentTabs.map((tab) => ({
            ...tab,
            _verified: validSessionIds.has(tab.sessionId),
          }));

          const remainingTabs = validTabs.filter((tab) => tab._verified);

          if (remainingTabs.length === 0) {
            // No valid tabs - return empty to trigger auto-create
            return [];
          }

          // Strip internal _verified property and return clean TerminalTab objects
          const cleanTabs = remainingTabs.map(({ _verified: _unused, ...tab }) => tab);

          // Ensure exactly one tab is active
          const activeTab = cleanTabs.find((t) => t.isActive);
          if (!activeTab) {
            // No active tab, activate the first one
            return cleanTabs.map((tab, i) => ({
              ...tab,
              isActive: i === 0,
            }));
          }

          return cleanTabs;
        });
        
        // Mark as ready after validation
        setIsReady(true);
      } catch (err) {
        // Server listing failed - keep local tabs but mark as unverified
        // The WebSocket will fail to connect, which is acceptable
        const relativeUrlError = isRelativeUrlFetchError(err);
        if (!relativeUrlError) {
          console.warn("Failed to validate terminal sessions with server:", err);
        }
        setServerAvailable(!relativeUrlError);
        // Still mark as ready so the UI can proceed
        setIsReady(true);
      }
    };

    validateAndRestore();

    return () => {
      cancelled = true;
    };
  }, []); // Only run once on mount

  // Auto-create first tab if no tabs exist after validation
  useEffect(() => {
    if (tabs.length === 0 && isReady && serverAvailable) {
      // Small delay to avoid race condition with the validation effect
      const timeout = setTimeout(() => {
        createTabInternal()
          .then(() => {
            // Clear any previous bootstrap error on success
            setBootstrapError(null);
          })
          .catch((err) => {
            if (!isRelativeUrlFetchError(err)) {
              console.error(err);
            }
            const message =
              err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to create terminal session";
            setBootstrapError(message);
          });
      }, 0);
      return () => clearTimeout(timeout);
    }
  }, [isReady, serverAvailable, tabs.length, retryGeneration]); // Run when ready or when tabs become empty

  /**
   * Internal create tab function (used for auto-creation and user-initiated creation)
   */
  const createTabInternal = useCallback(async (): Promise<TerminalTab> => {
    const session = await createTerminalSession();
    const newTab: TerminalTab = {
      id: generateTabId(),
      sessionId: session.sessionId,
      title: `Terminal ${tabs.length + 1}`,
      isActive: true,
      createdAt: Date.now(),
    };

    setTabs((currentTabs) => {
      // Deactivate all other tabs
      const updatedTabs = currentTabs.map((tab) => ({
        ...tab,
        isActive: false,
      }));
      return [...updatedTabs, newTab];
    });

    return newTab;
  }, [tabs.length]);

  /**
   * Creates a new tab with a fresh server session.
   * The new tab becomes the active tab.
   */
  const createTab = useCallback(async (): Promise<TerminalTab> => {
    return createTabInternal();
  }, [createTabInternal]);

  /**
   * Closes a specific tab by ID.
   * Kills the server session (non-blocking) and removes the tab.
   * If closing the active tab, activates the next or previous tab.
   * If closing the last tab, auto-creates a new one.
   */
  const closeTab = useCallback((tabId: string): void => {
    setTabs((currentTabs) => {
      const tabToClose = currentTabs.find((t) => t.id === tabId);
      if (!tabToClose) return currentTabs;

      // Non-blocking server session kill
      killPtyTerminalSession(tabToClose.sessionId).catch((err) => {
        console.warn(`Failed to kill terminal session ${tabToClose.sessionId}:`, err);
      });

      const tabIndex = currentTabs.findIndex((t) => t.id === tabId);
      const wasActive = tabToClose.isActive;
      const remainingTabs = currentTabs.filter((t) => t.id !== tabId);

      // If no tabs left, return empty (auto-create will happen via effect)
      if (remainingTabs.length === 0) {
        return [];
      }

      // If we closed the active tab, activate adjacent tab
      if (wasActive) {
        // Try to activate the next tab, or fall back to previous
        const newActiveIndex = Math.min(tabIndex, remainingTabs.length - 1);
        return remainingTabs.map((tab, i) => ({
          ...tab,
          isActive: i === newActiveIndex,
        }));
      }

      return remainingTabs;
    });
  }, []);

  /**
   * Switches to a different tab by ID.
   */
  const setActiveTab = useCallback((tabId: string): void => {
    setTabs((currentTabs) => {
      let found = false;
      const updatedTabs = currentTabs.map((tab) => {
        if (tab.id === tabId) {
          found = true;
          return { ...tab, isActive: true };
        }
        return { ...tab, isActive: false };
      });

      // Only update if the tab was found
      if (found) {
        return updatedTabs;
      }
      return currentTabs;
    });
  }, []);

  /**
   * Updates the display title of a specific tab.
   */
  const updateTabTitle = useCallback((tabId: string, title: string): void => {
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === tabId ? { ...tab, title } : tab
      )
    );
  }, []);

  /**
   * Restarts the active tab's session with a new PTY session.
   * Keeps the same tab but creates a new server session.
   */
  const restartActiveTab = useCallback(async (): Promise<void> => {
    setTabs((currentTabs) => {
      const activeTab = currentTabs.find((t) => t.isActive);
      if (!activeTab) return currentTabs;

      // Kill the old session (non-blocking)
      killPtyTerminalSession(activeTab.sessionId).catch((err) => {
        console.warn(`Failed to kill old session ${activeTab.sessionId}:`, err);
      });

      return currentTabs;
    });

    // Create new session for the active tab
    // We need to do this outside of setTabs to properly handle the async operation
    // Store the current tabs to find the active tab ID
    const currentActiveTab = tabs.find((t) => t.isActive);
    if (!currentActiveTab) return;

    // Create new session and update the tab's sessionId
    const session = await createTerminalSession();
    
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === currentActiveTab.id
          ? { ...tab, sessionId: session.sessionId }
          : tab
      )
    );
  }, [tabs]);

  // Derive active tab
  const activeTab = tabs.find((tab) => tab.isActive) ?? null;

  /**
   * Retry bootstrap after a session creation failure.
   * Clears the error and bumps the retry generation so the auto-create
   * effect re-runs. Safe to call multiple times — only one active tab
   * is created because the effect checks tabs.length === 0.
   */
  const retryBootstrap = useCallback((): void => {
    setBootstrapError(null);
    setRetryGeneration((g) => g + 1);
  }, []);

  return {
    tabs,
    activeTab,
    isReady,
    bootstrapError,
    createTab,
    closeTab,
    setActiveTab,
    updateTabTitle,
    restartActiveTab,
    retryBootstrap,
  };
}
