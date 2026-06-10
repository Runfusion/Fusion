import { pushTrace } from "./utils/dashboardTraceBuffer";

declare const __BUILD_VERSION__: string;

const RELOAD_FLAG = "fusion:version-reload";
const VERSION_UPDATE_FLAG = "fusion:version-update";
const RELOADED_REMOTE_VERSION_FLAG = "fusion:version-reloaded-remote";

/**
 * Module-level guard for auto-reload behavior.
 * Default true (auto-reload enabled). Set to false when the user disables
 * the `autoReloadOnVersionChange` setting.
 */
let autoReloadEnabled = true;

/**
 * Allow the React app to toggle the auto-reload guard at runtime
 * (e.g. when the user changes the setting in the Settings modal).
 */
export function setAutoReloadEnabled(enabled: boolean): void {
  autoReloadEnabled = enabled;
}

/** Exported for testing — reads the current guard value. */
export function _isAutoReloadEnabled(): boolean {
  return autoReloadEnabled;
}

/** Exported for testing — resets internal state and clears installed polling. */
export function _resetState(): void {
  lastCheckTime = 0;
  checkInFlight = false;
  autoReloadEnabled = true;
  try {
    sessionStorage.removeItem(RELOADED_REMOTE_VERSION_FLAG);
  } catch {
    // ignore
  }
  if (pollIntervalId !== null) {
    window.clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  _resetMismatchState();
}

export function consumeVersionUpdateFlag(): boolean {
  try {
    if (sessionStorage.getItem(VERSION_UPDATE_FLAG)) {
      sessionStorage.removeItem(VERSION_UPDATE_FLAG);
      return true;
    }
  } catch {
    // ignore (e.g. storage disabled)
  }
  return false;
}

export function reloadOnce(reason: string): void {
  const alreadySet = Boolean(sessionStorage.getItem(RELOAD_FLAG));
  pushTrace("versionCheck", "reload-attempt", { reason, alreadySet });
  if (alreadySet) {
    console.warn("[versionCheck] reload already attempted, suppressing", reason);
    return;
  }
  sessionStorage.setItem(RELOAD_FLAG, "1");
  if (!autoReloadEnabled) {
    console.info("[versionCheck] auto-reload disabled by setting, skipping reload:", reason);
    return;
  }
  console.info("[versionCheck] reloading:", reason);
  window.location.reload();
}

function getReloadedRemoteVersion(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_REMOTE_VERSION_FLAG);
  } catch {
    return null;
  }
}

function setReloadedRemoteVersion(version: string): void {
  try {
    sessionStorage.setItem(RELOADED_REMOTE_VERSION_FLAG, version);
  } catch {
    // ignore
  }
}

function clearReloadedRemoteVersion(): void {
  try {
    sessionStorage.removeItem(RELOADED_REMOTE_VERSION_FLAG);
  } catch {
    // ignore
  }
}

export function isStaleChunkError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|is not a valid JavaScript MIME type|ChunkLoadError|Unable to preload (?:CSS|module) for/i.test(
    message,
  );
}

export function handleChunkLoadError(error: unknown): boolean {
  if (!isStaleChunkError(error)) return false;
  reloadOnce(`chunk load error: ${(error as Error)?.message ?? error}`);
  return true;
}

