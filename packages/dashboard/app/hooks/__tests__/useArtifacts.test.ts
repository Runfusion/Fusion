import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ArtifactWithTask } from "@fusion/core";
import { fetchArtifacts } from "../../api";
import { subscribeSse } from "../../sse-bus";
import { useArtifacts } from "../useArtifacts";
import { message } from "./sseTestHelpers";

const { handlers, unsubscribeMock } = vi.hoisted(() => ({
  handlers: {} as Record<string, (event: MessageEvent) => void>,
  unsubscribeMock: vi.fn(),
}));

vi.mock("../../api", () => ({
  fetchArtifacts: vi.fn(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, opts: { events: Record<string, (event: MessageEvent) => void> }) => {
    Object.assign(handlers, opts.events);
    return unsubscribeMock;
  }),
}));

const mockFetchArtifacts = vi.mocked(fetchArtifacts);
const mockSubscribeSse = vi.mocked(subscribeSse);

const mockArtifacts: ArtifactWithTask[] = [
  {
    id: "artifact-1",
    type: "image",
    title: "Screenshot",
    authorId: "agent-1",
    authorType: "agent",
    taskId: "FN-1",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  },
];

const newTaskArtifact: ArtifactWithTask = {
  id: "artifact-2",
  type: "document",
  title: "Live note",
  authorId: "agent-2",
  authorType: "agent",
  taskId: "FN-1",
  createdAt: "2026-06-27T00:00:00.000Z",
  updatedAt: "2026-06-27T00:00:00.000Z",
};

const loadInitialArtifacts = async () => {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
};

