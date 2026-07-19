import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionManager } from "../MissionManager";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";

const mockViewportMode = vi.fn<() => "mobile" | "desktop">();
const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchMissionEvents = vi.fn();
const mockFetchAssertions = vi.fn();
const mockFetchMilestoneValidation = vi.fn();
const mockFetchMilestoneValidationTelemetry = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchAiSession = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();
const mockSubscribeSse = vi.fn(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
  getViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  useViewportMode: () => mockViewportMode(),
}));

vi.mock("../../sse-bus", () => ({
  subscribeSse: (...args: unknown[]) => mockSubscribeSse(...args),
}));

vi.mock("../MissionInterviewModal", () => ({
  MissionInterviewModal: () => null,
}));

vi.mock("../MilestoneSliceInterviewModal", () => ({
  MilestoneSliceInterviewModal: () => null,
}));

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchMissionEvents: (...args: unknown[]) => mockFetchMissionEvents(...args),
    fetchAssertions: (...args: unknown[]) => mockFetchAssertions(...args),
    fetchMilestoneValidation: (...args: unknown[]) => mockFetchMilestoneValidation(...args),
    fetchMilestoneValidationTelemetry: (...args: unknown[]) => mockFetchMilestoneValidationTelemetry(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  };
});

const missions = [
  {
    id: "M-001",
    title: "Build Auth System",
    description: "Complete authentication flow",
    status: "planning",
    interviewState: "not_started",
    milestones: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "M-002",
    title: "API Redesign",
    description: "Redesign the REST API",
    status: "active",
    interviewState: "not_started",
    milestones: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
];

const missionDetail = {
  id: "M-001",
  title: "Build Auth System",
  description: "Complete authentication flow",
  status: "planning",
  milestones: [
    {
      id: "MS-001",
      title: "Database Schema",
      description: "Set up auth tables",
      status: "planning",
      interviewState: "not_started",
      dependencies: [],
      slices: [],
      missionId: "M-001",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const rollup = {
  milestoneId: "MS-001",
  totalAssertions: 0,
  passedAssertions: 0,
  failedAssertions: 0,
  blockedAssertions: 0,
  pendingAssertions: 0,
  unlinkedAssertions: 0,
  state: "not_started" as const,
};

const missionEvents = [
  {
    id: "ME-001",
    missionId: "M-001",
    eventType: "mission_updated",
    description: "Activity tab loaded",
    metadata: null,
    timestamp: "2026-01-03T00:00:00.000Z",
    seq: 1,
  },
];

function HistoryHarness({ children }: { children: ReactNode }) {
  const history = useNavigationHistory({ enabled: true });
  return <NavigationHistoryProvider value={history}>{children}</NavigationHistoryProvider>;
}

describe("MissionManager mobile swipe-back", () => {
  const originalPushState = window.history.pushState;

  beforeEach(() => {
    vi.clearAllMocks();
    mockViewportMode.mockReturnValue("mobile");
    mockFetchMissions.mockResolvedValue(missions);
    mockFetchMission.mockResolvedValue(missionDetail);
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchMissionEvents.mockResolvedValue({ events: missionEvents, total: missionEvents.length });
    mockFetchAssertions.mockResolvedValue([]);
    mockFetchMilestoneValidation.mockResolvedValue(rollup);
    mockFetchMilestoneValidationTelemetry.mockResolvedValue(null);
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchAiSession.mockResolvedValue(null);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
    window.history.pushState = vi.fn();
  });

  afterEach(() => {
    window.history.pushState = originalPushState;
  });

  it("pushes a mobile nav entry when opening mission detail and popstate returns to the list", async () => {
    renderMissionManager();

    await userSelectMission();
    await waitFor(() => {
      expect(screen.getByText("Database Schema")).toBeInTheDocument();
    });
    expect(window.history.pushState).toHaveBeenCalledWith({ navIndex: 1 }, "");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await expectMissionListVisible();
  });

  it("returns from the Activity tab to the mobile mission list on browser back", async () => {
    renderMissionManager();

    await userSelectMission();
    await openActivityTab();
    expect(screen.getByTestId("mission-activity-tab")).toBeInTheDocument();
    expect(screen.getByText("Activity tab loaded")).toBeInTheDocument();
    expect(window.history.pushState).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await expectMissionListVisible();
  });

  it("returns from the Activity tab with the visible mobile Back button", async () => {
    renderMissionManager();

    await userSelectMission();
    await openActivityTab();
    fireEvent.click(screen.getByTestId("mission-back-btn"));

    await expectMissionListVisible();
  });

  it("does not add duplicate mobile nav entries for repeated tab changes", async () => {
    renderMissionManager();

    await userSelectMission();
    await openActivityTab();
    fireEvent.click(screen.getByTestId("mission-tab-structure"));
    fireEvent.click(screen.getByTestId("mission-tab-activity"));
    fireEvent.click(screen.getByTestId("mission-tab-activity"));

    expect(window.history.pushState).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });

    await expectMissionListVisible();
  });

  it("does not push a nav entry after desktop mission selection or tab switching", async () => {
    mockViewportMode.mockReturnValue("desktop");

    renderMissionManager();

    await userSelectMission();
    await waitFor(() => {
      expect(screen.getByText("Database Schema")).toBeInTheDocument();
    });
    expect(window.history.pushState).not.toHaveBeenCalled();

    await openActivityTab();
    expect(screen.getByTestId("mission-activity-tab")).toBeInTheDocument();
    expect(screen.getByText("Activity tab loaded")).toBeInTheDocument();
    expect(window.history.pushState).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mission-tab-structure"));
    await waitFor(() => {
      expect(screen.getByText("Database Schema")).toBeInTheDocument();
    });
    expect(window.history.pushState).not.toHaveBeenCalled();
  });
});

function renderMissionManager() {
  render(
    <HistoryHarness>
      <MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} isInline={true} />
    </HistoryHarness>,
  );
}

async function userSelectMission() {
  await waitFor(() => {
    expect(screen.getByText("Build Auth System")).toBeInTheDocument();
  });
  fireEvent.click(screen.getAllByText("Build Auth System")[0]);
  await waitFor(() => {
    expect(mockFetchMission).toHaveBeenCalledWith("M-001", undefined);
  });
}

async function openActivityTab() {
  await waitFor(() => {
    expect(screen.getByTestId("mission-tab-activity")).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId("mission-tab-activity"));
  await waitFor(() => {
    expect(mockFetchMissionEvents).toHaveBeenCalledWith(
      "M-001",
      expect.objectContaining({ limit: 50, offset: 0 }),
      undefined,
    );
  });
}

async function expectMissionListVisible() {
  await waitFor(() => {
    expect(screen.queryByText("Database Schema")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mission-activity-tab")).not.toBeInTheDocument();
    expect(screen.queryByText("Activity tab loaded")).not.toBeInTheDocument();
  });
  expect(screen.getByText("Build Auth System")).toBeInTheDocument();
  expect(screen.getByText("API Redesign")).toBeInTheDocument();
}
