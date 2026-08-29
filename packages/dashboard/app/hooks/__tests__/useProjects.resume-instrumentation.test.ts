import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import * as swrCache from "../../utils/swrCache";

const { recordResumeEvent } = vi.hoisted(() => ({
  recordResumeEvent: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchProjectsAcrossNodes: vi.fn(),
  registerProject: vi.fn(),
  updateProject: vi.fn(),
  unregisterProject: vi.fn(),
  hasNodeMappingsSupport: vi.fn(),
}));

vi.mock("../../utils/resumeInstrumentation", () => ({
  recordResumeEvent,
}));

const mockFetchProjectsAcrossNodes = vi.mocked(api.fetchProjectsAcrossNodes);
const mockHasNodeMappingsSupport = vi.mocked(api.hasNodeMappingsSupport);
const mockReadCache = vi.spyOn(swrCache, "readCache");

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("useProjects resume instrumentation", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchProjectsAcrossNodes.mockReset();
    mockHasNodeMappingsSupport.mockReset();
    mockReadCache.mockReset();
    recordResumeEvent.mockReset();
    mockReadCache.mockReturnValue(null);
    mockHasNodeMappingsSupport.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits debounced-refresh then debounce-skipped and refreshes once for visibility events", async () => {
    mockFetchProjectsAcrossNodes.mockResolvedValue([]);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });

    const { useProjects } = await import("../useProjects");
    renderHook(() => useProjects());
    await act(async () => {
      await flushPromises();
    });

    // Reset to isolate visibility-driven refreshes from initial mount fetch.
    mockFetchProjectsAcrossNodes.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(1100);
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
    });

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await flushPromises();
    });

    expect(recordResumeEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      view: "useProjects",
      trigger: "visibility",
      reason: "debounced-refresh",
    }));
    expect(recordResumeEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      view: "useProjects",
      trigger: "visibility",
      reason: "debounce-skipped",
      detail: expect.objectContaining({
        timeSinceLastRefreshMs: expect.any(Number),
      }),
    }));
    expect(recordResumeEvent).toHaveBeenCalledTimes(2);
    expect(mockFetchProjectsAcrossNodes).toHaveBeenCalledTimes(1);
  });
});
