// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningModeModal } from "../PlanningModeModal";
import { MissionManager } from "../MissionManager";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { mockFetchAiSession, mockFetchAiSessions, mockTasks } from "./PlanningModeModal.test-helpers";

/*
FNXC:PlanningTitle 2026-09-17-03:18:
FN-486 : exigence opérateur — le titre SUPÉRIEUR d'une vue reste celui de la VUE, parce que le nom de la
session ou de la mission est déjà affiché juste en dessous dans le contenu. Ces cas montent les vraies
destinations Planning et Missions, à chaque largeur, dans leurs états de liste et de détail, et vérifient
que le titre supérieur ne devient jamais le nom de l'élément — tandis que le contenu, lui, le conserve.
*/

const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));
const mockFetchMissions = vi.hoisted(() => vi.fn());
const mockFetchMission = vi.hoisted(() => vi.fn());
const mockFetchMissionsHealth = vi.hoisted(() => vi.fn());
const mockFetchMissionInterviewDrafts = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", isTabletTouchViewport: (mode?: string) => mode === "tablet", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../MissionInterviewModal", () => ({ MissionInterviewModal: () => null }));
vi.mock("../MilestoneSliceInterviewModal", () => ({ MilestoneSliceInterviewModal: () => null }));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  const fn = vi.fn;
  return {
    ...actual,
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    fetchMissions: (...args: unknown[]) => mockFetchMissions(...args),
    fetchMission: (...args: unknown[]) => mockFetchMission(...args),
    fetchMissionsHealth: (...args: unknown[]) => mockFetchMissionsHealth(...args),
    fetchMissionInterviewDrafts: (...args: unknown[]) => mockFetchMissionInterviewDrafts(...args),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: fn().mockResolvedValue({}),
    fetchModels: fn().mockResolvedValue([]),
    fetchWorkflowSteps: fn().mockResolvedValue([]),
    fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    updatePlanningSessionTitle: fn().mockResolvedValue({ success: true }),
  };
});

const stamps = { createdAt: "2026-09-17T00:00:00.000Z", updatedAt: "2026-09-17T00:00:00.000Z" };

function planningSession(overrides: Record<string, unknown> = {}) {
  return { id: "session-1", title: "Refonte du tiroir", projectId: "project-1", type: "planning", status: "awaiting_input", archived: false, conversationHistory: "[]", thinkingOutput: "", ...stamps, ...overrides };
}

const mission = { id: "M-1", title: "Mission Alpha", description: "", status: "active", interviewState: "completed", ...stamps, milestones: [], summary: { totalMilestones: 0, totalFeatures: 0, completedMilestones: 0, completedFeatures: 0, progressPercent: 0 } };

function headerTitle(): string {
  return within(screen.getAllByRole("banner")[0]).getByRole("heading").textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockViewportMode.mockReturnValue("desktop");
  mockFetchAiSession.mockResolvedValue(null);
  mockFetchAiSessions.mockResolvedValue([planningSession(), planningSession({ id: "session-2", title: "Autre session", status: "complete" })]);
  mockFetchMissions.mockResolvedValue([mission]);
  mockFetchMission.mockResolvedValue(mission);
  mockFetchMissionsHealth.mockResolvedValue({});
  mockFetchMissionInterviewDrafts.mockResolvedValue([]);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Planning and Missions keep their own view title", () => {
  it.each(["desktop", "tablet", "mobile"] as const)("garde le titre de la vue Planning en liste et en détail sur %s", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />);

    await screen.findByText("Refonte du tiroir");
    expect(headerTitle()).toContain("Planning Mode");

    fireEvent.click(screen.getByText("Refonte du tiroir").closest(".planning-sidebar-item-button") as HTMLElement);
    await waitFor(() => expect(mockFetchAiSession).toHaveBeenCalled());
    expect(headerTitle()).toContain("Planning Mode");
    expect(headerTitle()).not.toContain("Refonte du tiroir");
    /* Le nom de la session reste lisible dans le contenu, en dessous. */
    expect(screen.getAllByText("Refonte du tiroir").length).toBeGreaterThan(0);
  });

  it("garde le titre de la vue Planning après un renommage depuis la ligne", async () => {
    render(<PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />);
    const row = (await screen.findByText("Refonte du tiroir")).closest(".planning-sidebar-item-button") as HTMLElement;
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("planning-session-menu-rename"));
    const input = screen.getByRole("textbox", { name: "Rename session" });
    fireEvent.change(input, { target: { value: "Titre renommé" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("Titre renommé")).toBeInTheDocument();
    expect(headerTitle()).toContain("Planning Mode");
  });

  it.each(["desktop", "tablet", "mobile"] as const)("garde le titre de la vue Missions en liste et en détail sur %s", async (mode) => {
    mockViewportMode.mockReturnValue(mode);
    render(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" /></ConfirmDialogProvider>);

    await screen.findByText("Mission Alpha");
    expect(headerTitle()).toContain("Missions");

    fireEvent.click(screen.getByText("Mission Alpha").closest(".mission-list__item") as HTMLElement);
    await waitFor(() => expect(mockFetchMission).toHaveBeenCalledWith("M-1", "project-1"));
    expect(headerTitle()).toContain("Missions");
    expect(headerTitle()).not.toContain("Mission Alpha");
    expect(screen.getAllByText("Mission Alpha").length).toBeGreaterThan(0);
  });

  it("conserve le retour mobile et son callback, et ne le rend pas quand les deux panneaux coexistent", async () => {
    mockViewportMode.mockReturnValue("mobile");
    const { rerender } = render(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" /></ConfirmDialogProvider>);
    await screen.findByText("Mission Alpha");
    expect(screen.queryByTestId("mission-back-btn")).toBeNull();

    fireEvent.click(screen.getByText("Mission Alpha").closest(".mission-list__item") as HTMLElement);
    await waitFor(() => expect(mockFetchMission).toHaveBeenCalled());
    const back = await screen.findByTestId("mission-back-btn");
    expect(back).toHaveAccessibleName("Back to missions list");
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByTestId("mission-back-btn")).toBeNull());
    expect(headerTitle()).toContain("Missions");

    mockViewportMode.mockReturnValue("desktop");
    rerender(<ConfirmDialogProvider><MissionManager isInline isOpen onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" /></ConfirmDialogProvider>);
    expect(screen.queryByTestId("mission-back-btn")).toBeNull();
  });
});
