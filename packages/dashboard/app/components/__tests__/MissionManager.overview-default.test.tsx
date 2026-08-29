import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MissionManager } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();

const STALE_SELECTED_MISSION_CACHE_KEY = "kb-dashboard-mission-selected-cache:p1";

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

const missions = [
  { id: "M-001", title: "First Mission", description: "", status: "planning", milestones: [] },
  { id: "M-002", title: "Deep Linked Mission", description: "", status: "active", milestones: [] },
];

function missionDetail(id: string) {
  const summary = missions.find((mission) => mission.id === id) ?? missions[0];
  return {
    ...summary,
    milestones: [],
  };
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { value: vi.fn(), configurable: true, writable: true });
  }
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query.includes("max-width: 768px") ? width <= 768 : query.includes("min-width: 769px") && query.includes("max-width: 1024px") ? width >= 769 && width <= 1024 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderMissionManager(props: Partial<ComponentProps<typeof MissionManager>> = {}) {
  return render(
    <MissionManager
      isInline
      isOpen
      onClose={() => {}}
      addToast={() => {}}
      projectId="p1"
      {...props}
    />,
  );
}

describe("MissionManager overview default", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setViewport(1280);
    mockFetchMissions.mockResolvedValue(missions);
    mockFetchMission.mockImplementation((missionId: string) => Promise.resolve(missionDetail(missionId)));
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the desktop overview for a populated inline mission list without auto-loading the first mission", async () => {
    renderMissionManager();

    expect(await screen.findByText("First Mission")).toBeInTheDocument();
    expect(screen.getByTestId("mission-empty-detail")).toHaveTextContent("Select a mission to view details");
    await waitFor(() => expect(mockFetchMission).not.toHaveBeenCalled());
  });

  it("resets to the overview when an inline tab is hidden and shown after selecting a mission", async () => {
    const { rerender } = renderMissionManager();

    fireEvent.click(await screen.findByText("First Mission"));
    await waitFor(() => expect(mockFetchMission).toHaveBeenCalledWith("M-001", "p1"));

    rerender(
      <MissionManager
        isInline
        isOpen={false}
        onClose={() => {}}
        addToast={() => {}}
        projectId="p1"
      />,
    );
    rerender(
      <MissionManager
        isInline
        isOpen
        onClose={() => {}}
        addToast={() => {}}
        projectId="p1"
      />,
    );

    expect(await screen.findByText("First Mission")).toBeInTheDocument();
    expect(screen.getByTestId("mission-empty-detail")).toHaveTextContent("Select a mission to view details");
    await waitFor(() => expect(mockFetchMission).toHaveBeenCalledTimes(1));
  });

  it("ignores a stale selected-mission cache value on desktop and mobile entry", async () => {
    localStorage.setItem(
      STALE_SELECTED_MISSION_CACHE_KEY,
      JSON.stringify({ savedAt: Date.now(), data: "M-002" }),
    );

    const { unmount } = renderMissionManager();
    expect(await screen.findByText("First Mission")).toBeInTheDocument();
    expect(screen.getByTestId("mission-empty-detail")).toHaveTextContent("Select a mission to view details");
    await waitFor(() => expect(mockFetchMission).not.toHaveBeenCalled());

    unmount();
    vi.clearAllMocks();
    mockFetchMissions.mockResolvedValue(missions);
    mockFetchMission.mockImplementation((missionId: string) => Promise.resolve(missionDetail(missionId)));
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
    setViewport(375);

    renderMissionManager();
    expect(await screen.findByText("First Mission")).toBeInTheDocument();
    expect(screen.queryByTestId("mission-empty-detail")).not.toBeInTheDocument();
    await waitFor(() => expect(mockFetchMission).not.toHaveBeenCalled());
  });

  it("still auto-opens an explicit targetMissionId deep link", async () => {
    renderMissionManager({ targetMissionId: "M-002" });

    await waitFor(() => {
      expect(mockFetchMission).toHaveBeenCalledWith("M-002", "p1");
    });
  });

  it("renders the overview empty state when there are no missions", async () => {
    mockFetchMissions.mockResolvedValue([]);

    renderMissionManager();

    expect(await screen.findByText("No missions yet")).toBeInTheDocument();
    expect(screen.getByTestId("mission-empty-detail")).toHaveTextContent("Select a mission to view details");
    expect(mockFetchMission).not.toHaveBeenCalled();
  });
});
