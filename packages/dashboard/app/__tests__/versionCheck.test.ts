/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isStaleChunkError,
  handleChunkLoadError,
  reloadOnce,
  checkVersion,
  installVersionCheck,
  consumeVersionUpdateFlag,
  _resetCheckState,
  _resetState,
  MIN_CHECK_INTERVAL_MS,
  POLL_INTERVAL_MS,
  VERSION_FETCH_TIMEOUT_MS,
  requestVersionCheck,
  _resetMismatchState,
} from "../versionCheck";
import { clearTraces, getTraces } from "../utils/dashboardTraceBuffer";

// Mock __BUILD_VERSION__ (declared as const in the module)
vi.stubGlobal("__BUILD_VERSION__", "test-build-abc123");

function versionResponseFor(version: string) {
  return {
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve({ version }),
  };
}

function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("isStaleChunkError", () => {
  it("returns true for known chunk error patterns", () => {
    expect(isStaleChunkError(new Error("Failed to fetch dynamically imported module: ./foo.js"))).toBe(true);
    expect(isStaleChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError(new Error("Importing a module script failed"))).toBe(true);
    expect(isStaleChunkError(new Error("text/html is not a valid JavaScript MIME type"))).toBe(true);
    expect(isStaleChunkError(new Error("ChunkLoadError: loading chunk foo failed"))).toBe(true);
    expect(
      isStaleChunkError(new Error("Unable to preload CSS for /assets/AgentDetailView-BrlYt0xn.css")),
    ).toBe(true);
    expect(
      isStaleChunkError(new Error("Unable to preload module for /assets/foo.js")),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isStaleChunkError(new Error("Network request failed"))).toBe(false);
    expect(isStaleChunkError(new Error("TypeError: Cannot read property"))).toBe(false);
    expect(isStaleChunkError("some random string")).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
    expect(isStaleChunkError(undefined)).toBe(false);
  });
});

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
FN-516 replaced the old contract asserted here ("a recognized chunk message reloads the page"). A
failed dynamic import is a common transient and was reloading pages whose build had not moved, so it
now only REQUESTS the same bounded check every other trigger uses. Recognition itself is unchanged
because ErrorBoundary.componentDidCatch still branches on the boolean.
*/
describe("handleChunkLoadError", () => {
  const reloadSpy = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetCheckState();
    clearTraces();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes a chunk error but does not reload on the message alone", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "test-build-abc123" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const result = handleChunkLoadError(new Error("Failed to fetch dynamically imported module: ./foo.js"));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    expect(result).toBe(true);
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
  });

  it("does not reload when the version cannot be read at all", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);

    expect(handleChunkLoadError(new Error("ChunkLoadError: loading chunk foo failed"))).toBe(true);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("returns false for non-chunk errors and requests nothing", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = handleChunkLoadError(new Error("Network error"));

    expect(result).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("reloadOnce", () => {
  const reloadSpy = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    // FN-516 added an in-memory document latch alongside the session flag, so a fresh
    // "document" has to be modelled explicitly and not by clearing storage alone.
    _resetCheckState();
  });

  it("sets sessionStorage flag and calls window.location.reload()", () => {
    reloadOnce("test reason");
    expect(window.sessionStorage.getItem("fusion:version-reload")).toBe("1");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate calls", () => {
    reloadOnce("first");
    reloadOnce("second");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});

describe("consumeVersionUpdateFlag", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("returns true once then false (consumes the flag)", () => {
    window.sessionStorage.setItem("fusion:version-update", "1");
    expect(consumeVersionUpdateFlag()).toBe(true);
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  it("returns false when flag is not set", () => {
    expect(consumeVersionUpdateFlag()).toBe(false);
  });
});

describe("checkVersion cooldown + mismatch gating", () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetCheckState();
    _resetMismatchState();
    clearTraces();
    // Ensure tab is visible
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("respects MIN_CHECK_INTERVAL_MS — second call within cooldown is suppressed", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "different-version" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    // First call should go through
    await checkVersion();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call immediately after — should be suppressed by cooldown
    await checkVersion();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows check after cooldown elapses", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "different-version" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Advance time past cooldown
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);

    await checkVersion();
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("does not reload when remote version matches build version", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "test-build-abc123" }), // matches stub __BUILD_VERSION__
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion();
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does not reload when fetch returns null", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      headers: new Headers(),
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion();
    expect(reloadSpy).not.toHaveBeenCalled();
    expect(getTraces().some((t) => t.event === "remote-unavailable")).toBe(true);
  });

  it("single mismatch pushes trace and does not reload", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "different-version" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("focus");

    expect(reloadSpy).not.toHaveBeenCalled();
    const mismatchTrace = getTraces().find((t) => t.event === "mismatch");
    expect(mismatchTrace?.detail).toMatchObject({ trigger: "focus", remote: "different-version" });
    expect(getTraces().some((t) => t.event === "mismatch-pending")).toBe(true);
  });

  it("reloads once after two consecutive identical mismatches", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "different-version" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("visibilitychange");

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not reload repeatedly for the same remote version after returning to the tab", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "different-version" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("visibilitychange");
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    window.sessionStorage.removeItem("fusion:version-reload");

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("focus");

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    const suppressedTrace = getTraces().find((entry) => entry.event === "reload-suppressed");
    expect(suppressedTrace?.detail).toMatchObject({
      remote: "different-version",
      reason: "already-reloaded-remote-version",
    });
    vi.useRealTimers();
  });

  it("mismatch then match resets gating", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ version: "different-version" }) })
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ version: "test-build-abc123" }) })
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ version: "different-version" }) })
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ version: "different-version" }) });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("focus");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("focus");
    expect(reloadSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("focus");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("captures trigger source in mismatch traces", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn()
      .mockResolvedValue({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ version: "different-version" }) });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("visibilitychange");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    _resetMismatchState();
    await checkVersion("focus");

    const mismatchTriggers = getTraces()
      .filter((entry) => entry.event === "mismatch")
      .map((entry) => entry.detail.trigger);
    expect(mismatchTriggers).toEqual(expect.arrayContaining(["initial", "visibilitychange", "focus"]));
    vi.useRealTimers();
  });
});

