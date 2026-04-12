import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useBatchBadgeFetch, __resetBatchBadgeStoreForTests } from "../useBatchBadgeFetch";
import * as api from "../../api";
import type { BatchStatusResult } from "@fusion/core";

// Mock the API module
vi.mock("../../api", () => ({
  fetchBatchStatus: vi.fn(),
}));

const mockFetchBatchStatus = vi.mocked(api.fetchBatchStatus);

describe("useBatchBadgeFetch", () => {
  beforeEach(() => {
    __resetBatchBadgeStoreForTests();
    mockFetchBatchStatus.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("calls API with correct task IDs", async () => {
    const mockResult: BatchStatusResult = {
      "FN-001": {
        issueInfo: {
          url: "https://github.com/owner/repo/issues/1",
          number: 1,
          state: "open",
          title: "Test Issue",
        },
        stale: false,
      },
    };
    mockFetchBatchStatus.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useBatchBadgeFetch());

    await act(async () => {
      await result.current.fetchBatch(["FN-001"]);
    });

    expect(mockFetchBatchStatus).toHaveBeenCalledWith(["FN-001"], undefined);
    expect(mockFetchBatchStatus).toHaveBeenCalledTimes(1);
  });

  it("shares pending promise for concurrent calls with same IDs", async () => {
    const mockResult: BatchStatusResult = {
      "FN-001": { issueInfo: undefined, prInfo: undefined, stale: true },
    };
    // Create a delayed promise so we can verify deduplication
    let resolvePromise: (value: BatchStatusResult) => void;
    const promise = new Promise<BatchStatusResult>((resolve) => {
      resolvePromise = resolve;
    });
    mockFetchBatchStatus.mockReturnValueOnce(promise);

    const hook1 = renderHook(() => useBatchBadgeFetch());
    const hook2 = renderHook(() => useBatchBadgeFetch());

    // Start both fetches concurrently (but don't await yet)
    let fetchPromise1!: Promise<void>;
    let fetchPromise2!: Promise<void>;
    act(() => {
      fetchPromise1 = hook1.result.current.fetchBatch(["FN-001"]);
      fetchPromise2 = hook2.result.current.fetchBatch(["FN-001"]);
    });

    // Resolve the shared promise
    resolvePromise!(mockResult);

    // Now await both
    await act(async () => {
      await Promise.all([fetchPromise1, fetchPromise2]);
    });

    // Should only make one API call due to promise deduplication
    expect(mockFetchBatchStatus).toHaveBeenCalledTimes(1);
  });

  it("uses cached data for calls within 5 seconds (no API call)", async () => {
    const mockResult: BatchStatusResult = {
      "FN-001": {
        issueInfo: {
          url: "https://github.com/owner/repo/issues/1",
          number: 1,
          state: "open",
          title: "Test Issue",
        },
        stale: false,
      },
    };
    mockFetchBatchStatus.mockResolvedValueOnce(mockResult);

    const { result } = renderHook(() => useBatchBadgeFetch());

    // First fetch
    await act(async () => {
      await result.current.fetchBatch(["FN-001"]);
    });

    expect(mockFetchBatchStatus).toHaveBeenCalledTimes(1);

    // Second fetch within 5 seconds - should use cache
    await act(async () => {
      await result.current.fetchBatch(["FN-001"]);
    });

    // Should not make another API call
    expect(mockFetchBatchStatus).toHaveBeenCalledTimes(1);
  });

  it("makes new API call after 5 second cache expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const mockResult: BatchStatusResult = {
      "FN-001": { issueInfo: undefined, prInfo: undefined, stale: true },
    };
    mockFetchBatchStatus.mockResolvedValue(mockResult);

    try {
      const { result } = renderHook(() => useBatchBadgeFetch());

      // First fetch
      await act(async () => {
        await result.current.fetchBatch(["FN-001"]);
      });

      expect(mockFetchBatchStatus).toHaveBeenCalledTimes(1);

      // Move past the cache expiration window without waiting in real time.
      vi.setSystemTime(new Date("2026-01-01T00:00:05.001Z"));

      // Second fetch after cache expired
      await act(async () => {
        await result.current.fetchBatch(["FN-001"]);
      });

      // Should make a new API call
      expect(mockFetchBatchStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries 429 errors with exponential backoff", async () => {
    vi.useFakeTimers();

    const rateLimitError = new Error("429 Rate limit exceeded");
    const mockResult: BatchStatusResult = {
      "FN-001": { issueInfo: undefined, prInfo: undefined, stale: true },
    };

    // First calls fail with 429, eventually succeeds
    mockFetchBatchStatus
      .mockRejectedValueOnce(rateLimitError)
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(mockResult);

    try {
      const { result } = renderHook(() => useBatchBadgeFetch());

      // Start the fetch, then advance through the retry backoff immediately.
      let fetchPromise: Promise<void>;
      act(() => {
        fetchPromise = result.current.fetchBatch(["FN-001"]);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);
      });
      await act(async () => {
        await fetchPromise;
      });

      // Should have made multiple calls due to retries
      expect(mockFetchBatchStatus).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry non-429 errors", async () => {
    const otherError = new Error("Network error");
    mockFetchBatchStatus.mockRejectedValueOnce(otherError);

    const { result } = renderHook(() => useBatchBadgeFetch());

    await act(async () => {
      await result.current.fetchBatch(["FN-001"]);
    });

    // Should only make one call (no retries for non-429 errors)
    expect(mockFetchBatchStatus).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for uncached task IDs", () => {
    const { result } = renderHook(() => useBatchBadgeFetch());

    const data = result.current.getBatchData("FN-UNKNOWN");
    expect(data).toBeUndefined();
  });

  it("skips empty task ID arrays", async () => {
    const { result } = renderHook(() => useBatchBadgeFetch());

    await act(async () => {
      await result.current.fetchBatch([]);
    });

    expect(mockFetchBatchStatus).not.toHaveBeenCalled();
  });

  it("stores data and makes it available via getBatchData", async () => {
    const mockResult: BatchStatusResult = {
      "FN-001": {
        prInfo: {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          status: "open",
          title: "Test PR",
          headBranch: "feature/test",
          baseBranch: "main",
          commentCount: 0,
        },
        stale: false,
      },
    };
    mockFetchBatchStatus.mockResolvedValueOnce(mockResult);

    // Use a single hook instance for the entire test
    const { result } = renderHook(() => useBatchBadgeFetch());

    // Fetch the data
    await act(async () => {
      await result.current.fetchBatch(["FN-001"]);
    });

    // Verify data was stored - access result in the same act block
    let storedData;
    act(() => {
      storedData = result.current.getBatchData("FN-001");
    });

    expect(storedData).toBeDefined();
    expect(storedData?.result.prInfo?.title).toBe("Test PR");
    expect(storedData?.timestamp).toBeGreaterThan(0);
  });

  it("module-level store shares data across hooks", async () => {
    const mockResult: BatchStatusResult = {
      "FN-001": {
        prInfo: {
          url: "https://github.com/owner/repo/pull/1",
          number: 1,
          status: "open",
          title: "Shared PR",
          headBranch: "feature/shared",
          baseBranch: "main",
          commentCount: 0,
        },
        stale: false,
      },
    };
    mockFetchBatchStatus.mockResolvedValueOnce(mockResult);

    // Create two hooks
    const hook1 = renderHook(() => useBatchBadgeFetch());
    const hook2 = renderHook(() => useBatchBadgeFetch());

    // Fetch from first hook
    await act(async () => {
      await hook1.result.current.fetchBatch(["FN-001"]);
    });

    // Second hook should see the data via getBatchData
    let sharedData;
    act(() => {
      sharedData = hook2.result.current.getBatchData("FN-001");
    });

    expect(sharedData).toBeDefined();
    expect(sharedData?.result.prInfo?.title).toBe("Shared PR");
  });
});
