import { useState, useEffect, useCallback, useRef } from "react";
import { createTerminalSession, killPtyTerminalSession, listTerminalSessions } from "../api";
import { getScopedItem, setScopedItem } from "../utils/projectStorage";

const STORAGE_KEY = "kb-terminal-tabs";

/** Timeout for the list-terminal-sessions validation call during bootstrap. */
const BOOTSTRAP_LIST_TIMEOUT_MS = 15000;
/** Timeout for the auto-create createTerminalSession call during bootstrap. */
const BOOTSTRAP_CREATE_TIMEOUT_MS = 15000;

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
  /**
   * Replace the active tab's session with a fresh server session.
   * Called when the WebSocket reports the current session is invalid (code 4004).
   * Unlike restartActiveTab, this does NOT kill the old session (it's already
   * gone from the server) and does NOT reset xterm state — it only swaps the
   * sessionId so the next WebSocket connect targets the new session.
   */
  replaceActiveTabSession: () => Promise<void>;
}

/**
 * Generates a unique ID for a new tab.
 */
function generateTabId(): string {
  return `tab-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function readTabsFromStorage(projectId?: string): TerminalTab[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = getScopedItem(STORAGE_KEY, projectId);
    if (stored) {
      return JSON.parse(stored) as TerminalTab[];
    }
  } catch {
    // Ignore localStorage errors
  }

  return [];
}

function isRelativeUrlFetchError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.includes("Failed to parse URL") || message.includes("Invalid URL");
}

/**
 * Wrap a promise with a timeout that rejects with a TimeoutError.
 * Uses an AbortSignal-style approach so only the winning path resolves.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
export function useTerminalSessions(projectId?: string): UseTerminalSessionsReturn {
  // Initialize state synchronously from localStorage (no async here)
  const [tabs, setTabs] = useState<TerminalTab[]>(() => readTabsFromStorage(projectId));

  // Track whether validation has completed
  const [isReady, setIsReady] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(true);
  // Track bootstrap creation failure so callers can show error/retry UI
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  // Generation counter bumped by retryBootstrap to re-trigger auto-create effect
  const [retryGeneration, setRetryGeneration] = useState(0);
  // Ref-based generation token to protect against stale completions from prior
  // bootstrap attempts. Only the current generation may mutate state.
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    setTabs(readTabsFromStorage(projectId));
    setIsReady(false);
    setServerAvailable(true);
    setBootstrapError(null);
  }, [projectId]);

  // Persist tabs to localStorage whenever they change
  useEffect(() => {
    try {
      setScopedItem(STORAGE_KEY, JSON.stringify(tabs), projectId);
    } catch {
      // Ignore localStorage errors
    }
  }, [projectId, tabs]);

  // Validate and restore tabs from server on mount
  useEffect(() => {
    let cancelled = false;
    const gen = generationRef.current;

    const validateAndRestore = async () => {
      if (cancelled) return;
      
      try {
        // Get active server sessions with bounded timeout
        const serverSessions = await withTimeout(
          listTerminalSessions(projectId),
          BOOTSTRAP_LIST_TIMEOUT_MS,
          "listTerminalSessions"
        );
        if (cancelled || gen !== generationRef.current) return;
        
        const validSessionIds = new Set(serverSessions.map((s) => s.id));
        setServerAvailable(true);

        setTabs((currentTabs) => {
          if (cancelled || gen !== generationRef.current) return currentTabs;
          
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
        if (cancelled || gen !== generationRef.current) return;
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
  }, [projectId]); // Re-run when project scope changes

  // Auto-create first tab if no tabs exist after validation
  useEffect(() => {
    if (tabs.length === 0 && isReady && serverAvailable) {
      // Capture current generation so only this attempt's result is accepted
      const gen = generationRef.current;

      // Small delay to avoid race condition with the validation effect
      const timeout = setTimeout(() => {
        withTimeout(
          createTerminalSession(undefined, undefined, undefined, projectId),
          BOOTSTRAP_CREATE_TIMEOUT_MS,
          "createTerminalSession"
        )
          .then((session) => {
            // Only apply state changes if this is still the current generation
            if (gen !== generationRef.current) return;

            const newTab: TerminalTab = {
              id: generateTabId(),
              sessionId: session.sessionId,
              title: `Terminal ${tabs.length + 1}`,
              isActive: true,
              createdAt: Date.now(),
            };

            setTabs((currentTabs) => {
              // Double-check tabs.length === 0 to prevent duplicates
              if (currentTabs.length > 0) return currentTabs;
              const updatedTabs = currentTabs.map((tab) => ({
                ...tab,
                isActive: false,
              }));
              return [...updatedTabs, newTab];
            });
            setBootstrapError(null);
          })
          .catch((err) => {
            // Only set error if this is still the current generation
            if (gen !== generationRef.current) return;
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
    const session = await createTerminalSession(undefined, undefined, undefined, projectId);
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
      killPtyTerminalSession(tabToClose.sessionId, projectId).catch((err) => {
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
      killPtyTerminalSession(activeTab.sessionId, projectId).catch((err) => {
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
    const session = await createTerminalSession(undefined, undefined, undefined, projectId);
    
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === currentActiveTab.id
          ? { ...tab, sessionId: session.sessionId }
          : tab
      )
    );
  }, [tabs]);

  /**
   * Replace the active tab's session with a fresh server session.
   * Called when the WebSocket reports the current session is invalid (code 4004).
   *
   * Unlike restartActiveTab:
   * - Does NOT kill the old session (it's already gone from the server).
   * - Does NOT clear xterm or reset exit state — TerminalModal handles that.
   * - Only swaps the sessionId so useTerminal reconnects to the new session.
   *
   * If session creation fails, the bootstrap error is set so the user can
   * retry via the error UI.
   */
  const replaceActiveTabSession = useCallback(async (): Promise<void> => {
    // Read the active tab directly from the derived value.
    // Use a local snapshot since the async createTerminalSession may
    // cause re-renders that change tabs state.
    const currentActiveTab = tabs.find((t) => t.isActive);
    if (!currentActiveTab) return;

    try {
      const session = await createTerminalSession(undefined, undefined, undefined, projectId);

      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.id === currentActiveTab.id
            ? { ...tab, sessionId: session.sessionId }
            : tab
        )
      );
      setBootstrapError(null);
    } catch (err) {
      if (!isRelativeUrlFetchError(err)) {
        console.error(err);
      }
      const message =
        err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to create terminal session";
      setBootstrapError(message);
    }
  }, [tabs]);

  // Derive active tab
  const activeTab = tabs.find((tab) => tab.isActive) ?? null;

  /**
   * Retry bootstrap after a session creation failure.
   * Clears the error and bumps the generation so the auto-create
   * effect re-runs and stale completions from prior attempts are ignored.
   * Safe to call multiple times — only one active tab is created because
   * the effect checks tabs.length === 0.
   */
  const retryBootstrap = useCallback((): void => {
    setBootstrapError(null);
    generationRef.current += 1;
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
    replaceActiveTabSession,
  };
}
