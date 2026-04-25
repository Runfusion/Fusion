/**
 * Covers background AI session hook behavior: fetch lifecycle, SSE updates,
 * dismissal, counters/filters, refresh, and project scoping.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackgroundSessions } from "../useBackgroundSessions";
import {
  __destroyAiSessionSyncStoreForTests,
  __resetAiSessionSyncStoreForTests,
  useAiSessionSync,
} from "../useAiSessionSync";
import * as apiModule from "../../api";
import { MockEventSource } from "../../../vitest.setup";

vi.mock("../../api", () => ({
  fetchAiSessions: vi.fn(),
  deleteAiSession: vi.fn(),
  cancelPlanning: vi.fn(),
  cancelSubtaskBreakdown: vi.fn(),
  cancelMissionInterview: vi.fn(),
}));

const mockFetchAiSessions = vi.mocked(apiModule.fetchAiSessions);
const mockDeleteAiSession = vi.mocked(apiModule.deleteAiSession);
const mockCancelPlanning = vi.mocked(apiModule.cancelPlanning);
const mockCancelSubtaskBreakdown = vi.mocked(apiModule.cancelSubtaskBreakdown);
const mockCancelMissionInterview = vi.mocked(apiModule.cancelMissionInterview);

function makeSession(overrides: Partial<apiModule.AiSessionSummary> & Pick<apiModule.AiSessionSummary, "id">): apiModule.AiSessionSummary {
  return {
    id: overrides.id,
    type: overrides.type ?? "planning",
    status: overrides.status ?? "generating",
    title: overrides.title ?? overrides.id,
    projectId: overrides.projectId ?? null,
    lockedByTab: overrides.lockedByTab ?? null,
    updatedAt: overrides.updatedAt ?? "2026-04-08T00:00:00.000Z",
  };
}

describe("useBackgroundSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAiSessionSyncStoreForTests();
    __destroyAiSessionSyncStoreForTests();
    mockFetchAiSessions.mockResolvedValue([]);
    mockDeleteAiSession.mockResolvedValue(undefined);
    mockCancelPlanning.mockResolvedValue(undefined);
    mockCancelSubtaskBreakdown.mockResolvedValue(undefined);
    mockCancelMissionInterview.mockResolvedValue(undefined);
  });

  afterEach(() => {
    __resetAiSessionSyncStoreForTests();
    __destroyAiSessionSyncStoreForTests();
  });

  it("fetches and filters initial sessions", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "s-generating", status: "generating" }),
      makeSession({ id: "s-awaiting", status: "awaiting_input" }),
      makeSession({ id: "s-complete", status: "complete" }),
      makeSession({ id: "s-error", status: "error" }),
      makeSession({ id: "s-ignored", status: "paused" as any }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledWith(undefined);
    });

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id).sort()).toEqual([
        "s-awaiting",
        "s-generating",
      ]);
    });
  });

  it("logs a warning when fetching background sessions fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const networkError = new Error("Network error");
    mockFetchAiSessions.mockRejectedValueOnce(networkError);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[useBackgroundSessions] Failed to fetch AI sessions:",
        networkError,
      );
    });

    expect(result.current.sessions).toEqual([]);
    warnSpy.mockRestore();
  });

  it("applies SSE-driven session updates reactively", async () => {
    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const eventSource = MockEventSource.instances[0]!;

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "sse-session",
          type: "mission_interview",
          status: "generating",
          title: "Mission stream",
          updatedAt: "2026-04-08T00:00:01.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions.find((session) => session.id === "sse-session")?.status).toBe(
        "generating",
      );
    });

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "sse-session",
          type: "mission_interview",
          status: "awaiting_input",
          title: "Mission stream",
          updatedAt: "2026-04-08T00:00:02.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions.find((session) => session.id === "sse-session")?.status).toBe(
        "awaiting_input",
      );
    });
  });

  it("removes session when SSE delivers complete status", async () => {
    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const eventSource = MockEventSource.instances[0]!;

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "terminal-complete",
          type: "planning",
          status: "generating",
          updatedAt: "2026-04-08T00:00:01.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.generating).toBe(1);
      expect(result.current.sessions.map((session) => session.id)).toEqual(["terminal-complete"]);
      expect(result.current.planningSessions.map((session) => session.id)).toEqual(["terminal-complete"]);
    });

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "terminal-complete",
          type: "planning",
          status: "complete",
          updatedAt: "2026-04-08T00:00:02.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
      expect(result.current.planningSessions).toEqual([]);
      expect(result.current.generating).toBe(0);
    });
  });

  it("removes session when SSE delivers error status", async () => {
    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    const eventSource = MockEventSource.instances[0]!;

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "terminal-error",
          type: "planning",
          status: "generating",
          updatedAt: "2026-04-08T00:00:01.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["terminal-error"]);
      expect(result.current.planningSessions.map((session) => session.id)).toEqual(["terminal-error"]);
    });

    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "terminal-error",
          type: "planning",
          status: "error",
          updatedAt: "2026-04-08T00:00:02.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
      expect(result.current.planningSessions).toEqual([]);
      expect(result.current.generating).toBe(0);
    });
  });

  it("removes sessions when ai_session:deleted SSE event arrives", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "delete-me", status: "awaiting_input" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    const eventSource = MockEventSource.instances[0]!;
    act(() => {
      eventSource._emit("ai_session:deleted", "delete-me");
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });
  });

  it("dismissSession calls API and updates local state", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "dismiss-me", status: "awaiting_input" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-me"]);
    });

    await act(async () => {
      await result.current.dismissSession("dismiss-me");
    });

    expect(mockDeleteAiSession).toHaveBeenCalledWith("dismiss-me");
    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });
  });

  it("dismissSession calls cancelPlanning for planning sessions", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "planning-session", status: "generating", type: "planning" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["planning-session"]);
    });

    await act(async () => {
      await result.current.dismissSession("planning-session");
    });

    expect(mockCancelPlanning).toHaveBeenCalledWith("planning-session", undefined, expect.any(String));
    expect(mockDeleteAiSession).toHaveBeenCalledWith("planning-session");
  });

  it("does not dismiss planning session when cancellation is lock-conflicted", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "planning-locked", status: "generating", type: "planning" }),
    ]);
    mockCancelPlanning.mockRejectedValueOnce(new Error("locked by another tab"));

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["planning-locked"]);
    });

    await act(async () => {
      await result.current.dismissSession("planning-locked");
    });

    expect(mockDeleteAiSession).not.toHaveBeenCalled();
    expect(result.current.sessions.map((session) => session.id)).toEqual(["planning-locked"]);
    expect(result.current.generating).toBe(1);
  });

  it("keeps a dismissed planning session hidden when stale sync update arrives", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "dismiss-sync", status: "generating", type: "planning" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());
    const { result: syncResult } = renderHook(() => useAiSessionSync());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-sync"]);
    });

    await act(async () => {
      await result.current.dismissSession("dismiss-sync");
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });

    act(() => {
      syncResult.current.broadcastUpdate({
        sessionId: "dismiss-sync",
        status: "generating",
        needsInput: false,
        type: "planning",
        title: "Dismiss Sync",
        updatedAt: "1970-01-01T00:00:01.000Z",
        timestamp: 1,
      });
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
      expect(result.current.planningSessions).toEqual([]);
      expect(result.current.generating).toBe(0);
      expect(result.current.needsInput).toBe(0);
    });
  });

  it("keeps a dismissed planning session hidden when stale SSE update arrives", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "dismiss-sse", status: "generating", type: "planning" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-sse"]);
    });

    await act(async () => {
      await result.current.dismissSession("dismiss-sse");
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });

    const eventSource = MockEventSource.instances[0]!;
    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "dismiss-sse",
          type: "planning",
          status: "generating",
          title: "Dismiss SSE",
          updatedAt: "1970-01-01T00:00:01.000Z",
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
      expect(result.current.planningSessions).toEqual([]);
      expect(result.current.generating).toBe(0);
      expect(result.current.needsInput).toBe(0);
    });
  });

  it("allows a newer authoritative SSE update to restore a dismissed session", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "dismiss-restore", status: "generating", type: "planning" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-restore"]);
    });

    await act(async () => {
      await result.current.dismissSession("dismiss-restore");
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });

    const eventSource = MockEventSource.instances[0]!;
    act(() => {
      eventSource._emit(
        "ai_session:updated",
        makeSession({
          id: "dismiss-restore",
          type: "planning",
          status: "awaiting_input",
          title: "Dismiss Restore",
          updatedAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-restore"]);
      expect(result.current.planningSessions.map((session) => session.id)).toEqual(["dismiss-restore"]);
      expect(result.current.generating).toBe(0);
      expect(result.current.needsInput).toBe(1);
    });
  });

  it("refresh keeps dismissed sessions hidden when server returns stale data", async () => {
    const staleSession = makeSession({
      id: "dismiss-refresh",
      status: "generating",
      type: "planning",
      updatedAt: "2026-04-08T00:00:01.000Z",
    });

    mockFetchAiSessions.mockResolvedValueOnce([staleSession]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["dismiss-refresh"]);
    });

    await act(async () => {
      await result.current.dismissSession("dismiss-refresh");
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
    });

    mockFetchAiSessions.mockResolvedValueOnce([staleSession]);

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.sessions).toEqual([]);
      expect(result.current.planningSessions).toEqual([]);
      expect(result.current.generating).toBe(0);
      expect(result.current.needsInput).toBe(0);
    });
  });

  it("dismissSession calls cancelSubtaskBreakdown for subtask sessions", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "subtask-session", status: "generating", type: "subtask" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["subtask-session"]);
    });

    await act(async () => {
      await result.current.dismissSession("subtask-session");
    });

    expect(mockCancelSubtaskBreakdown).toHaveBeenCalledWith("subtask-session", undefined, expect.any(String));
    expect(mockDeleteAiSession).toHaveBeenCalledWith("subtask-session");
  });

  it("dismissSession calls cancelMissionInterview for mission_interview sessions", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "interview-session", status: "generating", type: "mission_interview" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["interview-session"]);
    });

    await act(async () => {
      await result.current.dismissSession("interview-session");
    });

    expect(mockCancelMissionInterview).toHaveBeenCalledWith("interview-session", undefined, expect.any(String));
    expect(mockDeleteAiSession).toHaveBeenCalledWith("interview-session");
  });

  it("returns accurate generating/needsInput counts and planningSessions filter", async () => {
    mockFetchAiSessions.mockResolvedValueOnce([
      makeSession({ id: "count-generating", status: "generating", type: "planning" }),
      makeSession({ id: "count-awaiting", status: "awaiting_input", type: "subtask" }),
      makeSession({ id: "count-error-plan", status: "error", type: "planning" }),
      makeSession({ id: "count-complete", status: "complete", type: "mission_interview" }),
    ]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.generating).toBe(1);
      expect(result.current.needsInput).toBe(1);
      expect(result.current.planningSessions.map((session) => session.id)).toEqual([
        "count-generating",
      ]);
      expect(result.current.sessions.map((session) => session.id).sort()).toEqual([
        "count-awaiting",
        "count-generating",
      ]);
    });
  });

  it("refresh triggers a new fetch and updates state", async () => {
    mockFetchAiSessions
      .mockResolvedValueOnce([makeSession({ id: "first-session", status: "generating" })])
      .mockResolvedValueOnce([makeSession({ id: "second-session", status: "awaiting_input" })]);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["first-session"]);
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledTimes(2);
      expect(result.current.sessions.map((session) => session.id)).toEqual(["second-session"]);
    });
  });

  it("logs a warning when refresh fetch fails and preserves existing sessions", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refreshError = new Error("Server error");

    mockFetchAiSessions
      .mockResolvedValueOnce([makeSession({ id: "existing-session", status: "generating" })])
      .mockRejectedValueOnce(refreshError);

    const { result } = renderHook(() => useBackgroundSessions());

    await waitFor(() => {
      expect(result.current.sessions.map((session) => session.id)).toEqual(["existing-session"]);
    });

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledTimes(2);
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[useBackgroundSessions] Failed to fetch AI sessions:",
      refreshError,
    );
    expect(result.current.sessions.map((session) => session.id)).toEqual(["existing-session"]);

    warnSpy.mockRestore();
  });

  it("passes projectId to API fetch and uses project-scoped SSE URL", async () => {
    const projectId = "proj-123";
    renderHook(() => useBackgroundSessions(projectId));

    await waitFor(() => {
      expect(mockFetchAiSessions).toHaveBeenCalledWith(projectId);
    });

    await waitFor(() => {
      expect(MockEventSource.instances.length).toBeGreaterThan(0);
    });

    expect(MockEventSource.instances[0]?.url).toContain(`/api/events?projectId=${encodeURIComponent(projectId)}`);
  });
});