const fireArtifactRegistration = async (
  eventName: "artifact:registered" | "message:received" | "message:sent",
  payload: object,
) => {
  act(() => {
    handlers[eventName]?.(message(payload));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
};

describe("useArtifacts", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
    for (const key of Object.keys(handlers)) delete handlers[key];
    unsubscribeMock.mockClear();
    mockFetchArtifacts.mockResolvedValue(mockArtifacts);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("loads artifacts on initial mount", async () => {
    const { result } = renderHook(() => useArtifacts({ projectId: "project-1" }));

    expect(result.current.loading).toBe(true);
    expect(result.current.artifacts).toEqual([]);

    await loadInitialArtifacts();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.artifacts).toEqual(mockArtifacts);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, "project-1");
  });

  it("propagates filter parameters to fetchArtifacts", async () => {
    renderHook(() => useArtifacts({
      projectId: "project-2",
      type: "video",
      authorId: "agent-video",
      taskId: "FN-2",
      searchQuery: "demo",
    }));

    await loadInitialArtifacts();

    expect(mockFetchArtifacts).toHaveBeenCalledWith({
      type: "video",
      authorId: "agent-video",
      taskId: "FN-2",
      q: "demo",
    }, "project-2");
  });

  it("debounces search query changes", async () => {
    const { rerender } = renderHook(
      ({ searchQuery }) => useArtifacts({ projectId: "project-3", searchQuery }),
      { initialProps: { searchQuery: undefined as string | undefined } },
    );

    await loadInitialArtifacts();

    mockFetchArtifacts.mockClear();
    rerender({ searchQuery: "alpha" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(mockFetchArtifacts).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    await waitFor(() => {
      expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: "alpha" }, "project-3");
    });
  });

  it("surfaces errors without clearing existing artifacts", async () => {
    mockFetchArtifacts.mockResolvedValueOnce(mockArtifacts);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-4" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockRejectedValueOnce(new Error("Artifacts failed"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.error).toBe("Artifacts failed");
    expect(result.current.artifacts).toEqual(mockArtifacts);
  });

  it("refreshes artifacts on demand", async () => {
    const { result } = renderHook(() => useArtifacts({ projectId: "project-5" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(1);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, "project-5");
  });

  it("refreshes task-scoped artifacts when a matching artifact registration arrives", async () => {
    mockFetchArtifacts.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-6", taskId: "FN-1" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual([]));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue([newTaskArtifact]);

    await fireArtifactRegistration("message:received", {
      metadata: { artifactId: newTaskArtifact.id, taskId: "FN-1" },
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ taskId: "FN-1", q: undefined }, "project-6");
    await waitFor(() => expect(result.current.artifacts).toEqual([newTaskArtifact]));
  });

  it("does not refresh task-scoped artifacts for a different task", async () => {
    renderHook(() => useArtifacts({ projectId: "project-7", taskId: "FN-1" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await fireArtifactRegistration("message:received", {
      metadata: { artifactId: "artifact-other", taskId: "FN-2" },
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("refreshes task-scoped artifacts from the authoritative artifact registration event", async () => {
    mockFetchArtifacts.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifacts({ projectId: "project-8a", taskId: "FN-1" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual([]));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue([newTaskArtifact]);

    await fireArtifactRegistration("artifact:registered", {
      id: newTaskArtifact.id,
      taskId: "FN-1",
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ taskId: "FN-1", q: undefined }, "project-8a");
    await waitFor(() => expect(result.current.artifacts).toEqual([newTaskArtifact]));
  });

  it("refreshes project-scoped artifacts when any artifact registration arrives", async () => {
    const updatedArtifacts = [...mockArtifacts, newTaskArtifact];
    const { result } = renderHook(() => useArtifacts({ projectId: "project-8" }));

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue(updatedArtifacts);

    await fireArtifactRegistration("message:sent", {
      projectId: "project-8",
      metadata: { artifactId: newTaskArtifact.id, taskId: "FN-1" },
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, "project-8");
    await waitFor(() => expect(result.current.artifacts).toEqual(updatedArtifacts));
  });

  it("does not refresh project-scoped artifacts when the payload projectId mismatches", async () => {
    renderHook(() => useArtifacts({ projectId: "project-9" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await fireArtifactRegistration("message:received", {
      projectId: "project-other",
      metadata: { artifactId: "artifact-other", taskId: "FN-1" },
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("ignores non-artifact messages", async () => {
    renderHook(() => useArtifacts({ projectId: "project-10" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    await fireArtifactRegistration("message:received", {
      id: "message-not-artifact",
      metadata: { taskId: "FN-1" },
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("ignores malformed message payloads", async () => {
    renderHook(() => useArtifacts({ projectId: "project-11" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    act(() => {
      handlers["message:received"]?.({ data: "not-json" } as MessageEvent);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockFetchArtifacts).toHaveBeenCalledTimes(0);
  });

  it("coalesces duplicate sent and received artifact events into one refresh", async () => {
    renderHook(() => useArtifacts({ projectId: "project-12", taskId: "FN-1" }));

    await loadInitialArtifacts();
    mockFetchArtifacts.mockClear();

    act(() => {
      const event = message({ metadata: { artifactId: "artifact-duplicate", taskId: "FN-1" } });
      handlers["message:received"]?.(event);
      handlers["message:sent"]?.(event);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
  });

  it("subscribes to project-scoped artifact registration events and unsubscribes on unmount", async () => {
    const { unmount } = renderHook(() => useArtifacts({ projectId: "project-13" }));

    expect(mockSubscribeSse).toHaveBeenCalledWith("/api/events?projectId=project-13", {
      events: expect.objectContaining({
        "artifact:registered": expect.any(Function),
        "message:received": expect.any(Function),
        "message:sent": expect.any(Function),
      }),
    });

    unmount();

    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  /*
   * FNXC:ArtifactRegistry 2026-07-10-00:00:
   * The operator-visible "Artifacts tab always shows 0" repro was a single-project/default-scope dashboard mount where no currentProject id was threaded into useArtifacts. The server's real /api/artifacts route listed the agent-created image, but the hook short-circuited before fetch/SSE, so DocumentsView rendered a permanent 0 count.
   */
  it("fetches and subscribes to the default artifact scope when no projectId is available", async () => {
    const { result } = renderHook(() => useArtifacts());

    expect(result.current.loading).toBe(true);

    await loadInitialArtifacts();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.artifacts).toEqual(mockArtifacts);
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, undefined);
    expect(mockSubscribeSse).toHaveBeenCalledWith("/api/events", {
      events: expect.objectContaining({
        "artifact:registered": expect.any(Function),
        "message:received": expect.any(Function),
        "message:sent": expect.any(Function),
      }),
    });
  });

  it("refreshes default-scope artifacts when an unscoped artifact registration arrives", async () => {
    const updatedArtifacts = [...mockArtifacts, newTaskArtifact];
    const { result } = renderHook(() => useArtifacts());

    await loadInitialArtifacts();
    await waitFor(() => expect(result.current.artifacts).toEqual(mockArtifacts));

    mockFetchArtifacts.mockClear();
    mockFetchArtifacts.mockResolvedValue(updatedArtifacts);

    await fireArtifactRegistration("artifact:registered", {
      id: newTaskArtifact.id,
      taskId: "FN-1",
    });

    await waitFor(() => expect(mockFetchArtifacts).toHaveBeenCalledTimes(1));
    expect(mockFetchArtifacts).toHaveBeenCalledWith({ q: undefined }, undefined);
    await waitFor(() => expect(result.current.artifacts).toEqual(updatedArtifacts));
  });
});
