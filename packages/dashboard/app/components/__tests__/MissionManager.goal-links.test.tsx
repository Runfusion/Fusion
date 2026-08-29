import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

const mockApi = vi.fn();
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
    api: (...args: unknown[]) => mockApi(...args),
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

type LinkedGoal = { id: string; title: string; status: "active" | "archived"; createdAt: string; updatedAt: string };

const now = "2026-06-15T14:00:00.000Z";
const activeGoal: LinkedGoal = { id: "G-ACTIVE", title: "Active Goal", status: "active", createdAt: now, updatedAt: now };
const archivedGoal: LinkedGoal = { id: "G-ARCHIVED", title: "Archived Goal", status: "archived", createdAt: now, updatedAt: now };
let linkedGoals: LinkedGoal[];

function missionDetail() {
  return {
    id: "M-001",
    title: "Mission One",
    description: "",
    status: "active",
    linkedGoals,
    milestones: [],
  };
}

function setupApiMock() {
  mockApi.mockImplementation(async (path: string, opts?: RequestInit) => {
    if (path.startsWith("/goals?status=active")) {
      return { goals: [activeGoal, archivedGoal] };
    }
    if (path === "/missions/M-001/goals/G-ACTIVE" && opts?.method === "POST") {
      linkedGoals = [activeGoal];
      return { goal: activeGoal, goals: linkedGoals };
    }
    if (path === "/missions/M-001/goals/G-ACTIVE" && opts?.method === "DELETE") {
      linkedGoals = [];
      return { removed: true, goals: [] };
    }
    return {};
  });
}

describe("MissionManager goal links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    linkedGoals = [];
    setupApiMock();
    mockFetchMissions.mockImplementation(async () => [
      { id: "M-001", title: "Mission One", description: "", status: "active", summary: { linkedGoalCount: linkedGoals.length }, milestones: [] },
    ]);
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
    mockFetchMission.mockImplementation(async () => missionDetail());
  });

  it("links an active goal, hides archived goals from the picker, unlinks back to empty, and keeps chip navigation", async () => {
    const onNavigateToGoal = vi.fn();
    render(<MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} onNavigateToGoal={onNavigateToGoal} />);

    fireEvent.click(await screen.findByText("Mission One"));

    const picker = await screen.findByTestId("mission-goal-picker");
    expect(within(picker).getByText("Active Goal")).toBeInTheDocument();
    expect(within(picker).queryByText("Archived Goal")).not.toBeInTheDocument();
    expect(screen.getByTestId("mission-unlinked-indicator-M-001")).toBeInTheDocument();
    expect(screen.getByText("No linked goals.")).toBeInTheDocument();

    fireEvent.change(picker, { target: { value: "G-ACTIVE" } });
    fireEvent.click(screen.getByTestId("mission-goal-link-button"));

    const chip = await screen.findByTestId("mission-linked-goal-chip-G-ACTIVE");
    expect(chip).toHaveTextContent("Active Goal");
    expect(within(screen.getByTestId("mission-goal-picker")).queryByText("Active Goal")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByTestId("mission-unlinked-indicator-M-001")).not.toBeInTheDocument();
    });
    fireEvent.click(within(chip).getByRole("button", { name: "Active Goal" }));
    expect(onNavigateToGoal).toHaveBeenCalledWith("G-ACTIVE");

    fireEvent.click(screen.getByTestId("mission-linked-goal-unlink-G-ACTIVE"));

    await waitFor(() => {
      expect(screen.queryByTestId("mission-linked-goal-chip-G-ACTIVE")).not.toBeInTheDocument();
    });
    expect(screen.getByText("No linked goals.")).toBeInTheDocument();
    expect(screen.getByTestId("mission-unlinked-indicator-M-001")).toBeInTheDocument();
  });
});
