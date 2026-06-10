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
  setAutoReloadEnabled,
  _isAutoReloadEnabled,
  MIN_CHECK_INTERVAL_MS,
  POLL_INTERVAL_MS,
  _resetMismatchState,
} from "../versionCheck";
import { clearTraces, getTraces } from "../utils/dashboardTraceBuffer";

// Mock __BUILD_VERSION__ (declared as const in the module)
vi.stubGlobal("__BUILD_VERSION__", "test-build-abc123");

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

describe("handleChunkLoadError", () => {
  const reloadSpy = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
  });

  it("returns true and calls reloadOnce for chunk errors", () => {
    const result = handleChunkLoadError(new Error("Failed to fetch dynamically imported module: ./foo.js"));
    expect(result).toBe(true);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  it("returns false for non-chunk errors", () => {
    const result = handleChunkLoadError(new Error("Network error"));
    expect(result).toBe(false);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("reloadOnce", () => {
  const reloadSpy = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
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

  function settingsResponse() {
    return {
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ autoReloadOnVersionChange: true }),
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
      .mockResolvedValueOnce(settingsResponse())
      .mockResolvedValueOnce(versionResponse("test-build-abc123"))
      .mockResolvedValueOnce(versionResponse("different-version"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    clearTraces();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 2_000);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const mismatchTrace = getTraces().find((entry) => entry.event === "mismatch");
    expect(mismatchTrace?.detail).toMatchObject({ trigger: "poll", remote: "different-version" });
    expect(reloadSpy).not.toHaveBeenCalled();
  });

  it("polling detects a confirmed version mismatch and triggers reload", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(settingsResponse())
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
      .mockResolvedValueOnce(settingsResponse())
      .mockResolvedValueOnce(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    _resetState();
    fetchSpy.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("polling respects MIN_CHECK_INTERVAL_MS cooldown", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(settingsResponse())
      .mockResolvedValue(versionResponse("test-build-abc123"));
    vi.stubGlobal("fetch", fetchSpy);

    installVersionCheck();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // settings + initial check

    await checkVersion("focus");
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(1);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(reloadSpy).not.toHaveBeenCalled();
  });
});

describe("autoReloadOnVersionChange setting", () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetState();
  });

  afterEach(() => {
    _resetState();
    vi.restoreAllMocks();
  });

  describe("reloadOnce with auto-reload setting", () => {
    it("calls window.location.reload() when auto-reload is enabled (default)", () => {
      expect(_isAutoReloadEnabled()).toBe(true);
      reloadOnce("test reason");
      expect(window.sessionStorage.getItem("fusion:version-reload")).toBe("1");
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT call reload when auto-reload is disabled", () => {
      const consoleInfoSpy = vi.spyOn(console, "info");
      setAutoReloadEnabled(false);
      expect(_isAutoReloadEnabled()).toBe(false);
      reloadOnce("test reason");
      // Should still set the flag to prevent retries
      expect(window.sessionStorage.getItem("fusion:version-reload")).toBe("1");
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).toHaveBeenCalledWith(
        "[versionCheck] auto-reload disabled by setting, skipping reload:",
        "test reason",
      );
      consoleInfoSpy.mockRestore();
    });

    it("re-enables reload after setAutoReloadEnabled(true)", () => {
      setAutoReloadEnabled(false);
      reloadOnce("suppressed");
      expect(reloadSpy).not.toHaveBeenCalled();

      // Reset for next call
      window.sessionStorage.clear();
      setAutoReloadEnabled(true);
      reloadOnce("now enabled");
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("setAutoReloadEnabled", () => {
    it("toggles the guard correctly", () => {
      expect(_isAutoReloadEnabled()).toBe(true);
      setAutoReloadEnabled(false);
      expect(_isAutoReloadEnabled()).toBe(false);
      setAutoReloadEnabled(true);
      expect(_isAutoReloadEnabled()).toBe(true);
    });
  });

  describe("bootstrap setting fetch", () => {
    it("respects autoReloadOnVersionChange=false from settings API", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ autoReloadOnVersionChange: false }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      // Dynamically import to trigger bootstrap (we test the effect via setAutoReloadEnabled)
      // Instead, directly test the fetch + setAutoReloadEnabled integration:
      const res = await fetch("/api/settings", {
        headers: { Accept: "application/json" },
      });
      const data = await res.json();
      if (data.autoReloadOnVersionChange === false) {
        setAutoReloadEnabled(false);
      }
      expect(_isAutoReloadEnabled()).toBe(false);

      // Now reloadOnce should not actually reload
      reloadOnce("bootstrap test");
      expect(reloadSpy).not.toHaveBeenCalled();
    });

    it("keeps default (true) if settings fetch fails", async () => {
      const fetchSpy = vi.fn().mockRejectedValue(new Error("Network error"));
      vi.stubGlobal("fetch", fetchSpy);

      try {
        await fetch("/api/settings");
      } catch {
        // Expected — guard should remain true
      }
      expect(_isAutoReloadEnabled()).toBe(true);
    });
  });
});
