import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionManager } from "../MissionManager";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";

const mockViewportMode = vi.fn<() => "mobile" | "desktop">();
const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAssertions = vi.fn();
const mockFetchMilestoneValidation = vi.fn();
const mockFetchMilestoneValidationTelemetry = vi.fn();
const mockFetchAiSessions = vi.fn();
const mockFetchAiSession = vi.fn();
const mockFetchMissionInterviewDrafts = vi.fn();
const mockSubscribeSse = vi.fn(() => vi.fn());

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
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
    render(
      <HistoryHarness>
        <MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} isInline={true} />
      </HistoryHarness>,
    );

    await userSelectMission();
    await waitFor(() => {
      expect(screen.getByText("Database Schema")).toBeInTheDocument();
    });
    expect(window.history.pushState).toHaveBeenCalledWith({ navIndex: 1 }, "");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: { navIndex: 0 } }));
    });

    await waitFor(() => {
      expect(screen.queryByText("Database Schema")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Build Auth System")).toBeInTheDocument();
  });

  it("does not push a nav entry on desktop mission selection", async () => {
    mockViewportMode.mockReturnValue("desktop");

    render(
      <HistoryHarness>
        <MissionManager isOpen={true} onClose={vi.fn()} addToast={vi.fn()} isInline={true} />
      </HistoryHarness>,
    );

    await waitFor(() => {
      expect(screen.getByText("Database Schema")).toBeInTheDocument();
    });
    expect(window.history.pushState).not.toHaveBeenCalled();
  });
});

async function userSelectMission() {
  await waitFor(() => {
    expect(screen.getByText("Build Auth System")).toBeInTheDocument();
  });
  fireEvent.click(screen.getAllByText("Build Auth System")[0]);
  await waitFor(() => {
    expect(mockFetchMission).toHaveBeenCalledWith("M-001", undefined);
  });
}
