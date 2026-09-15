import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

/*
FNXC:MissionInterviewMainContent 2026-09-15-03:29:
FN-402 symptom regression. Opening Plan Mission with AI used to unmount the whole mission manager body, so the
mission list vanished under the operator. The interview now occupies the DETAIL PANE: the manager shell, the header
and the mission sidebar stay mounted, the interview renders inside `view-layout-content`, and the
"Select a mission to view details" empty state is the only thing it displaces.
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
  MissionInterviewModal: ({
    isOpen,
    resumeSessionId,
    headingLevel,
  }: {
    isOpen: boolean;
    resumeSessionId?: string;
    headingLevel?: number;
  }) =>
    isOpen ? (
      <div
        data-testid="mission-interview-probe"
        data-resume-session-id={resumeSessionId ?? ""}
        data-heading-level={String(headingLevel ?? "")}
      />
    ) : null,
}));

const now = "2026-09-15T03:29:00.000Z";

function mission() {
  return {
    id: "M-001",
    title: "Inline Host Mission",
    description: "",
    status: "planning" as const,
    interviewState: "not_started" as const,
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

function setViewport({ width, mobile = false }: { width: number; mobile?: boolean }) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: mobile && query.includes("max-width"),
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

function renderManager(props: Partial<React.ComponentProps<typeof MissionManager>> = {}) {
  return render(
    <MissionManager isInline isOpen onClose={() => {}} addToast={() => {}} projectId="project-1" {...props} />,
  );
}

async function openInterviewFromHeader() {
  const header = screen.getByRole("banner");
  fireEvent.click(within(header).getByRole("button", { name: "Plan New Mission" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Plan New Mission" }));
  await screen.findByTestId("mission-interview-probe");
}

function expectInterviewInDetailPane() {
  expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();
  expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
  expect(within(screen.getByTestId("view-layout-content")).getByTestId("mission-interview-probe")).toBeInTheDocument();
  expect(screen.queryByTestId("mission-empty-detail")).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setViewport({ width: 1440 });
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

describe("MissionManager renders the interview inside the detail pane", () => {
  it("(a) keeps the inline host shell and list mounted while the interview is open", async () => {
    renderManager();
    await screen.findByText("Inline Host Mission");

    await openInterviewFromHeader();

    expectInterviewInDetailPane();
    expect(screen.getByText("Inline Host Mission")).toBeInTheDocument();
  });

  it("(b) keeps the overlay host shell and list mounted while the interview is open", async () => {
    renderManager({ isInline: false });
    await screen.findByText("Inline Host Mission");

    await openInterviewFromHeader();

    expectInterviewInDetailPane();
    expect(screen.getByText("Inline Host Mission")).toBeInTheDocument();
  });

  it("(c) opens from the header menu without displacing the header itself", async () => {
    renderManager();
    await screen.findByText("Inline Host Mission");

    await openInterviewFromHeader();

    expectInterviewInDetailPane();
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("button", { name: "Plan New Mission" })).toBeInTheDocument();
  });

  it("(d) resumes a session directly into the detail pane", async () => {
    renderManager({ resumeSessionId: "mission-session-9" });

    const probe = await screen.findByTestId("mission-interview-probe");
    expect(probe).toHaveAttribute("data-resume-session-id", "mission-session-9");
    expectInterviewInDetailPane();
  });

  it("(e) keeps the empty mission list mounted beside the interview", async () => {
    mockFetchMissions.mockResolvedValue([]);
    renderManager();
    await screen.findByText("No missions yet");

    await openInterviewFromHeader();

    expectInterviewInDetailPane();
    expect(screen.getByText("No missions yet")).toBeInTheDocument();
  });

  it("(f) gives the interview priority over an already selected mission detail", async () => {
    renderManager();
    fireEvent.click(await screen.findByText("Inline Host Mission"));
    await screen.findByRole("heading", { name: "Inline Host Mission" });

    await openInterviewFromHeader();

    expectInterviewInDetailPane();
    expect(screen.queryByRole("heading", { name: "Inline Host Mission" })).toBeNull();
    expect(screen.getByText("Inline Host Mission")).toBeInTheDocument();
  });

  it("nests the interview heading under the owning Missions heading", async () => {
    renderManager();
    await screen.findByText("Inline Host Mission");

    await openInterviewFromHeader();

    expect(screen.getByTestId("mission-interview-probe")).toHaveAttribute("data-heading-level", "3");
  });
});
