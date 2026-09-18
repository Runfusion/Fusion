import { pushTrace } from "./utils/dashboardTraceBuffer";

declare const __BUILD_VERSION__: string;

const RELOAD_FLAG = "fusion:version-reload";
const VERSION_UPDATE_FLAG = "fusion:version-update";
const RELOADED_REMOTE_VERSION_FLAG = "fusion:version-reloaded-remote";

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
FN-516 contract for the automatic page reload, in one place because the defect was that three
different paths could each reach `location.reload()` on their own evidence.

A reload is admitted ONLY when the checker has read a valid, live build identifier that differs from
the running one, TWICE in a row, from two separate reads. Nothing else is evidence:
- a service-worker activation is a REASON TO LOOK, never a confirmation (the worker can activate for a
  cache-policy change, a retry, or a claim on a page whose build never moved);
- a dynamic-import failure is a REASON TO LOOK, never a confirmation (a chunk can fail on a flaky
  radio while the deployed build is unchanged);
- an unreadable, failed, malformed, or slow read is NO evidence at all and breaks any confirmation in
  progress, rather than counting toward one.

The identifier is compared OPAQUELY. It carries a Git prefix and is not ordered, so a rollback is a
legitimate "different build" and must reload exactly like a roll-forward. There is deliberately no
greater/less-than comparison anywhere in this file.

Four independent loop protections are retained: the session flag, the already-reloaded remote target,
the two-observation confirmation, and the visibility/cadence gates. None of them is an opt-out: a real
deployment still reloads the page automatically.
*/

/** Bound on a single version read. A transport that ignores abort must not hold the checker forever. */
export const VERSION_FETCH_TIMEOUT_MS = 10_000;

export const MIN_CHECK_INTERVAL_MS = 60_000; // 1 minute
export const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes

export type VersionCheckTrigger =
  | "visibilitychange"
  | "focus"
  | "initial"
  | "poll"
  | "service-worker"
  | "chunk-error";

let lastCheckTime = 0;
let checkInFlight = false;
/*
FNXC:VersionAutoReload 2026-09-18-05:28:
Ownership token for the single in-flight read slot, deliberately separate from the generation fence.
The two answer different questions and conflating them wedged update detection: `generation` answers
"may this result MEAN anything?" and is bumped whenever the tab goes hidden, while this token answers
"whose slot is it to release?". Releasing on generation equality meant a read still pending when the
tab was backgrounded never released the slot — `checkInFlight` stayed true for the life of the
document, so every later poll, focus, visibility, controllerchange, and chunk-error trigger returned
immediately and a real deployment was never detected again.

A newer read can only have claimed the slot if this one already released it, so token equality is
exactly the "I still own it" condition: a stale settle after a reset cannot unlock a newer read, and a
discarded (hidden/superseded) read still frees the slot for the next trigger.
*/
let readTokenSeq = 0;
let activeReadToken: number | null = null;
let lastMismatchedRemote: string | null = null;
let lastMismatchAt = 0;
let pollIntervalId: number | null = null;
let fetchAttempt = 0;

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
Generation fence. A read that was started under an earlier generation must never admit a reload, seed a
confirmation, or release the in-flight slot of a NEWER read. The generation is bumped by the test reset
hooks and by the tab going hidden, so a response that arrives after the user left and came back is
discarded instead of being treated as a fresh observation.
*/
let generation = 0;

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
Document-lifetime reload lock, held in memory rather than in sessionStorage. `installVersionCheck`
deliberately clears the session flag five seconds after a successful render (so a later, genuine deploy
can reload again), which means the session flag alone cannot prove "this document already asked to
reload". The in-memory latch can, and it is what keeps a burst of poll/focus/worker/chunk triggers from
producing a second reload request. It also survives a sessionStorage that throws.
*/
let reloadRequested = false;

type InstalledListeners = {
  visibility: () => void;
  focus: () => void;
  timeouts: number[];
};
let installed: InstalledListeners | null = null;

function safeSessionGet(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // ignore (e.g. storage disabled or quota exceeded)
  }
}

