import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/*
FNXC:TaskTranscript 2026-07-26-20:05:
Reconnect-resync coverage for the live transcript. `/api/tasks/:id/logs/stream` replays nothing, so
the refetched page is the ONLY recovery path — and a page fetched while the live tail is still
running is a snapshot from before those lines. The invariant: a resync may not delete an entry that
arrived during its own fetch, and may not render an entry twice when it is in both the page and the
stream.
*/

const { sseOptions } = vi.hoisted(() => ({
  sseOptions: {
    current: null as null | {
      onReconnect?: () => void;
      events: Record<string, (e: MessageEvent) => void>;
    },
  },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: never) => {
    sseOptions.current = opts;
    return () => {};
  }),
}));

vi.mock("../../api", () => ({
  fetchAgentLogsWithMeta: vi.fn(),
}));

import { useLiveTranscript } from "../useLiveTranscript";
import * as apiModule from "../../api";

const mockFetchAgentLogsWithMeta = vi.mocked(apiModule.fetchAgentLogsWithMeta);

function serverEntry(text: string, timestamp: string) {
  return { taskId: "FN-001", type: "text" as const, text, timestamp };
}

function emitLog(text: string, timestamp: string) {
  sseOptions.current?.events["agent:log"]({
    data: JSON.stringify({ type: "text", text, timestamp }),
  } as MessageEvent);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useLiveTranscript reconnect resync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sseOptions.current = null;
    mockFetchAgentLogsWithMeta.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("replaces the buffer with the persisted tail on reconnect (newest first)", async () => {
    mockFetchAgentLogsWithMeta.mockResolvedValue({
      entries: [serverEntry("older", "2026-01-01T00:00:01Z"), serverEntry("newer", "2026-01-01T00:00:02Z")],
      total: 2,
      hasMore: false,
    });

    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.entries.map((entry) => entry.text)).toEqual(["newer", "older"]);
  });

  it("keeps live entries that raced the resync fetch", async () => {
    const page = deferred<{ entries: ReturnType<typeof serverEntry>[]; total: number; hasMore: boolean }>();
    mockFetchAgentLogsWithMeta.mockReturnValue(page.promise as never);

    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    act(() => {
      sseOptions.current?.onReconnect?.();
    });

    // Streams in WHILE the authoritative page is still in flight. The page below predates it.
    act(() => {
      emitLog("raced-live-entry", "2026-01-01T00:00:09Z");
    });

    await act(async () => {
      page.resolve({
        entries: [serverEntry("persisted-1", "2026-01-01T00:00:01Z"), serverEntry("persisted-2", "2026-01-01T00:00:02Z")],
        total: 2,
        hasMore: false,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.entries.map((entry) => entry.text)).toEqual([
      "raced-live-entry",
      "persisted-2",
      "persisted-1",
    ]);
  });

  it("renders an entry once when it is in both the page and the live stream", async () => {
    const page = deferred<{ entries: ReturnType<typeof serverEntry>[]; total: number; hasMore: boolean }>();
    mockFetchAgentLogsWithMeta.mockReturnValue(page.promise as never);

    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    act(() => {
      sseOptions.current?.onReconnect?.();
    });
    act(() => {
      emitLog("persisted-2", "2026-01-01T00:00:02Z");
    });

    await act(async () => {
      page.resolve({
        entries: [serverEntry("persisted-1", "2026-01-01T00:00:01Z"), serverEntry("persisted-2", "2026-01-01T00:00:02Z")],
        total: 2,
        hasMore: false,
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.entries.map((entry) => entry.text)).toEqual(["persisted-2", "persisted-1"]);
  });

  it("flushes parked entries and retries when the resync fetch fails", async () => {
    const failing = deferred<never>();
    mockFetchAgentLogsWithMeta.mockReturnValueOnce(failing.promise as never);
    mockFetchAgentLogsWithMeta.mockResolvedValue({
      entries: [serverEntry("persisted-1", "2026-01-01T00:00:01Z")],
      total: 1,
      hasMore: false,
    });

    const { result } = renderHook(() => useLiveTranscript("FN-001"));

    act(() => {
      sseOptions.current?.onReconnect?.();
    });
    act(() => {
      emitLog("live-during-failed-fetch", "2026-01-01T00:00:09Z");
    });

    await act(async () => {
      failing.reject(new Error("offline"));
      await vi.advanceTimersByTimeAsync(0);
    });

    // The parked entry is rendered, not dropped, even though the page never arrived.
    expect(result.current.entries.map((entry) => entry.text)).toEqual(["live-during-failed-fetch"]);
    expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledTimes(1);

    // Bounded ladder retries without waiting for another reconnect.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mockFetchAgentLogsWithMeta).toHaveBeenCalledTimes(2);
    expect(result.current.entries.map((entry) => entry.text)).toEqual(["persisted-1"]);
  });
});
