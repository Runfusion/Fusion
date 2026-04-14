import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useActivityLog } from "../useActivityLog";
import type { ActivityFeedEntry } from "../../api";

function mockFetchResponse(
  ok: boolean,
  body: unknown,
  status = ok ? 200 : 500,
  contentType = "application/json"
) {
  const bodyText = JSON.stringify(body);
  return Promise.resolve({
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(bodyText),
  } as unknown as Response);
}

describe("useActivityLog visibility change", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  let originalVisibilityState: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
  });

  afterEach(() => {
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    } else {
       
      delete (document as any).visibilityState;
    }
  });

  function setVisibilityState(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      value: state,
      writable: true,
      configurable: true,
    });
  }

  it("does not refetch when visibility changes to hidden", async () => {
    const initialEntries: ActivityFeedEntry[] = [
      {
        id: "entry_1",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "task:created",
        projectId: "proj_123",
        projectName: "Test Project",
        taskId: "FN-001",
        details: "Task created",
      },
    ];
    globalThis.fetch = vi.fn().mockReturnValueOnce(mockFetchResponse(true, initialEntries));

    renderHook(() => useActivityLog());

    await act(async () => {
      await Promise.resolve();
    });

    expect(globalThis.fetch).toHaveBeenCalled();

    globalThis.fetch = vi.fn().mockReturnValue(mockFetchResponse(true, []));

    setVisibilityState("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