function safeSessionRemove(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** Exported for testing — resets internal state and clears installed polling/listeners. */
export function _resetState(): void {
  lastCheckTime = 0;
  checkInFlight = false;
  activeReadToken = null;
  reloadRequested = false;
  generation += 1;
  safeSessionRemove(RELOADED_REMOTE_VERSION_FLAG);
  if (pollIntervalId !== null) {
    window.clearInterval(pollIntervalId);
    pollIntervalId = null;
  }
  if (installed) {
    document.removeEventListener("visibilitychange", installed.visibility);
    window.removeEventListener("focus", installed.focus);
    for (const id of installed.timeouts) window.clearTimeout(id);
    installed = null;
  }
  _resetMismatchState();
}

/** Exported for testing — resets internal cooldown state */
export function _resetCheckState(): void {
  lastCheckTime = 0;
  checkInFlight = false;
  activeReadToken = null;
  reloadRequested = false;
  generation += 1;
  _resetMismatchState();
}

export function _resetMismatchState(): void {
  lastMismatchedRemote = null;
  lastMismatchAt = 0;
}

export function consumeVersionUpdateFlag(): boolean {
  if (safeSessionGet(VERSION_UPDATE_FLAG)) {
    safeSessionRemove(VERSION_UPDATE_FLAG);
    return true;
  }
  return false;
}

export function reloadOnce(reason: string): void {
  const alreadySet = Boolean(safeSessionGet(RELOAD_FLAG));
  pushTrace("versionCheck", "reload-attempt", { reason, alreadySet, alreadyRequested: reloadRequested });
  if (alreadySet || reloadRequested) {
    console.warn("[versionCheck] reload already attempted, suppressing", reason);
    return;
  }
  reloadRequested = true;
  safeSessionSet(RELOAD_FLAG, "1");
  /*
   FNXC:VersionAutoReload 2026-08-23-04:03 (amended 2026-09-18-00:20):
   Reloading after a CONFIRMED version change is mandatory with no operator opt-out. The session flag,
   the in-memory document latch, and the per-remote-version flag prevent loops; they do not disable the
   behavior. What changed in FN-516 is the admission upstream, not this primitive: callers must prove a
   different live build before they get here.
  */
  console.info("[versionCheck] reloading:", reason);
  window.location.reload();
}

function getReloadedRemoteVersion(): string | null {
  return safeSessionGet(RELOADED_REMOTE_VERSION_FLAG);
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

/**
 * FNXC:VersionAutoReload 2026-09-18-00:20:
 * Recognition stays synchronous and the boolean contract is unchanged, because
 * `ErrorBoundary.componentDidCatch` branches on it. What changed is the consequence: a recognized
 * stale-chunk message now REQUESTS a bounded version check instead of reloading on the strength of an
 * error string. A failed dynamic import is a common transient (flaky radio, aborted navigation,
 * proxy hiccup) and was reloading pages whose build had not moved.
 *
 * The check belongs to the document, exactly like the periodic poll — it is deliberately fire-and-
 * forget here so no asynchronous callback writes into a React boundary that may already be unmounted.
 * With no confirmed difference the boundary keeps the error, its diagnostics, and its manual actions.
 */
export function handleChunkLoadError(error: unknown): boolean {
  if (!isStaleChunkError(error)) return false;
  pushTrace("versionCheck", "chunk-error-check-requested", {
    recognized: true,
  });
  void checkVersion("chunk-error");
  return true;
}

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
Reading the live identifier. Three hardening points, all of which the reported symptom needed:

1. A unique, non-sensitive query parameter per attempt. `cache: "no-store"` and the server's
   `Cache-Control: no-store` are both correct and both bypassable by an OLD service worker that is
   still controlling this page and answers from Cache Storage. A per-attempt URL cannot hit such an
   entry. The current worker never caches this URL at all (see public/sw.js), so nothing accumulates.
2. An explicit deadline with AbortController. Without it a hung response holds `checkInFlight` for the
   lifetime of the document and silently disables update detection.
3. Strict validation. A non-OK status, a non-JSON content type, invalid JSON, a missing/blank/
   non-string `version` are all "no evidence" — never a new target.
*/
async function fetchRemoteVersion(): Promise<string | null> {
  fetchAttempt += 1;
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timeoutId: number | null = null;
  if (controller) {
    timeoutId = window.setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);
  }
  try {
    const res = await fetch(`/version.json?fusion_vc=${fetchAttempt}`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    const data = (await res.json()) as { version?: unknown };
    if (typeof data.version !== "string") return null;
    const version = data.version.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  }
}

export async function checkVersion(trigger: VersionCheckTrigger = "initial"): Promise<void> {
  if (checkInFlight || document.visibilityState !== "visible") return;
  if (Date.now() - lastCheckTime < MIN_CHECK_INTERVAL_MS) return;
  lastCheckTime = Date.now();
  checkInFlight = true;
  readTokenSeq += 1;
  const readToken = readTokenSeq;
  activeReadToken = readToken;
  const startedGeneration = generation;
  try {
    const remote = await fetchRemoteVersion();

    /*
    FNXC:VersionAutoReload 2026-09-18-00:20:
    Settle-time fence, evaluated BEFORE the result is allowed to mean anything. A response belonging to
    a superseded generation (reset, or the tab having gone hidden mid-flight) is discarded whole: it
    cannot reload, cannot seed or confirm a mismatch, and cannot clear one either.
    */
    if (startedGeneration !== generation || document.visibilityState !== "visible") {
      pushTrace("versionCheck", "result-discarded", {
        trigger,
        reason: startedGeneration !== generation ? "superseded" : "not-visible",
      });
      return;
    }

    if (remote === null) {
      pushTrace("versionCheck", "remote-unavailable", {
        trigger,
        visibilityState: document.visibilityState,
      });
      // No evidence breaks any confirmation in progress rather than counting toward one.
      lastMismatchedRemote = null;
      return;
    }

    if (remote === __BUILD_VERSION__) {
      lastMismatchedRemote = null;
      safeSessionRemove(RELOADED_REMOTE_VERSION_FLAG);
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

    /*
    FNXC:VersionAutoReload 2026-09-18-00:20:
    Admission and markers are ONE synchronous section with no await between the last check and the
    reload request. `fusion:version-update` is what tells DashboardLoader to drop its hydration caches,
    so it is written only for a request that is actually admitted: a suppressed or discarded check must
    never announce an update that did not happen. The document latch is consulted HERE rather than at
    the top of the function so a suppressed outcome is still observable in the traces.
    */
    if (reloadRequested || safeSessionGet(RELOAD_FLAG)) {
      pushTrace("versionCheck", "reload-suppressed", {
        remote,
        trigger,
        reason: "document-already-requested-reload",
      });
      return;
    }

    safeSessionSet(RELOADED_REMOTE_VERSION_FLAG, remote);
    safeSessionSet(VERSION_UPDATE_FLAG, "1");
    reloadOnce(`build version changed: ${__BUILD_VERSION__} -> ${remote}`);
  } finally {
    /*
    FNXC:VersionAutoReload 2026-09-18-05:28:
    Only the read that still OWNS the slot releases it. A stale `finally` running after a reset must not
    unlock a newer in-flight read (two concurrent reads would turn one observation into two), but a read
    whose result was discarded because the tab went hidden must still hand the slot back — otherwise the
    checker is wedged permanently and never sees the next deployment.
    */
    if (activeReadToken === readToken) {
      checkInFlight = false;
      activeReadToken = null;
    }
  }
}

/**
 * FNXC:VersionAutoReload 2026-09-18-00:20:
 * The seam service-worker activation and chunk-load recovery use. It is intentionally the SAME
 * `checkVersion` admission — same cooldown, same visibility gate, same two-observation confirmation —
 * so an event that merely suggests "something may have been deployed" cannot short-circuit the proof
 * or exempt itself from the cadence.
 */
export function requestVersionCheck(trigger: VersionCheckTrigger): Promise<void> {
  return checkVersion(trigger);
}

/**
 * Install production version-change detection.
 *
 * The checker runs on initial load, tab visibility/focus events, and a
 * lightweight periodic poll so foreground tabs detect newly deployed bundles
 * even when the user never switches away. `checkVersion()` applies visibility
 * and cooldown guards, so the interval does not fetch for hidden tabs or more
 * frequently than the minimum check interval.
 *
 * FNXC:VersionAutoReload 2026-09-18-00:20: installed exactly once. A repeated call must not stack
 * duplicate listeners or intervals, and `_resetState()` really removes what was installed.
 */
export function installVersionCheck(): void {
  if (!import.meta.env.PROD) return;
  if (installed) return;

  const visibility = (): void => {
    if (document.visibilityState !== "visible") {
      // Leaving the tab invalidates any read in flight; its answer describes a moment the user is no
      // longer in, and must not become one of the two observations.
      generation += 1;
      return;
    }
    void checkVersion("visibilitychange");
  };
  const focus = (): void => {
    void checkVersion("focus");
  };

  // Clear stale flag once a fresh page has rendered successfully.
  const clearFlagTimeout = window.setTimeout(() => safeSessionRemove(RELOAD_FLAG), 5_000);
  // Initial check after load to catch tabs restored from bfcache.
  const initialTimeout = window.setTimeout(() => void checkVersion("initial"), 2_000);

  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("focus", focus);
  installed = { visibility, focus, timeouts: [clearFlagTimeout, initialTimeout] };

  if (pollIntervalId === null) {
    pollIntervalId = window.setInterval(() => {
      void checkVersion("poll");
    }, POLL_INTERVAL_MS);
  }
}
