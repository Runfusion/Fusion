import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { usePreviewEmbed } from "../usePreviewEmbed";

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePreviewEmbed", () => {
  it("initial status is unknown when URL is null", () => {
    const { result } = renderHook(() => usePreviewEmbed(null));

    expect(result.current.embedStatus).toBe("unknown");
    expect(result.current.isEmbedded).toBe(false);
    expect(result.current.isBlocked).toBe(false);
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
      result.current.handleIframeLoad();
    });
    expect(result.current.embedStatus).toBe("embedded");

    rerender({ url: "http://localhost:4000" });

    await waitFor(() => {
      expect(result.current.embedStatus).toBe("loading");
    });
  });

  it("handleIframeLoad sets status to embedded", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.handleIframeLoad();
    });

    expect(result.current.embedStatus).toBe("embedded");
  });

  it("handleIframeError sets status to error", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.handleIframeError();
    });

    expect(result.current.embedStatus).toBe("error");
  });

  it("resetEmbed sets status to unknown", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();

    act(() => {
      result.current.handleIframeLoad();
    });
    expect(result.current.embedStatus).toBe("embedded");

    act(() => {
      result.current.resetEmbed();
    });

    expect(result.current.embedStatus).toBe("unknown");
  });

  it("isEmbedded is true only when embedded", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();
    expect(result.current.isEmbedded).toBe(false);

    act(() => {
      result.current.handleIframeLoad();
    });

    expect(result.current.isEmbedded).toBe(true);

    act(() => {
      result.current.handleIframeError();
    });

    expect(result.current.isEmbedded).toBe(false);
  });

  it("isBlocked is true for blocked and error states", async () => {
    const { result } = renderHook(() => usePreviewEmbed("http://localhost:3000"));

    await flushMicrotasks();
    expect(result.current.isBlocked).toBe(false);

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
    expect(result.current.isBlocked).toBe(true);

    act(() => {
      result.current.handleIframeError();
    });

    expect(result.current.embedStatus).toBe("error");
    expect(result.current.isBlocked).toBe(true);
  });
});
