import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("../../api", () => ({
  api: vi.fn(),
}));

import { api } from "../../api";
import { useStashOrphanCount } from "../useStashOrphanCount";

const mockedApi = vi.mocked(api);

describe("useStashOrphanCount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches the orphan count on mount and exposes it", async () => {
    mockedApi.mockResolvedValue({ count: 7 });
    const { result } = renderHook(() => useStashOrphanCount(undefined));

    // Drain the initial load() microtask without tripping the 30s interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.stashOrphanCount).toBe(7);
  });

  it("falls back to 0 when the fetch rejects", async () => {
    mockedApi.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useStashOrphanCount(undefined));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(result.current.stashOrphanCount).toBe(0);
  });

  it("re-polls on the 30s interval", async () => {
    mockedApi.mockResolvedValue({ count: 1 });
    renderHook(() => useStashOrphanCount(undefined));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApi).toHaveBeenCalledTimes(1);

    // Advance exactly one 30s poll tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mockedApi).toHaveBeenCalledTimes(2);
  });
  it("stops polling once unmounted", async () => {
    mockedApi.mockResolvedValue({ count: 1 });
    const { unmount } = renderHook(() => useStashOrphanCount(undefined));

    // Initial mount fetch.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockedApi).toHaveBeenCalledTimes(1);

    unmount();

    // Advance well past the 30s interval — the cleared timer must not fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });
});
