import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePreviewEmbed } from "../usePreviewEmbed";

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePreviewEmbed", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("initial status is unknown when URL is null", () => {
    const { result } = renderHook(() => usePreviewEmbed(null));

    expect(result.current.embedStatus).toBe("unknown");
    expect(result.current.isEmbedded).toBe(false);
    expect(result.current.isBlocked).toBe(false);
    expect(result.current.embedContext).toBeNull();
  });

  it("status transitions to loading when URL is set", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await waitFor(() => {
      expect(result.current.embedStatus).toBe("loading");
    });
  });

  it("resets to loading when URL changes", async () => {
    const { result, rerender } = renderHook(
      ({ url }) => usePreviewEmbed(url),
      { initialProps: { url: "http://localhost:3000" as string | null } },
    );

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("embedded");
    });
    expect(result.current.embedStatus).toBe("embedded");

    rerender({ url: "http://localhost:4000" });

    await waitFor(() => {
      expect(result.current.embedStatus).toBe("loading");
    });
  });

  it("setEmbedStatus updates status and computed booleans", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("embedded");
    });

    expect(result.current.embedStatus).toBe("embedded");
    expect(result.current.isEmbedded).toBe(true);
    expect(result.current.isBlocked).toBe(false);

    act(() => {
      result.current.setEmbedStatus("error");
    });

    expect(result.current.embedStatus).toBe("error");
    expect(result.current.isEmbedded).toBe(false);
    expect(result.current.isBlocked).toBe(true);
  });

  it("resetEmbedStatus sets status to unknown", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("embedded");
    });
    expect(result.current.embedStatus).toBe("embedded");

    act(() => {
      result.current.resetEmbedStatus();
    });

    expect(result.current.embedStatus).toBe("unknown");
    expect(result.current.embedContext).toBeNull();
  });

  it("handleIframeLoad marks blocked for same-origin about:blank and handleIframeError marks error", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    const mutableRef = result.current.iframeRef as unknown as {
      current: { src: string; contentWindow: { location: { href: string } } } | null;
    };

    mutableRef.current = {
      src: "http://localhost:3000",
      contentWindow: {
        location: {
          href: "about:blank",
        },
      },
    };

    act(() => {
      result.current.handleIframeLoad();
    });

    expect(result.current.embedStatus).toBe("blocked");

    act(() => {
      result.current.handleIframeError();
    });

    expect(result.current.embedStatus).toBe("error");
  });

  it("loading timeout transitions to blocked after default loadTimeoutMs", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    expect(result.current.embedStatus).toBe("loading");

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.embedStatus).toBe("blocked");
    expect(result.current.embedContext).toContain("taking longer than expected");
  });

  it("custom loadTimeoutMs is respected", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000", { loadTimeoutMs: 5000 }));

    await flushMicrotasks();

    expect(result.current.embedStatus).toBe("loading");

    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(result.current.embedStatus).toBe("loading");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.embedStatus).toBe("blocked");
  });

  it("timeout is cleared when embedStatus changes to embedded before timeout", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      vi.advanceTimersByTime(5000);
      result.current.setEmbedStatus("embedded");
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.embedStatus).toBe("embedded");
    expect(result.current.embedContext).toBeNull();
  });

  it("timeout is cleared on URL change", async () => {
    vi.useFakeTimers();

    const { result, rerender } = renderHook(
      ({ url }) => usePreviewEmbed(url),
      { initialProps: { url: "http://localhost:3000" as string | null } },
    );

    await flushMicrotasks();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    rerender({ url: "http://localhost:4000" });
    await flushMicrotasks();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(result.current.embedStatus).toBe("loading");
  });

  it("retry resets embedStatus to unknown", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("blocked");
    });

    expect(result.current.embedStatus).toBe("blocked");

    act(() => {
      result.current.retry();
    });

    expect(result.current.embedStatus).toBe("unknown");
    expect(result.current.embedContext).toBeNull();
  });

  it("retry works after timeout has already fired", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      vi.advanceTimersByTime(10000);
    });

    expect(result.current.embedStatus).toBe("blocked");

    act(() => {
      result.current.retry();
    });

    expect(result.current.embedStatus).toBe("unknown");
    expect(result.current.embedContext).toBeNull();

    act(() => {
      vi.advanceTimersByTime(15000);
    });

    expect(result.current.embedStatus).toBe("unknown");
  });

  it("retry clears pending timeout when called during loading", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      vi.advanceTimersByTime(2000);
      result.current.retry();
    });

    expect(result.current.embedStatus).toBe("unknown");

    act(() => {
      vi.advanceTimersByTime(12000);
    });

    expect(result.current.embedStatus).toBe("unknown");
  });

  it("stale timer is cleared when status changes away from loading", async () => {
    vi.useFakeTimers();

    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("embedded");
    });

    act(() => {
      vi.advanceTimersByTime(15000);
    });

    expect(result.current.embedStatus).toBe("embedded");
  });

  it("embedContext is null for embedded and unknown statuses", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("embedded");
    });
    expect(result.current.embedContext).toBeNull();

    act(() => {
      result.current.setEmbedStatus("unknown");
    });
    expect(result.current.embedContext).toBeNull();
  });

  it("embedContext has message for blocked status", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("blocked");
    });

    expect(result.current.embedContext).toContain("iframe embedding");
  });

  it("embedContext has message for error status", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.setEmbedStatus("error");
    });

    expect(result.current.embedContext).toContain("could not be loaded");
  });
});
