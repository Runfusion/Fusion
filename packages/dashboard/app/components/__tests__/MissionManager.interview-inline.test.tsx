import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MissionManager } from "../MissionManager";

/*
FNXC:MissionInterviewMainContent 2026-09-15-03:29:
FN-402: Plan Mission with AI is a main-content destination rendered INSIDE the Missions detail pane. In both hosts
(the inline MainContent mount and the overlay surface) the manager shell, header and mission list stay mounted while
the interview occupies the region that otherwise shows "Select a mission to view details". Closing hands that pane
back to its empty state.
*/

const mockFetchMissions = vi.fn();
const mockFetchMissionsHealth = vi.fn();
const mockFetchAiSessions = vi.fn();
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
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
  };
});

vi.mock("../MissionInterviewModal", () => ({
  MissionInterviewModal: ({
    isOpen,
    onClose,
    resumeSessionId,
  }: {
    isOpen: boolean;
    onClose: () => void;
    resumeSessionId?: string;
  }) =>
    isOpen ? (
      <div data-testid="mission-interview-probe" data-resume-session-id={resumeSessionId ?? ""}>
        <button onClick={onClose}>Close interview probe</button>
      </div>
    ) : null,
}));

const now = "2026-09-14T21:32:00.000Z";

function mission() {
  return {
    id: "M-001",
    title: "Inline Host Mission",
    description: "",
    status: "planning" as const,
    milestones: [],
    createdAt: now,
    updatedAt: now,
  };
}

function setDesktopViewport() {
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setDesktopViewport();
  mockFetchMissions.mockResolvedValue([mission()]);
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchAiSessions.mockResolvedValue([]);
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
});

describe("MissionManager hosts the mission interview in main content", () => {
  it("renders the interview in the detail pane while the inline host keeps its list", async () => {
    renderManager();
    await screen.findByText("Inline Host Mission");
    expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();

    await openInterviewFromHeader();

    expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
    expect(screen.getByText("Inline Host Mission")).toBeInTheDocument();
    expect(within(screen.getByTestId("view-layout-content")).getByTestId("mission-interview-probe")).toBeInTheDocument();
    expect(screen.queryByTestId("mission-empty-detail")).toBeNull();
  });

  it("returns the detail pane to its empty state when the interview closes", async () => {
    renderManager();
    await screen.findByText("Inline Host Mission");

    await openInterviewFromHeader();
    fireEvent.click(screen.getByRole("button", { name: "Close interview probe" }));

    await waitFor(() => expect(screen.getByTestId("mission-empty-detail")).toBeInTheDocument());
    expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("mission-interview-probe")).toBeNull();
    expect(screen.getByText("Inline Host Mission")).toBeInTheDocument();
  });

  it("renders the interview in the detail pane in the overlay host too", async () => {
    renderManager({ isInline: false });
    await screen.findByText("Inline Host Mission");
    expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();

    await openInterviewFromHeader();

    expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
    expect(within(screen.getByTestId("view-layout-content")).getByTestId("mission-interview-probe")).toBeInTheDocument();
  });

  it("opens the embedded surface directly when resuming a session", async () => {
    renderManager({ resumeSessionId: "mission-session-9" });

    const probe = await screen.findByTestId("mission-interview-probe");
    expect(probe).toHaveAttribute("data-resume-session-id", "mission-session-9");
    expect(screen.getByTestId("mission-manager-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("mission-sidebar")).toBeInTheDocument();
    expect(within(screen.getByTestId("view-layout-content")).getByTestId("mission-interview-probe")).toBe(probe);
  });
});
