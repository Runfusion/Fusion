// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { parseDeepLink, useDeepLink } from "../hooks/useDeepLink";

describe("parseDeepLink", () => {
  it("parses task and project links", () => {
    expect(parseDeepLink("fusion://task/FN-100")).toBe("fusion://task/FN-100");
    expect(parseDeepLink("fusion://project/main")).toBe("fusion://project/main");
  });

  it("rejects unsupported links", () => {
    expect(parseDeepLink("https://example.com")).toBeNull();
    expect(parseDeepLink("fusion://invalid/test")).toBeNull();
    expect(parseDeepLink("fusion://task")).toBeNull();
  });
});

describe("useDeepLink", () => {
  afterEach(() => {
    cleanup();
    window.electronAPI = undefined;
  });

  it("captures deep link events from Electron", () => {
    let onDeepLink: ((url: string) => void) | undefined;

    window.electronAPI = {
      onDeepLink: (callback) => {
        onDeepLink = callback;
        return () => {
          onDeepLink = undefined;
        };
      },
    };

    const { result } = renderHook(() => useDeepLink());

    act(() => {
      onDeepLink?.("fusion://task/FN-321");
    });

    expect(result.current.lastDeepLink).toBe("fusion://task/FN-321");

    act(() => {
      onDeepLink?.("https://example.com/not-supported");
    });

    expect(result.current.lastDeepLink).toBe("fusion://task/FN-321");
  });

  it("defaults to null outside Electron", () => {
    window.electronAPI = undefined;

    const { result } = renderHook(() => useDeepLink());
    expect(result.current.lastDeepLink).toBeNull();
  });
});
