import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvalsView } from "../EvalsView";

const mockUseEvals = vi.fn();
const mockFetchSettings = vi.fn();

vi.mock("../../hooks/useEvals", () => ({
  useEvals: (...args: unknown[]) => mockUseEvals(...args),
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchSettings: (...args: unknown[]) => mockFetchSettings(...args),
  };
});

describe("EvalsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchSettings.mockResolvedValue({ evalSettings: { enabled: true } });
    mockUseEvals.mockReturnValue({
      loading: false,
      error: null,
      results: [],
      runs: [],
      filters: { q: "", runId: "", scoreMin: "", scoreMax: "" },
      setFilters: vi.fn(),
      selectedEvalId: null,
      setSelectedEvalId: vi.fn(),
      selectedEval: null,
      refresh: vi.fn(),
    });
  });

  it("shows setup CTA when scheduled evals are disabled", async () => {
    mockFetchSettings.mockResolvedValue({ evalSettings: { enabled: false } });
    const openSettings = vi.fn();
    render(<EvalsView projectId="p1" onOpenSettings={openSettings} />);

    const cta = await screen.findByRole("button", { name: /open scheduled evals settings/i });
    fireEvent.click(cta);
    expect(openSettings).toHaveBeenCalledWith("scheduled-evals");
  });

  it("renders loading skeleton when loading is true", () => {
    mockUseEvals.mockReturnValueOnce({
      loading: true,
      error: null,
      results: [],
      runs: [],
      filters: { q: "", runId: "", scoreMin: "", scoreMax: "" },
      setFilters: vi.fn(),
      selectedEvalId: null,
      setSelectedEvalId: vi.fn(),
      selectedEval: null,
      refresh: vi.fn(),
    });

    render(<EvalsView projectId="p1" />);

    expect(screen.getByTestId("evals-loading")).toBeInTheDocument();
  });

  it("renders empty and error states", () => {
    mockUseEvals.mockReturnValueOnce({
      loading: false,
      error: "Boom",
      results: [],
      runs: [],
      filters: { q: "", runId: "", scoreMin: "", scoreMax: "" },
      setFilters: vi.fn(),
      selectedEvalId: null,
      setSelectedEvalId: vi.fn(),
      selectedEval: null,
      refresh: vi.fn(),
    });
    render(<EvalsView projectId="p1" />);
    expect(screen.getByText("Boom")).toBeInTheDocument();
    expect(screen.getByText(/Select an evaluation/i)).toBeInTheDocument();
  });

  it("supports drill-down, evidence rendering, follow-ups, and task evidence action", () => {
    const setSelectedEvalId = vi.fn();
    const onOpenTaskDetail = vi.fn();
    mockUseEvals.mockReturnValueOnce({
      loading: false,
      error: null,
      results: [{ id: "ER-1", runId: "RUN-1", taskId: "FN-1", taskTitle: "Task A", overallScore: 90, maxScore: 100, categoryScores: [] }],
      runs: [{ id: "RUN-1", createdAt: "", status: "completed", evaluatedTaskCount: 1 }],
      filters: { q: "", runId: "", scoreMin: "", scoreMax: "" },
      setFilters: vi.fn(),
      selectedEvalId: "ER-1",
      setSelectedEvalId,
      selectedEval: {
        id: "ER-1",
        runId: "RUN-1",
        taskId: "FN-1",
        taskTitle: "Task A",
        createdAt: "",
        overallScore: 90,
        maxScore: 100,
        categoryScores: [{ category: "quality", deterministicScore: 80, aiScore: 90, finalScore: 85, weight: 1, band: "watch", rationale: "ok", evidence: [] }],
        rationale: "Strong work",
        evidence: [{ type: "other", ref: "Task evidence", metadata: { taskId: "FN-1" } }],
        followUps: [{ suggestionId: "FU-1", dedupeKey: "k", title: "Add test", description: "d", priority: "normal", severity: "watch", rationale: "Coverage", evidenceRefs: [], recommendation: { shouldCreate: true, reason: "yes", policyQualified: true }, state: "suggested", policyMode: "persist_only" }],
      },
      refresh: vi.fn(),
    });

    render(<EvalsView projectId="p1" onOpenTaskDetail={onOpenTaskDetail} />);

    fireEvent.click(screen.getByRole("button", { name: /Task A/i }));
    expect(setSelectedEvalId).toHaveBeenCalledWith("ER-1");
    expect(screen.getByText(/Strong work/)).toBeInTheDocument();
    expect(screen.getByText(/Add test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Task evidence/i }));
    expect(onOpenTaskDetail).toHaveBeenCalledWith("FN-1");
  });
});
