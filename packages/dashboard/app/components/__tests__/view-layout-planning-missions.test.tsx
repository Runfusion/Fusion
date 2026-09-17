import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../api";
import { PlanningModeModal } from "../PlanningModeModal";
import { MissionManager } from "../MissionManager";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { savePlanningActiveSession } from "../../hooks/modalPersistence";

vi.mock("../../hooks/useViewportMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../hooks/useViewportMode")>(),
  useViewportMode: vi.fn(() => "desktop"),
  isShortViewport: vi.fn(() => false),
}));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  fetchAiSessions: vi.fn(),
  fetchAiSession: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue([]),
  fetchMissions: vi.fn(),
  fetchMission: vi.fn(),
  fetchMissionsHealth: vi.fn().mockResolvedValue([]),
  fetchMissionInterviewDrafts: vi.fn(),
  parseConversationHistory: vi.fn(() => []),
}));

const viewport = await import("../../hooks/useViewportMode");

function renderPlanning(props: Partial<React.ComponentProps<typeof PlanningModeModal>> = {}) {
  return render(
    <ViewLayoutProvider projectId="project-1">
      <PlanningModeModal
        isOpen
        onClose={vi.fn()}
        onTaskCreated={vi.fn()}
        onTasksCreated={vi.fn()}
        tasks={[]}
        projectId="project-1"
        presentation="embedded"
        {...props}
      />
    </ViewLayoutProvider>,
  );
}

function renderMissions(props: Partial<React.ComponentProps<typeof MissionManager>> = {}) {
  return render(
    <ViewLayoutProvider projectId="project-1">
      <MissionManager isOpen isInline onClose={vi.fn()} addToast={vi.fn()} projectId="project-1" {...props} />
    </ViewLayoutProvider>,
  );
}

describe("standardized Planning and Missions layouts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(viewport.useViewportMode).mockReturnValue("desktop");
    vi.mocked(api.fetchAiSessions).mockResolvedValue([]);
    vi.mocked(api.fetchMissions).mockResolvedValue([]);
    vi.mocked(api.fetchMissionInterviewDrafts).mockResolvedValue([]);
  });

  /*
  FNXC:StandardizedMissionLayout 2026-09-16-15:50:
  FN-465 retire l'archivage de Planning et Missions : les rails de liste ne portent plus aucune
  commande d'archives. Le cas conserve son intention d'origine — une seule action de création par
  en-tête partagé — et y ajoute ce contrôle négatif.
  */
  it("owns creation in each shared header and keeps no archive control in the list rail", async () => {
    const planning = renderPlanning();
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "New session" })).toBeInTheDocument();
    expect(within(screen.getByTestId("planning-sidebar")).queryByRole("button", { name: "Show archived" })).toBeNull();
    planning.unmount();

    renderMissions();
    await waitFor(() => expect(api.fetchMissions).toHaveBeenCalled());
    expect(within(screen.getByRole("banner")).getByRole("button", { name: "Plan New Mission" })).toBeInTheDocument();
    expect(within(screen.getByTestId("mission-sidebar")).queryByRole("button", { name: "Show archived" })).toBeNull();
  });

  it("starts phone Planning on the list even when empty", async () => {
    vi.mocked(viewport.useViewportMode).mockReturnValue("mobile");
    renderPlanning();
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());
    expect(screen.getByText("No saved sessions yet. Start one on the right to see it here.")).toBeVisible();
    expect(screen.getByTestId("view-layout-content").closest(".view-layout")).toHaveAttribute("data-mobile-pane", "list");
  });

  it("never implicitly restores a stored session when Planning is entered", async () => {
    // Entering Planning selects nothing: a stored active session is not resumed, on phone or desktop.
    // Only an explicit resume handoff (covered below) opens an interview.
    vi.mocked(viewport.useViewportMode).mockReturnValue("mobile");
    savePlanningActiveSession("session-implicit", "project-1");
    vi.mocked(api.fetchAiSession).mockResolvedValue({
      id: "session-implicit",
      type: "planning",
      status: "awaiting_input",
      title: "Implicit restore",
      projectId: "project-1",
      updatedAt: new Date().toISOString(),
      inputPayload: JSON.stringify({}),
      result: JSON.stringify({ sessionId: "session-implicit", currentQuestion: null, summary: null }),
    } as never);
    renderPlanning();
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());
    expect(api.fetchAiSession).not.toHaveBeenCalledWith("session-implicit");
    expect(screen.getByTestId("view-layout-content").closest(".view-layout")).toHaveAttribute("data-mobile-pane", "list");
  });

  it("opens desktop Planning on the session rail with no interview panes", async () => {
    // Nothing is selected on entry, so the content area shows the single intake pane:
    // no question/plan workspace is mounted beside the rail.
    savePlanningActiveSession("session-implicit", "project-1");
    const { container } = renderPlanning();
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());

    expect(container.querySelector("[data-testid='planning-sidebar']")).toBeTruthy();
    expect(container.querySelector("[data-testid='planning-workspace']")).toBeNull();
    expect(container.querySelector("[data-testid='planning-question-pane']")).toBeNull();
    expect(container.querySelector("[data-testid='planning-plan-pane']")).toBeNull();
    expect(container.querySelector(".planning-initial")).toBeTruthy();
  });

  it("opens phone Planning detail for an explicit resume handoff and uses the shared back control", async () => {
    vi.mocked(viewport.useViewportMode).mockReturnValue("mobile");
    vi.mocked(api.fetchAiSession).mockResolvedValue({
      id: "session-1",
      type: "planning",
      status: "awaiting_input",
      title: "Explicit handoff",
      projectId: "project-1",
      updatedAt: new Date().toISOString(),
      inputPayload: JSON.stringify({}),
      result: JSON.stringify({ sessionId: "session-1", currentQuestion: null, summary: null }),
    } as never);
    renderPlanning({ resumeSessionId: "session-1" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to sessions" })).toBeInTheDocument());
    expect(screen.getByTestId("view-layout-content").closest(".view-layout")).toHaveAttribute("data-mobile-pane", "detail");
    fireEvent.click(screen.getByRole("button", { name: "Back to sessions" }));
    expect(screen.getByTestId("planning-sidebar")).toBeVisible();
  });
});
