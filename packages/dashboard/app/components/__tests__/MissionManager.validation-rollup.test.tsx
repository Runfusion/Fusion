import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MissionManager, MilestoneValidationFreshnessCoordinator } from "../MissionManager";

const mockFetchMissions = vi.fn();
const mockFetchMission = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAssertions = vi.fn();
const mockFetchMilestoneValidation = vi.fn();
const mockFetchMilestoneValidationTelemetry = vi.fn();
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
    fetchAssertions: (...args: unknown[]) => mockFetchAssertions(...args),
    fetchMilestoneValidation: (...args: unknown[]) => mockFetchMilestoneValidation(...args),
    fetchMilestoneValidationTelemetry: (...args: unknown[]) => mockFetchMilestoneValidationTelemetry(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
  };
});

const failedRollup = {
  milestoneId: "MS-1",
  totalAssertions: 1,
  passedAssertions: 0,
  failedAssertions: 1,
  blockedAssertions: 0,
  pendingAssertions: 0,
  unlinkedAssertions: 0,
  hasProseButNoAssertions: false,
  state: "failed" as const,
};

const passedRollup = {
  ...failedRollup,
  passedAssertions: 1,
  failedAssertions: 0,
  state: "passed" as const,
};

const mission = {
  id: "M-1",
  title: "Validation mission",
  description: "",
  status: "active",
  interviewState: "completed",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  milestones: [{
    id: "MS-1",
    missionId: "M-1",
    title: "Validated milestone",
    status: "active",
    interviewState: "completed",
    orderIndex: 0,
    dependencies: [],
    slices: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("max-width: 768px") ? width <= 768 : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("MilestoneValidationFreshnessCoordinator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockFetchMissions.mockResolvedValue([{ ...mission, milestones: [] }]);
    mockFetchMission.mockResolvedValue(mission);
    mockFetchMissionsHealth.mockResolvedValue({});
    mockFetchAssertions.mockResolvedValue([]);
    mockFetchAiSessions.mockResolvedValue([]);
    mockFetchMissionInterviewDrafts.mockResolvedValue([]);
  });

  it("keeps the newer SSE refresh authoritative when an older failed response settles last", () => {
    const coordinator = new MilestoneValidationFreshnessCoordinator();
    const oldRequest = coordinator.begin("MS-1");
    const sseRequest = coordinator.begin("MS-1");

    expect(coordinator.isCurrent("MS-1", sseRequest)).toBe(true);
    expect(coordinator.isCurrent("MS-1", oldRequest)).toBe(false);
  });

  it.each([
    ["desktop", 1280],
    ["mobile", 375],
  ])("renders the repaired fallback rollup at both badge sites on %s after an older failed response settles", async (_surface, width) => {
    setViewport(width);
    const oldRollup = deferred<typeof failedRollup>();
    const repairedRollup = deferred<typeof passedRollup>();
    mockFetchMilestoneValidation
      .mockReturnValueOnce(oldRollup.promise)
      .mockReturnValueOnce(repairedRollup.promise);
    // The newer telemetry request intentionally has no payload, requiring the component fallback.
    mockFetchMilestoneValidationTelemetry.mockResolvedValue(undefined);

    render(
      <MissionManager
        isInline
        isOpen
        onClose={() => {}}
        addToast={() => {}}
        projectId="p1"
        targetMissionId="M-1"
      />,
    );

    await waitFor(() => expect(mockFetchMilestoneValidationTelemetry).toHaveBeenCalledWith("MS-1", "p1"));
    await waitFor(() => expect(mockFetchMilestoneValidation).toHaveBeenCalledTimes(2));

    repairedRollup.resolve(passedRollup);
    await waitFor(() => {
      expect(screen.getByTitle("Validation state")).toHaveTextContent("Passed");
      expect(screen.getAllByText("Passed")).toHaveLength(2);
    });

    oldRollup.resolve(failedRollup);
    await waitFor(() => {
      expect(screen.getByTitle("Validation state")).toHaveTextContent("Passed");
      expect(screen.getAllByText("Passed")).toHaveLength(2);
      expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    });
  });

  it("permits a subsequent newest-generation transition back to failed", () => {
    const coordinator = new MilestoneValidationFreshnessCoordinator();
    const repairedRequest = coordinator.begin("MS-1");
    const laterFailureRequest = coordinator.begin("MS-1");

    expect(coordinator.isCurrent("MS-1", repairedRequest)).toBe(false);
    expect(coordinator.isCurrent("MS-1", laterFailureRequest)).toBe(true);
  });

  it("isolates concurrent milestone refreshes", () => {
    const coordinator = new MilestoneValidationFreshnessCoordinator();
    const firstMilestone = coordinator.begin("MS-1");
    const secondMilestone = coordinator.begin("MS-2");

    expect(coordinator.isCurrent("MS-1", firstMilestone)).toBe(true);
    expect(coordinator.isCurrent("MS-2", secondMilestone)).toBe(true);
  });
});
