import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

/*
FNXC:ApprovalBanner 2026-07-26-19:50:
Reconnect-resync coverage. The failure this guards is the worst in the mobile-retention change set:
an approval raised while the tab was suspended never renders its banner, so an agent blocks
indefinitely on a decision the operator was never shown. A single refetch on reopen is NOT enough —
if that one attempt fails there may be no further reopen for hours — so the invariant is
"a failed resync retries on a bounded ladder, and if the ladder is exhausted the hook reports that
the banner state may be incomplete".
*/

const { sseOptions } = vi.hoisted(() => ({
  sseOptions: { current: null as null | { onReconnect?: () => void } },
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { onReconnect?: () => void }) => {
    sseOptions.current = opts;
    return () => {};
  }),
}));

vi.mock("../../api", () => ({
  fetchApprovals: vi.fn(),
}));

import { useApprovalBanner } from "../useApprovalBanner";
import * as apiModule from "../../api";

const mockFetchApprovals = vi.mocked(apiModule.fetchApprovals);

// Stable identities: the hook's SSE effect keys on them, so a fresh callback per render would
// resubscribe (and drop the retry ladder) on every state change — an artifact, not the behavior
// under test.
const STABLE_TASKS: never[] = [];
const stableOnStarPrompt = vi.fn();

function renderApprovalBannerHook() {
  return renderHook(() =>
    useApprovalBanner({
      tasks: STABLE_TASKS,
      currentProjectId: "p1",
      gitHubStarPromptShown: true,
      onStarPrompt: stableOnStarPrompt,
    }),
  );
}

function pendingRequest(id: string, updatedAt: string) {
  return { id, updatedAt, createdAt: updatedAt, status: "pending" };
}

describe("useApprovalBanner reconnect resync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sseOptions.current = null;
    window.localStorage.clear();
    mockFetchApprovals.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("surfaces an approval raised while the stream was suspended", async () => {
    mockFetchApprovals.mockResolvedValue({
      requests: [pendingRequest("a9", "2026-01-01T00:00:00Z")],
    } as never);

    const { result } = renderApprovalBannerHook();

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.candidate?.dedupeKey).toBe("approval:a9");
    expect(result.current.approvalsMayBeIncomplete).toBe(false);
  });

  it("retries a failed resync instead of waiting for a reconnect that may never come", async () => {
    mockFetchApprovals
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ requests: [pendingRequest("a9", "2026-01-01T00:00:00Z")] } as never);

    const { result } = renderApprovalBannerHook();

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Only the failed attempt so far: nothing is on screen and the old code stopped here forever.
    expect(mockFetchApprovals).toHaveBeenCalledTimes(1);
    expect(result.current.candidate).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(mockFetchApprovals).toHaveBeenCalledTimes(2);
    expect(result.current.candidate?.dedupeKey).toBe("approval:a9");
    expect(result.current.approvalsMayBeIncomplete).toBe(false);
  });

  it("reports a possibly incomplete banner state when the whole ladder fails, and stops retrying", async () => {
    mockFetchApprovals.mockRejectedValue(new Error("offline"));

    const { result } = renderApprovalBannerHook();

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.approvalsMayBeIncomplete).toBe(true);
    // Bounded: the congested resume edge is not hammered.
    expect(mockFetchApprovals).toHaveBeenCalledTimes(3);

    // And it recovers (and clears the signal) on the next healthy reconnect.
    mockFetchApprovals.mockResolvedValue({
      requests: [pendingRequest("a9", "2026-01-01T00:00:00Z")],
    } as never);
    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.approvalsMayBeIncomplete).toBe(false);
    expect(result.current.candidate?.dedupeKey).toBe("approval:a9");
  });

  it("a failed resync never clears a banner already on screen", async () => {
    mockFetchApprovals.mockRejectedValue(new Error("offline"));

    const { result } = renderApprovalBannerHook();

    act(() => {
      // The banner is already showing from a live approval:requested event.
      (sseOptions.current as unknown as { events: Record<string, (e: MessageEvent) => void> })
        .events["approval:requested"]({
          data: JSON.stringify({ id: "a1", updatedAt: "2026-01-01T00:00:00Z" }),
        } as MessageEvent);
    });
    expect(result.current.candidate?.dedupeKey).toBe("approval:a1");

    await act(async () => {
      sseOptions.current?.onReconnect?.();
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.candidate?.dedupeKey).toBe("approval:a1");
  });
});
