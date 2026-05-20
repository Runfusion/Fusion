import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { MissionManager } from "../MissionManager";
import { SWR_CACHE_KEYS } from "../../utils/swrCache";

const mockFetchMissions = vi.fn();
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
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
  };
});

describe("MissionManager cache hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchMissions.mockResolvedValue([]);
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  });

  it("renders cached missions immediately on open", () => {
    localStorage.setItem(
      `${SWR_CACHE_KEYS.MISSIONS_PREFIX}p1`,
      JSON.stringify([{ id: "M-CACHE", title: "Cached Mission", description: "cached", status: "planning", milestones: [] }]),
    );
    mockFetchMissions.mockImplementation(() => new Promise(() => {}));

    render(
      <MissionManager
        isOpen
        onClose={() => {}}
        addToast={() => {}}
        projectId="p1"
      />,
    );

    expect(screen.getByText("Cached Mission")).toBeInTheDocument();
    expect(screen.queryByText("Loading missions...")).not.toBeInTheDocument();
  });

  it("caps persisted mission cache at 200 and isolates by project", async () => {
    const oversized = Array.from({ length: 260 }, (_, index) => ({
      id: `M-${index}`,
      title: `Mission ${index}`,
      description: "d",
      status: "planning",
      milestones: [],
    }));
    mockFetchMissions.mockResolvedValueOnce(oversized);

    const { rerender } = render(
      <MissionManager isOpen onClose={() => {}} addToast={() => {}} projectId="p1" />,
    );

    await screen.findByText("Mission 0");
    const cachedP1 = JSON.parse(localStorage.getItem(`${SWR_CACHE_KEYS.MISSIONS_PREFIX}p1`) ?? "{}").data;
    expect(cachedP1).toHaveLength(200);

    localStorage.setItem(`${SWR_CACHE_KEYS.MISSIONS_PREFIX}p2`, JSON.stringify([{ id: "M-P2", title: "Project Two Mission", description: "", status: "planning", milestones: [] }]));
    mockFetchMissions.mockImplementation(() => new Promise(() => {}));
    rerender(<MissionManager isOpen onClose={() => {}} addToast={() => {}} projectId="p2" />);

    expect(screen.getByText("Project Two Mission")).toBeInTheDocument();
  });
});