describe("installVersionCheck periodic polling", () => {
  const reloadSpy = vi.fn();

  function versionResponse(version: string) {
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version }),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetState();
    clearTraces();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    _resetState();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sets up a periodic interval that calls checkVersion with the poll trigger", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(versionResponse("test-build-abc123"))
      .mockResolvedValueOnce(versionResponse("different-version"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    clearTraces();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 2_000);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const mismatchTrace = getTraces().find((entry) => entry.event === "mismatch");
    expect(mismatchTrace?.detail).toMatchObject({ trigger: "poll", remote: "different-version" });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("polling detects a confirmed version mismatch and triggers reload", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(versionResponse("test-build-abc123"))
      .mockResolvedValueOnce(versionResponse("different-version"))
      .mockResolvedValueOnce(versionResponse("different-version"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(reloadSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem("fusion:version-update")).toBe("1");
    const confirmedTrace = getTraces().find((entry) => entry.event === "mismatch-confirmed");
    expect(confirmedTrace?.detail).toMatchObject({ trigger: "poll", remote: "different-version" });
  });

  it("cleans up the polling interval when state is reset", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    _resetState();
    fetchSpy.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("polling respects MIN_CHECK_INTERVAL_MS cooldown", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // initial check

    await checkVersion("focus");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("mandatory auto-reload", () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetState();
    _resetCheckState();
    clearTraces();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    _resetState();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ignores a legacy opt-out payload without requesting settings", async () => {
    const fetchSpy = vi.fn((input: string) => {
      if (input.includes("/api/settings")) {
        return Promise.resolve({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ autoReloadOnVersionChange: false }) });
      }
      return Promise.resolve({ ok: true, headers: new Headers({ "content-type": "application/json" }), json: () => Promise.resolve({ version: "different-version" }) });
    });
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes("/api/settings"))).toBe(false);
  });

  /*
  FNXC:VersionAutoReload 2026-09-18-00:20:
  Replaces "reloads for service-worker activation and stale chunks". Those two paths no longer carry
  their own reload authority — that is the FN-516 defect. They route through the shared proof, so with
  the served build unchanged they must produce a check and nothing else.
  */
  it("treats a worker activation and a stale chunk as reasons to check, not to reload", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    await requestVersionCheck("service-worker");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(reloadSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    expect(handleChunkLoadError(new Error("ChunkLoadError: loading chunk foo failed"))).toBe(true);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
  });

  it("still reloads once when a worker-triggered check confirms a different build", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    await requestVersionCheck("service-worker");
    expect(reloadSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await requestVersionCheck("service-worker");

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(consumeVersionUpdateFlag()).toBe(true);
    expect(consumeVersionUpdateFlag()).toBe(false);
  });

  it("retains the session and remote-version loop protection", async () => {
    reloadOnce("first reload");
    reloadOnce("duplicate reload");
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    window.sessionStorage.clear();
    reloadSpy.mockClear();
    window.sessionStorage.setItem("fusion:version-reloaded-remote", "different-version");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ version: "different-version" }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion();
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion();

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(getTraces().some((entry) => entry.event === "reload-suppressed")).toBe(true);
  });
});

