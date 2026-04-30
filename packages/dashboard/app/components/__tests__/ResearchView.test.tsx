import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Header } from "../Header";
import { ResearchView } from "../ResearchView";

const mockListResearchRuns = vi.fn();
const mockGetResearchStats = vi.fn();

vi.mock("../../api", () => ({
  fetchScripts: vi.fn().mockResolvedValue({}),
  listResearchRuns: (...args: unknown[]) => mockListResearchRuns(...args),
  getResearchStats: (...args: unknown[]) => mockGetResearchStats(...args),
}));

function mockMatchMediaDesktop() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("Research navigation", () => {
  it("shows research in header overflow and activates view change", async () => {
    mockMatchMediaDesktop();
    const onChangeView = vi.fn();

    render(
      <Header
        onOpenSettings={vi.fn()}
        onOpenGitHubImport={vi.fn()}
        globalPaused={false}
        enginePaused={false}
        onToggleGlobalPause={vi.fn()}
        onToggleEnginePause={vi.fn()}
        view="board"
        onChangeView={onChangeView}
      />,
    );

    fireEvent.click(screen.getByTestId("view-toggle-overflow-trigger"));

    await waitFor(() => {
      expect(screen.getByTestId("view-overflow-research")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("view-overflow-research"));
    expect(onChangeView).toHaveBeenCalledWith("research");
  });
});

describe("ResearchView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders empty state", async () => {
    mockListResearchRuns.mockResolvedValue({ runs: [] });
    mockGetResearchStats.mockResolvedValue({
      total: 0,
      byStatus: { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    });

    render(<ResearchView projectId="p1" />);

    await waitFor(() => {
      expect(screen.getByTestId("research-state-empty")).toBeInTheDocument();
    });
  });

  it("renders loading and then running/results states", async () => {
    mockListResearchRuns.mockResolvedValue({
      runs: [
        {
          id: "RR-1",
          query: "evaluate release automation",
          topic: "Release automation",
          status: "running",
          providerConfig: {},
          sources: [],
          events: [],
          results: { summary: "Initial synthesis complete", findings: [], citations: [], synthesizedOutput: "" },
          error: null,
          tokenUsage: null,
          tags: [],
          metadata: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
        },
      ],
    });
    mockGetResearchStats.mockResolvedValue({
      total: 1,
      byStatus: { pending: 0, running: 1, completed: 0, failed: 0, cancelled: 0 },
    });

    render(<ResearchView projectId="p1" />);
    expect(screen.getByTestId("research-state-loading")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId("research-state-running")).toBeInTheDocument();
      expect(screen.getByTestId("research-state-results")).toBeInTheDocument();
    });
  });

  it("uses failure badge treatment for failed runs", async () => {
    mockListResearchRuns.mockResolvedValue({
      runs: [
        {
          id: "RR-2",
          query: "evaluate failed orchestration",
          topic: "Failure case",
          status: "failed",
          providerConfig: {},
          sources: [],
          events: [],
          results: null,
          error: "provider timeout",
          tokenUsage: null,
          tags: [],
          metadata: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
        },
      ],
    });
    mockGetResearchStats.mockResolvedValue({
      total: 1,
      byStatus: { pending: 0, running: 0, completed: 0, failed: 1, cancelled: 0 },
    });

    render(<ResearchView projectId="p1" />);

    await waitFor(() => {
      expect(screen.getByText("Failed")).toHaveClass("failed");
      expect(screen.getByText("Failed")).toHaveClass("card-status-badge");
    });
  });

  it("renders error state when fetch fails", async () => {
    mockListResearchRuns.mockRejectedValue(new Error("boom"));
    mockGetResearchStats.mockResolvedValue({
      total: 0,
      byStatus: { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 },
    });

    render(<ResearchView projectId="p1" />);

    await waitFor(() => {
      expect(screen.getByTestId("research-state-error")).toBeInTheDocument();
    });
  });

  it("includes mobile layout media rule", async () => {
    const css = await import("../ResearchView.css?inline");
    expect(css.default).toContain("@media (max-width: 768px)");
    expect(css.default).toContain(".research-view__stats");
  });
});
