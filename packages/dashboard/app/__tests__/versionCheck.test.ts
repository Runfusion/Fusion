/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isStaleChunkError,
  handleChunkLoadError,
  reloadOnce,
  checkVersion,
  consumeVersionUpdateFlag,
  _resetCheckState,
  MIN_CHECK_INTERVAL_MS,
} from "../versionCheck";

// Mock __BUILD_VERSION__ (declared as const in the module)
vi.stubGlobal("__BUILD_VERSION__", "test-build-abc123");

describe("isStaleChunkError", () => {
  it("returns true for known chunk error patterns", () => {
    expect(isStaleChunkError(new Error("Failed to fetch dynamically imported module: ./foo.js"))).toBe(true);
    expect(isStaleChunkError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isStaleChunkError(new Error("Importing a module script failed"))).toBe(true);
    expect(isStaleChunkError(new Error("text/html is not a valid JavaScript MIME type"))).toBe(true);
    expect(isStaleChunkError(new Error("ChunkLoadError: loading chunk foo failed"))).toBe(true);
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

describe("checkVersion cooldown", () => {
  const reloadSpy = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("location", { reload: reloadSpy });
    window.sessionStorage.clear();
    reloadSpy.mockClear();
    _resetCheckState();
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
  });
});
