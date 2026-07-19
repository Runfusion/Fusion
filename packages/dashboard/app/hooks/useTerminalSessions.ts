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
  /** Optional working directory used when this tab's server session was created. */
  cwd?: string;
  /** Whether this tab is currently active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: number;
}

export interface CreateTerminalTabInput {
  /** Optional registered workspace/worktree path for the server-created session. */
  cwd?: string;
  /** Optional display title supplied by workspace picker callers. */
  title?: string;
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
  createTab: (input?: CreateTerminalTabInput) => Promise<TerminalTab>;
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

function terminalTabsStorageKey(storageScope?: string): string {
  const trimmed = storageScope?.trim();
  return trimmed ? `${STORAGE_KEY}:${trimmed}` : STORAGE_KEY;
}

function readTabsFromStorage(projectId?: string, storageScope?: string): TerminalTab[] {
  if (typeof window === "undefined") return [];

  try {
    const stored = getScopedItem(terminalTabsStorageKey(storageScope), projectId);
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

function titleFromCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const basename = trimmed.split(/[\\/]+/).filter(Boolean).pop();
  return basename || cwd;
}

function buildTabTitle(input: CreateTerminalTabInput | undefined, terminalNumber: number): string {
  if (input?.title?.trim()) return input.title.trim();
  if (input?.cwd?.trim()) return titleFromCwd(input.cwd.trim());
  return `Terminal ${terminalNumber}`;
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
export interface UseTerminalSessionsOptions {
  /** Optional namespace for isolating persisted terminal tabs, e.g. `task:FN-123`. */
  storageScope?: string;
  /** Optional working directory used when auto-created/replacement tabs have no explicit cwd. */
  defaultCwd?: string;
}

/**
 * FNXC:TerminalWorktrees 2026-07-10-00:00:
 * FN-7813 embeds TerminalModal inside Task Detail, so task terminals need an isolated per-task tab namespace and a worktree-rooted default cwd. Omitted options preserve the global footer terminal contract: the original kb-terminal-tabs key and project-root session creation.
 */
export function useTerminalSessions(projectId?: string, options: UseTerminalSessionsOptions = {}): UseTerminalSessionsReturn {
  const storageScope = options.storageScope?.trim() || undefined;
  const defaultCwd = options.defaultCwd?.trim() || undefined;
  const storageKey = terminalTabsStorageKey(storageScope);

  // Initialize state synchronously from localStorage (no async here)
  const [tabs, setTabs] = useState<TerminalTab[]>(() => readTabsFromStorage(projectId, storageScope));

  // Track whether validation has completed
  const [isReady, setIsReady] = useState(false);
  const [serverAvailable, setServerAvailable] = useState(true);
  // Track bootstrap creation failure so callers can show error/retry UI
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  // Generation counter bumped by retryBootstrap to re-trigger auto-create effect
  const [retryGeneration, setRetryGeneration] = useState(0);
  // FNXC:Terminal 2026-07-15-10:40: Forces auto-create to reconsider the current generation after a stale attempt settles.
  const [bootstrapWakeGeneration, setBootstrapWakeGeneration] = useState(0);
  // Ref-based generation token to protect against stale completions from prior
  // bootstrap attempts. Only the current generation may mutate state.
  const generationRef = useRef(0);
  const bootstrapCreateInFlightGenerationRef = useRef<number | null>(null);

  useEffect(() => {
    generationRef.current += 1;
    // FNXC:Terminal 2026-07-15-10:40:
    // FN-8302 requires first-tab bootstrap to converge to an active tab or an
    // actionable error. A reset can invalidate an already-started create, so
    // wake the auto-create effect for the new generation instead of letting a
    // stale completion leave TerminalModal on "Starting terminal..." forever.
    setBootstrapWakeGeneration((generation) => generation + 1);
    setTabs(readTabsFromStorage(projectId, storageScope));
    setIsReady(false);
    setServerAvailable(true);
    setBootstrapError(null);
  }, [projectId, storageScope]);

  // Persist tabs to localStorage whenever they change
  useEffect(() => {
    try {
      setScopedItem(storageKey, JSON.stringify(tabs), projectId);
    } catch {
      // Ignore localStorage errors
    }
  }, [projectId, storageKey, tabs]);

  // Validate and restore tabs from server on mount
  useEffect(() => {
    let cancelled = false;
    const gen = generationRef.current;

    const validateAndRestore = async () => {
      if (cancelled) return;

      /*
      FNXC:Terminal 2026-07-08-10:00:
      FN-7686: initial terminal load was slow because a fresh open (no
      persisted kb-terminal-tabs) still paid for a full listTerminalSessions
      HTTP round trip before auto-create could even begin, even though that
      round trip's result is provably discarded when there are zero local
      tabs to validate (remainingTabs is always [] regardless of what the
      server returns). Fixed by skipping the list round trip entirely in
      that case and marking bootstrap ready immediately, so auto-create (and
      therefore the WebSocket connect that depends on it) is not serialized
      behind a no-op validation call. Reload-with-persisted-tabs still awaits
      the list call below, since its result IS decision-relevant there (which
      sessionIds still exist server-side).
      */
      if (readTabsFromStorage(projectId, storageScope).length === 0) {
        if (cancelled || gen !== generationRef.current) return;
        setServerAvailable(true);
        setIsReady(true);
        return;
      }

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
  }, [projectId, storageScope]); // Re-run when project or terminal tab storage scope changes

  // Auto-create first tab if no tabs exist after validation
  // On Windows, do NOT auto-create because the embedded shell may invoke Windows Terminal
  // (wt.exe) and produce native "Help" version dialogs. Users can still create a terminal
  // explicitly from the UI.
  useEffect(() => {
    if (typeof window !== "undefined" && window.navigator.userAgent.includes("Windows")) {
      setIsReady(true);
      return;
    }
    if (tabs.length === 0 && isReady && serverAvailable && !bootstrapError) {
      // Capture current generation so only this attempt's result is accepted
      const gen = generationRef.current;
      if (bootstrapCreateInFlightGenerationRef.current === gen) return;

      // Small delay to avoid race condition with the validation effect
      const timeout = setTimeout(() => {
        if (bootstrapCreateInFlightGenerationRef.current === gen) return;
        bootstrapCreateInFlightGenerationRef.current = gen;
        /*
        FNXC:WindowsTerminalStartup 2026-07-02-07:45:
        Terminal bootstrap failures must render once inside Fusion and then wait for an explicit Retry, so Windows Terminal help/version output cannot recur through an automatic create-session loop.
        */
        withTimeout(
          createTerminalSession(defaultCwd, undefined, undefined, projectId),
          BOOTSTRAP_CREATE_TIMEOUT_MS,
          "createTerminalSession"
        )
          .then((session) => {
            // FNXC:Terminal 2026-07-15-10:40: A stale completion cannot mutate tabs, but must wake the active generation so its empty bootstrap state retries deterministically.
            if (gen !== generationRef.current) {
              setBootstrapWakeGeneration((generation) => generation + 1);
              return;
            }

            const newTab: TerminalTab = {
              id: generateTabId(),
              sessionId: session.sessionId,
              title: defaultCwd ? titleFromCwd(defaultCwd) : `Terminal ${tabs.length + 1}`,
              ...(defaultCwd ? { cwd: session.cwd } : {}),
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
            // FNXC:Terminal 2026-07-15-10:40: A stale failure cannot set an error, but must wake the current empty generation to preserve tab-or-error convergence.
            if (gen !== generationRef.current) {
              setBootstrapWakeGeneration((generation) => generation + 1);
              return;
            }
            if (!isRelativeUrlFetchError(err)) {
              console.error(err);
            }
            const message =
              err instanceof Error ? err.message : typeof err === "string" ? err : "Failed to create terminal session";
            setBootstrapError(message);
          })
          .finally(() => {
            if (bootstrapCreateInFlightGenerationRef.current === gen) {
              bootstrapCreateInFlightGenerationRef.current = null;
            }
          });
      }, 0);
      return () => clearTimeout(timeout);
    }
  }, [
    bootstrapError,
    bootstrapWakeGeneration,
    defaultCwd,
    isReady,
    projectId,
    serverAvailable,
    tabs.length,
    retryGeneration,
  ]); // Run when ready, when tabs become empty, or after a stale attempt settles

  /**
   * Internal create tab function (used for auto-creation and user-initiated creation).
   *
   * FNXC:TerminalWorktrees 2026-06-29-00:00:
   * Worktree picker callers need to create independent terminal sessions in registered worktree directories while the existing no-argument plus, auto-create, restart, and initial-command flows keep creating project-root terminals named with Terminal N numbering.
   * Persist cwd only as optional metadata so older kb-terminal-tabs payloads without workspace data continue to restore and stale-session filtering still keys on server session ids.
   */
  const createTabInternal = useCallback(async (input?: CreateTerminalTabInput): Promise<TerminalTab> => {
    const requestedCwd = input?.cwd?.trim() || undefined;
    const session = await createTerminalSession(requestedCwd, undefined, undefined, projectId);
    const confirmedCwd = requestedCwd ? session.cwd : undefined;
    const confirmedInput = confirmedCwd ? { ...input, cwd: confirmedCwd } : input;
    const newTab: TerminalTab = {
      id: generateTabId(),
      sessionId: session.sessionId,
      title: buildTabTitle(confirmedInput, tabs.length + 1),
      ...(confirmedCwd ? { cwd: confirmedCwd } : {}),
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
  }, [projectId, tabs.length]);

  /**
   * Creates a new tab with a fresh server session.
   * The new tab becomes the active tab.
   */
  const createTab = useCallback(async (input?: CreateTerminalTabInput): Promise<TerminalTab> => {
    return createTabInternal(input);
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

    // Recreate worktree-scoped tabs in their original cwd or the hook default so restart does not silently fall back to the project root.
    const restartCwd = currentActiveTab.cwd ?? defaultCwd;
    const session = await createTerminalSession(restartCwd, undefined, undefined, projectId);
    
    setTabs((currentTabs) =>
      currentTabs.map((tab) =>
        tab.id === currentActiveTab.id
          ? { ...tab, sessionId: session.sessionId, cwd: restartCwd ? session.cwd : undefined }
          : tab
      )
    );
  }, [defaultCwd, projectId, tabs]);

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
      const replacementCwd = currentActiveTab.cwd ?? defaultCwd;
      const session = await createTerminalSession(replacementCwd, undefined, undefined, projectId);

      setTabs((currentTabs) =>
        currentTabs.map((tab) =>
          tab.id === currentActiveTab.id
            ? { ...tab, sessionId: session.sessionId, cwd: replacementCwd ? session.cwd : undefined }
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
  }, [defaultCwd, projectId, tabs]);

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
    bootstrapCreateInFlightGenerationRef.current = null;
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
