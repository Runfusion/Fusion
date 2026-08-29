import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GITHUB_STAR_CACHE_KEY,
  GITHUB_STAR_CACHE_TTL_MS,
  useGitHubStarCount,
} from "../SettingsModal";

const NOW = new Date("2026-07-16T08:00:00.000Z").valueOf();

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
}

function writeCache(count: number, fetchedAt = Date.now()): void {
  localStorage.setItem(GITHUB_STAR_CACHE_KEY, JSON.stringify({ count, fetchedAt }));
}

function response(stargazers_count: unknown, ok = true): Response {
  return { ok, json: vi.fn().mockResolvedValue({ stargazers_count }) } as unknown as Response;
}

describe("useGitHubStarCount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubGlobal("fetch", vi.fn());
    localStorage.clear();
    setDocumentHidden(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fetches and updates when no cache exists", async () => {
    vi.mocked(fetch).mockResolvedValue(response(123));
    const { result } = renderHook(() => useGitHubStarCount());

    expect(result.current).toBeNull();
    await act(async () => {});
    expect(result.current).toBe(123);
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/Runfusion/Fusion", { cache: "no-store" });
  });

  it("shows a stale cache value before refreshing it", async () => {
    writeCache(100, NOW - GITHUB_STAR_CACHE_TTL_MS - 1);
    let resolveFetch: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const { result } = renderHook(() => useGitHubStarCount());
    expect(result.current).toBe(100);
    expect(fetch).toHaveBeenCalledTimes(1);

    await act(async () => resolveFetch?.(response(200)));
    expect(result.current).toBe(200);
  });

  it("does not fetch a fresh cache on mount or visibility restoration", () => {
    writeCache(100);
    renderHook(() => useGitHubStarCount());
    expect(fetch).not.toHaveBeenCalled();

    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits while hidden and refreshes a cache that became stale on foreground", async () => {
    writeCache(100);
    setDocumentHidden(true);
    vi.mocked(fetch).mockResolvedValue(response(200));
    const { result } = renderHook(() => useGitHubStarCount());

    await act(async () => { await vi.advanceTimersByTimeAsync(GITHUB_STAR_CACHE_TTL_MS + 1); });
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current).toBe(100);

    setDocumentHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {});
    expect(result.current).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refreshes at most once per bounded interval and prevents overlapping requests", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(100));
    const { result } = renderHook(() => useGitHubStarCount());
    await act(async () => {});
    expect(result.current).toBe(100);

    vi.setSystemTime(NOW + GITHUB_STAR_CACHE_TTL_MS + 1);
    let resolveFetch: ((value: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(GITHUB_STAR_CACHE_TTL_MS); });
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => resolveFetch?.(response(200)));
    expect(result.current).toBe(200);
    await act(async () => { await vi.advanceTimersByTimeAsync(GITHUB_STAR_CACHE_TTL_MS); });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves stale cache and retries after failed or malformed responses", async () => {
    writeCache(100, NOW - GITHUB_STAR_CACHE_TTL_MS - 1);
    vi.mocked(fetch).mockResolvedValueOnce(response(0, false)).mockResolvedValueOnce(response("invalid"));
    const { result } = renderHook(() => useGitHubStarCount());

    await act(async () => {});
    expect(result.current).toBe(100);
    expect(JSON.parse(localStorage.getItem(GITHUB_STAR_CACHE_KEY) ?? "{}")).toEqual({ count: 100, fetchedAt: NOW - GITHUB_STAR_CACHE_TTL_MS - 1 });

    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(localStorage.getItem(GITHUB_STAR_CACHE_KEY) ?? "{}")).toEqual({ count: 100, fetchedAt: NOW - GITHUB_STAR_CACHE_TTL_MS - 1 });

    vi.mocked(fetch).mockResolvedValueOnce(response(200));
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {});
    expect(result.current).toBe(200);
  });

  it("cleans up its timer and visibility listener on unmount", async () => {
    writeCache(100);
    const { unmount } = renderHook(() => useGitHubStarCount());
    unmount();

    vi.setSystemTime(NOW + GITHUB_STAR_CACHE_TTL_MS + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(GITHUB_STAR_CACHE_TTL_MS * 2); });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetch).not.toHaveBeenCalled();
  });
});