async function fetchRemoteVersion(): Promise<string | null> {
  try {
    const res = await fetch("/version.json", {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    const data = (await res.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

/**
 * Bootstrap: fetch global settings to check `autoReloadOnVersionChange`.
 * Runs once during `installVersionCheck()`. If the fetch fails or times out,
 * the default (true = auto-reload enabled) is kept.
 */
async function bootstrapAutoReloadSetting(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("/api/settings", {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      const data = (await res.json()) as { autoReloadOnVersionChange?: unknown };
      if (data.autoReloadOnVersionChange === false) {
        autoReloadEnabled = false;
      }
    }
  } catch {
    // Network error, timeout, etc. — keep default (true).
  }
}

export const MIN_CHECK_INTERVAL_MS = 60_000; // 1 minute
export const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

type VersionCheckTrigger = "visibilitychange" | "focus" | "initial" | "poll";

let lastCheckTime = 0;
let checkInFlight = false;
let lastMismatchedRemote: string | null = null;
let lastMismatchAt = 0;
let pollIntervalId: number | null = null;

/** Exported for testing — resets internal cooldown state */
export function _resetCheckState(): void {
  lastCheckTime = 0;
  checkInFlight = false;
  _resetMismatchState();
}

export function _resetMismatchState(): void {
  lastMismatchedRemote = null;
  lastMismatchAt = 0;
}

export async function checkVersion(trigger: VersionCheckTrigger = "initial"): Promise<void> {
  if (checkInFlight || document.visibilityState !== "visible") return;
  if (Date.now() - lastCheckTime < MIN_CHECK_INTERVAL_MS) return;
  lastCheckTime = Date.now();
  checkInFlight = true;
  try {
    const remote = await fetchRemoteVersion();
    if (remote === null) {
      pushTrace("versionCheck", "remote-unavailable", {
        trigger,
        visibilityState: document.visibilityState,
      });
      lastMismatchedRemote = null;
      return;
    }

    if (remote === __BUILD_VERSION__) {
      lastMismatchedRemote = null;
      clearReloadedRemoteVersion();
      return;
    }

    pushTrace("versionCheck", "mismatch", {
      local: __BUILD_VERSION__,
      remote,
      trigger,
      visibilityState: document.visibilityState,
    });
    console.info("[versionCheck] mismatch", { local: __BUILD_VERSION__, remote, trigger });

    if (lastMismatchedRemote !== remote) {
      lastMismatchedRemote = remote;
      lastMismatchAt = Date.now();
      pushTrace("versionCheck", "mismatch-pending", {
        local: __BUILD_VERSION__,
        remote,
        trigger,
        visibilityState: document.visibilityState,
      });
      return;
    }

    pushTrace("versionCheck", "mismatch-confirmed", {
      remote,
      trigger,
      elapsedMs: Date.now() - lastMismatchAt,
    });

    if (getReloadedRemoteVersion() === remote) {
      pushTrace("versionCheck", "reload-suppressed", {
        remote,
        trigger,
        reason: "already-reloaded-remote-version",
      });
      console.info("[versionCheck] reload already attempted for remote version", remote);
      return;
    }

    try {
      sessionStorage.setItem(VERSION_UPDATE_FLAG, "1");
    } catch {
      // ignore
    }
    if (autoReloadEnabled) {
      setReloadedRemoteVersion(remote);
    }
    reloadOnce(`build version changed: ${__BUILD_VERSION__} -> ${remote}`);
  } finally {
    checkInFlight = false;
  }
}

/**
 * Install production version-change detection.
 *
 * The checker runs on initial load, tab visibility/focus events, and a
 * lightweight periodic poll so foreground tabs detect newly deployed bundles
 * even when the user never switches away. `checkVersion()` applies visibility
 * and cooldown guards, so the interval does not fetch for hidden tabs or more
 * frequently than the minimum check interval.
 */
export function installVersionCheck(): void {
  if (!import.meta.env.PROD) return;
  // Fetch settings to apply auto-reload guard before first version check.
  void bootstrapAutoReloadSetting();
  // Clear stale flag once a fresh page has rendered successfully.
  window.setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5_000);
  document.addEventListener("visibilitychange", () => {
    void checkVersion("visibilitychange");
  });
  window.addEventListener("focus", () => {
    void checkVersion("focus");
  });
  // Initial check after load to catch tabs restored from bfcache.
  window.setTimeout(() => void checkVersion("initial"), 2_000);
  if (pollIntervalId === null) {
    pollIntervalId = window.setInterval(() => {
      void checkVersion("poll");
    }, POLL_INTERVAL_MS);
  }
}
