import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

/*
FNXC:MissionsBackAffordance 2026-09-15-03:29:
FN-402 regression. Missions follows the Planning grammar: desktop and tablet keep the list and the detail pane mounted
side by side, so there is nowhere to go back TO and no Back control is rendered at all — not even an empty shell or a
dangling aria-label. Only the phone viewport, which presents one pane at a time, keeps it; there it closes an open
interview, otherwise it deselects the mission.
*/

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
const mockViewportMode = vi.fn<() => "mobile" | "tablet" | "desktop">();

vi.mock("../../hooks/useViewportMode", () => ({
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
  isFullScreenSheetViewport: () => mockViewportMode() === "mobile",
  isShortViewport: () => false,
  getViewportMode: () => mockViewportMode(),
  isMobileViewport: () => mockViewportMode() === "mobile",
  isTabletTouchViewport: (mode?: string) => (mode ?? mockViewportMode()) === "tablet",
  useViewportMode: () => mockViewportMode(),
}));

vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});

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
  };
});

vi.mock("../MissionInterviewModal", () => ({
  MissionInterviewModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="mission-interview-probe" /> : null,
}));

vi.mock("../MilestoneSliceInterviewModal", () => ({
  MilestoneSliceInterviewModal: () => null,
}));

const now = "2026-09-15T03:29:00.000Z";

function mission() {
  return {
    id: "M-001",
    title: "Back Affordance Mission",
    description: "",
    status: "planning" as const,
    interviewState: "not_started" as const,
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

function renderManager(props: Partial<React.ComponentProps<typeof MissionManager>> = {}) {
  return render(
    <MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" {...props} />,
  );
}

async function selectMission() {
  fireEvent.click(await screen.findByText("Back Affordance Mission"));
  await waitFor(() => expect(mockFetchMission).toHaveBeenCalled());
}

async function openInterviewFromHeader() {
  const header = screen.getByRole("banner");
  fireEvent.click(within(header).getByRole("button", { name: "Plan New Mission" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Plan New Mission" }));
  await screen.findByTestId("mission-interview-probe");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockViewportMode.mockReturnValue("desktop");
  mockFetchMissions.mockResolvedValue([mission()]);
  mockFetchMission.mockResolvedValue(mission());
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchMissionEvents.mockResolvedValue([]);
  mockFetchAssertions.mockResolvedValue([]);
  mockFetchMilestoneValidation.mockResolvedValue(null);
  mockFetchMilestoneValidationTelemetry.mockResolvedValue({ rollup: null, validationTelemetry: { validationRounds: [], totalRuns: 0 }, validationContract: null, fixFeatures: [] });
  mockFetchAiSessions.mockResolvedValue([]);
  mockFetchAiSession.mockResolvedValue(null);
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
});

describe("Missions Back control is reserved for the phone viewport", () => {
  it.each(["desktop", "tablet"] as const)("renders no Back control on %s after selecting a mission", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    renderManager();

    await selectMission();

    expect(screen.queryByTestId("mission-back-btn")).toBeNull();
    const header = screen.getByRole("banner");
    expect(within(header).queryByRole("button", { name: "Back to missions list" })).toBeNull();
  });

  it.each(["desktop", "tablet"] as const)("renders no Back control on %s while the interview is open", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    renderManager();
    await screen.findByText("Back Affordance Mission");

    await openInterviewFromHeader();

    expect(screen.queryByTestId("mission-back-btn")).toBeNull();
  });

  it("leaves no unnamed button shell in the desktop header", async () => {
    renderManager();
    await selectMission();

    const header = screen.getByRole("banner");
    for (const button of within(header).getAllByRole("button")) {
      const accessibleName = button.getAttribute("aria-label")?.trim() || button.textContent?.trim() || "";
      expect(accessibleName).not.toBe("");
      expect(accessibleName).not.toBe("Back to missions list");
    }
  });

  it("keeps the Back control on the phone viewport and returns to the mission list", async () => {
    mockViewportMode.mockReturnValue("mobile");
    renderManager();

    await selectMission();
    const back = await screen.findByTestId("mission-back-btn");
    fireEvent.click(back);

    await waitFor(() => expect(screen.queryByTestId("mission-back-btn")).toBeNull());
    expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
    expect(document.querySelector(".view-layout")).toHaveAttribute("data-mobile-pane", "list");
  });

  it("closes an open interview from the phone Back control", async () => {
    mockViewportMode.mockReturnValue("mobile");
    renderManager();
    await screen.findByText("Back Affordance Mission");

    await openInterviewFromHeader();
    expect(document.querySelector(".view-layout")).toHaveAttribute("data-mobile-pane", "detail");

    fireEvent.click(screen.getByTestId("mission-back-btn"));

    await waitFor(() => expect(screen.queryByTestId("mission-interview-probe")).toBeNull());
    expect(document.querySelector(".view-layout")).toHaveAttribute("data-mobile-pane", "list");
    expect(screen.queryByTestId("mission-back-btn")).toBeNull();
  });
});