/*
FNXC:VersionAutoReload 2026-09-18-00:20:
FN-516 hardening of the read and of the admission. The reported symptom was a page reloading itself
with nothing deployed, so every state that could manufacture a "different build" out of nothing gets a
case here: a stale answer, an invalid answer, a slow answer, a late answer, and a concurrent burst.
*/
describe("version read hardening", () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetState();
    clearTraces();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  afterEach(() => {
    _resetState();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("asks for the live document with no-store and a unique per-attempt key", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("focus");

    const urls = fetchSpy.mock.calls.map(([url]: [string]) => String(url));
    expect(urls).toHaveLength(2);
    for (const url of urls) expect(url.startsWith("/version.json")).toBe(true);
    expect(new Set(urls).size).toBe(2);
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });

  it("never lets an old body replayed for a reused key become a confirmation", async () => {
    // Models the pre-fix worker: it answers the FIRST key it ever saw from its own cache.
    const cached = new Map<string, string>();
    const fetchSpy = vi.fn(async (url: string) => {
      if (!cached.has(String(url))) cached.set(String(url), "build-A-stale");
      return versionResponseFor(cached.get(String(url))!);
    });
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");

    // A per-attempt key means the second read cannot reuse the first entry.
    expect(new Set(fetchSpy.mock.calls.map(([url]: [string]) => String(url))).size).toBe(2);
    expect(cached.size).toBe(2);
  });

  it.each([
    ["a non-OK status", { ok: false, headers: new Headers(), json: () => Promise.resolve({}) }],
    [
      "a non-JSON content type",
      {
        ok: true,
        headers: new Headers({ "content-type": "text/html" }),
        json: () => Promise.resolve({ version: "build-C" }),
      },
    ],
    [
      "invalid JSON",
      {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      },
    ],
    [
      "a missing version",
      {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      },
    ],
    [
      "a blank version",
      {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ version: "   " }),
      },
    ],
    [
      "a non-string version",
      {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ version: 42 }),
      },
    ],
    [
      "a null version",
      {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ version: null }),
      },
    ],
  ])("treats %s as no evidence and never reloads", async (_label, response) => {
    const fetchSpy = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
    expect(getTraces().some((entry) => entry.event === "remote-unavailable")).toBe(true);
  });

  it("breaks a confirmation in progress when the next read is unreadable", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(versionResponseFor("build-C"))
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");

    // Three reads saw build-C twice, but not consecutively.
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("does not accept two alternating targets as a confirmation", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(versionResponseFor("build-C"))
      .mockResolvedValueOnce(versionResponseFor("build-D"))
      .mockResolvedValueOnce(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    for (let i = 0; i < 3; i += 1) {
      await checkVersion("poll");
      vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    }

    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("reloads for a rollback exactly like a roll-forward (identifiers are opaque)", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("aaa-older-build"));
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("abandons a hung read at the deadline instead of wedging the checker forever", async () => {
    let abortedCount = 0;
    const fetchSpy = vi.fn(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            abortedCount += 1;
            reject(new Error("aborted"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const hung = checkVersion("initial");
    await vi.advanceTimersByTimeAsync(VERSION_FETCH_TIMEOUT_MS + 1);
    await hung;

    expect(abortedCount).toBe(1);
    expect(reloadSpy).not.toHaveBeenCalled();

    // The checker is usable again: a later poll performs a real read.
    fetchSpy.mockImplementation(async () => versionResponseFor("test-build-abc123"));
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not let a late settlement of an invalidated read reload or unlock a newer one", async () => {
    let releaseHung: ((value: unknown) => void) | null = null;
    const fetchSpy = vi.fn(
      () =>
        new Promise((resolve) => {
          releaseHung = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const hung = checkVersion("initial");
    await vi.advanceTimersByTimeAsync(VERSION_FETCH_TIMEOUT_MS + 1);

    // A reset invalidates the generation the hung read belongs to.
    _resetState();
    fetchSpy.mockImplementation(async () => versionResponseFor("test-build-abc123"));
    await checkVersion("poll");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // The late settlement of the old read must change nothing.
    releaseHung?.(versionResponseFor("build-C"));
    await hung;
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("discards a response that arrives after the tab went hidden and came back", async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);

    setVisibility("hidden");
    setVisibility("visible");

    resolveFirst?.(versionResponseFor("build-C"));
    await vi.advanceTimersByTimeAsync(0);

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(getTraces().some((entry) => entry.event === "result-discarded")).toBe(true);
  });

  it("still detects a later deployment after a read settled while the tab was hidden", async () => {
    // Regression: a read pending when the tab is backgrounded used to keep the single in-flight slot
    // forever, so every later trigger became a no-op and no deployment was ever detected again.
    let resolveFirst: ((value: unknown) => void) | null = null;
    const fetchSpy = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    // Only the version reads matter here; unrelated diagnostics posts share the fetch spy.
    const versionReads = (): number =>
      fetchSpy.mock.calls.filter((call) => String(call[0]).startsWith("/version.json")).length;

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(versionReads()).toBe(1);

    setVisibility("hidden");
    // The read settles while the generation it belonged to is already superseded.
    resolveFirst?.(versionResponseFor("test-build-abc123"));
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);

    // The slot must be free again: the next trigger issues a real network read.
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(versionReads()).toBe(2);
    expect(reloadSpy).not.toHaveBeenCalled();

    // And a genuine change still admits exactly one reload after its second observation.
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(versionReads()).toBe(3);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps at most one read in flight under a concurrent burst", async () => {
    let resolveRead: ((value: unknown) => void) | null = null;
    const fetchSpy = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const all = Promise.all([
      checkVersion("poll"),
      checkVersion("focus"),
      requestVersionCheck("service-worker"),
      requestVersionCheck("chunk-error"),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    resolveRead?.(versionResponseFor("test-build-abc123"));
    await all;
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("reloads at most once per document even when triggers keep firing", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    // Even with the session flag cleared (installVersionCheck clears it after a good render),
    // the in-memory document latch keeps this document from asking twice.
    window.sessionStorage.removeItem("fusion:version-reload");
    for (const trigger of ["poll", "focus", "service-worker", "chunk-error"] as const) {
      vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
      await requestVersionCheck(trigger);
    }

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("survives a sessionStorage that throws on every operation", async () => {
    const storageError = new Error("storage disabled");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw storageError;
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw storageError;
    });
    const removeItem = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw storageError;
    });

    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");
    expect(reloadSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(consumeVersionUpdateFlag()).toBe(false);

    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it("installs its listeners and poll once, and a reset really removes them", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    _resetState();
    fetchSpy.mockClear();
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    // Other modules share the global fetch stub, so assert on version reads specifically.
    const versionReads = fetchSpy.mock.calls.filter(([url]: [string]) =>
      String(url).startsWith("/version.json"),
    );
    expect(versionReads).toHaveLength(0);
  });

  it("does not write the update marker for a suppressed reload", async () => {
    window.sessionStorage.setItem("fusion:version-reloaded-remote", "build-C");
    const fetchSpy = vi.fn().mockResolvedValue(versionResponseFor("build-C"));
    vi.stubGlobal("fetch", fetchSpy);

    await checkVersion("initial");
    vi.advanceTimersByTime(MIN_CHECK_INTERVAL_MS + 1);
    await checkVersion("poll");

    expect(reloadSpy).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("fusion:version-update")).toBeNull();
  });
});
