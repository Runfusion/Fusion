import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEvals } from "../useEvals";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";

const mockListEvals = vi.fn();
const mockGetEval = vi.fn();
const mockListEvalRuns = vi.fn();

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    listEvals: (...args: unknown[]) => mockListEvals(...args),
    getEval: (...args: unknown[]) => mockGetEval(...args),
    listEvalRuns: (...args: unknown[]) => mockListEvalRuns(...args),
  };
});

describe("useEvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    mockListEvals.mockResolvedValue({ results: [], count: 0 });
    mockListEvalRuns.mockResolvedValue({ runs: [] });
    mockGetEval.mockResolvedValue({ result: { id: "ER-1", runId: "RUN-1", taskId: "FN-1", taskSnapshot: { title: "Task" }, categoryScores: [], evidence: [], followUps: [], createdAt: new Date().toISOString() } });
  });

  it("hydrates cached runs/results on first render", () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.EVALS_RUNS_PREFIX}p1`,
      JSON.stringify({ savedAt: Date.now(), data: [{ id: "RUN-C", createdAt: "", status: "completed", evaluatedTaskCount: 1 }] }),
    );
    localStorage.setItem(
      `${SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX}p1`,
      JSON.stringify({ savedAt: Date.now(), data: [{ id: "ER-C", runId: "RUN-C", taskId: "FN-C", taskTitle: "Cached", createdAt: "", overallScore: null, maxScore: null, categoryScores: [] }] }),
    );

    const { result } = renderHook(() => useEvals({ projectId: "p1" }));

    expect(result.current.loading).toBe(false);
    expect(result.current.results[0]?.id).toBe("ER-C");
  });

  it("propagates filters and normalizes list/detail payloads", async () => {
    mockListEvals.mockResolvedValue({
      items: [{ evalId: "ER-1", batchId: "RUN-1", taskSnapshot: { taskId: "FN-1", title: "Task One" }, overallScore: 0.72, maxScore: 1, scores: { categories: [{ category: "quality", score: 0.8, maxScore: 1 }] }, timestamp: "2026-05-01T00:00:00.000Z" }],
      count: 1,
    });
    mockGetEval.mockResolvedValue({
      result: { id: "ER-1", runId: "RUN-1", taskId: "FN-1", taskSnapshot: { title: "Task One" }, categoryScores: [], details: { evidence: [{ label: "Task", source: "task" }] }, recommendations: { followUps: [{ id: "FU-1", title: "Follow up", description: "d", reason: "r", suggestedState: "suggested", evidence: [] }] }, rationale: "because", createdAt: "2026-05-01T00:00:00.000Z" },
    });

    const { result } = renderHook(() => useEvals({ projectId: "p1" }));

    await waitFor(() => {
      expect(result.current.results[0]).toMatchObject({ id: "ER-1", runId: "RUN-1", taskId: "FN-1", taskTitle: "Task One" });
    });

    const envelope = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX}p1`) ?? "{}");
    expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
    const cached = envelope.data;
    expect(cached?.[0]?.id).toBe("ER-1");

    act(() => result.current.setFilters((prev) => ({ ...prev, q: "fn-1", runId: "RUN-1", scoreMin: "0.5", scoreMax: "1" })));

    await waitFor(() => {
      expect(mockListEvals).toHaveBeenLastCalledWith({ q: "fn-1", runId: "RUN-1", scoreMin: 0.5, scoreMax: 1, limit: 100, offset: 0 }, "p1");
    });

    act(() => result.current.setSelectedEvalId("ER-1"));
    await waitFor(() => {
      expect(result.current.selectedEval).toMatchObject({ id: "ER-1", rationale: "because" });
      expect(result.current.selectedEval?.evidence).toHaveLength(1);
      expect(result.current.selectedEval?.followUps).toHaveLength(1);
    });
  });

  it("caps persisted results at 500", async () => {
    const oversized = Array.from({ length: 620 }, (_, index) => ({
      id: `ER-${index}`,
      runId: "RUN-1",
      taskId: `FN-${index}`,
      taskSnapshot: { title: `Task ${index}` },
      categoryScores: [],
      evidence: [],
      followUps: [],
      createdAt: "2026-05-01T00:00:00.000Z",
    }));
    mockListEvals.mockResolvedValueOnce({ results: oversized, count: oversized.length });

    renderHook(() => useEvals({ projectId: "p1" }));

    await waitFor(() => {
      const envelope = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX}p1`) ?? "{}");
      expect(envelope).toMatchObject({ savedAt: expect.any(Number) });
      const cached = envelope.data;
      expect(cached).toHaveLength(500);
    });
  });

  it("isolates cache by project", () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX}p1`,
      JSON.stringify({ savedAt: Date.now(), data: [{ id: "ER-P1", runId: "RUN", taskId: "FN-1", taskTitle: "P1", createdAt: "", overallScore: null, maxScore: null, categoryScores: [] }] }),
    );
    localStorage.setItem(
      `${SWR_CACHE_KEYS.EVALS_RESULTS_PREFIX}p2`,
      JSON.stringify({ savedAt: Date.now(), data: [{ id: "ER-P2", runId: "RUN", taskId: "FN-2", taskTitle: "P2", createdAt: "", overallScore: null, maxScore: null, categoryScores: [] }] }),
    );
    mockListEvals.mockImplementation(() => new Promise(() => {}));
    mockListEvalRuns.mockImplementation(() => new Promise(() => {}));

    const { result, rerender } = renderHook(({ projectId }) => useEvals({ projectId }), { initialProps: { projectId: "p1" } });
    expect(result.current.results[0]?.id).toBe("ER-P1");

    rerender({ projectId: "p2" });
    expect(result.current.results[0]?.id).toBe("ER-P2");
  });

  it("clears selection when refreshed list no longer contains selected eval", async () => {
    mockListEvals
      .mockResolvedValueOnce({ results: [{ id: "ER-1", runId: "RUN-1", taskId: "FN-1", taskSnapshot: { title: "A" }, categoryScores: [], evidence: [], followUps: [], createdAt: "2026-05-01T00:00:00.000Z" }], count: 1 })
      .mockResolvedValueOnce({ results: [], count: 0 });

    const { result } = renderHook(() => useEvals({ projectId: "p1" }));

    await waitFor(() => expect(result.current.results).toHaveLength(1));
    act(() => result.current.setSelectedEvalId("ER-1"));
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.selectedEvalId).toBeNull();
    });
  });

  it("surfaces API errors in error state", async () => {
    mockListEvals.mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useEvals({ projectId: "p1" }));

    await waitFor(() => {
      expect(result.current.error).toBe("Network error");
      expect(result.current.loading).toBe(false);
    });
  });

});
