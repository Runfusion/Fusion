import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PageErrorBoundary } from "../ErrorBoundary";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
  };
});

vi.mock("lucide-react", () => ({
  X: () => <span>X</span>,
  Plus: () => <span>+</span>,
  Pencil: () => <span>Pencil</span>,
  Trash2: () => <span>Trash</span>,
  ChevronRight: () => <span>ChevronRight</span>,
  ChevronDown: () => <span>ChevronDown</span>,
  ChevronLeft: () => <span>ChevronLeft</span>,
  Target: () => <span>Target</span>,
  Layers: () => <span>Layers</span>,
  Package: () => <span>Package</span>,
  Box: () => <span>Box</span>,
  Check: () => <span>Check</span>,
  Loader2: () => <span>Loader</span>,
  Link: () => <span>Link</span>,
  Unlink: () => <span>Unlink</span>,
  Play: () => <span>Play</span>,
  Square: () => <span>Square</span>,
  Sparkles: () => <span>Sparkles</span>,
  Zap: () => <span>Zap</span>,
  Activity: () => <span>Activity</span>,
  FileText: () => <span>FileText</span>,
  RefreshCw: () => <span>Refresh</span>,
}));

describe("MissionManager malformed mission recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchMissions.mockResolvedValue([
      { id: "M-001", title: "Malformed Mission", description: "", status: "planning", milestones: [] },
    ]);
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
    mockFetchMission.mockResolvedValue({
      id: "M-001",
      title: "Malformed Mission",
      description: "",
      status: "planning",
      milestones: [
        {
          id: "MS-001",
          title: "Milestone missing slices",
          description: "",
          acceptanceCriteria: "",
          status: "planning",
          missionId: "M-001",
          // intentionally malformed
          slices: undefined,
        },
      ],
    });
  });

  it("avoids page ErrorBoundary fallback and shows toast on malformed mission detail", async () => {
    const addToast = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <PageErrorBoundary>
        <MissionManager isInline isOpen onClose={() => {}} addToast={addToast} />
      </PageErrorBoundary>,
    );

    await screen.findByText("Malformed Mission");
    fireEvent.click(screen.getByText("Malformed Mission"));

    await waitFor(() => {
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/failed to load mission details|malformed/i), "error");
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "[MissionManager] loadMissionDetail:",
      expect.any(Error),
    );
    expect(screen.getByTestId("mission-header-title")).toHaveTextContent("Missions");
    expect(screen.getByText("Malformed Mission")).toBeInTheDocument();
  });
});
