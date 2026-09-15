import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as api from "../../api";
import { PlanningKeepAlive } from "../dashboard/PlanningKeepAlive";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import type { ModalManager } from "../../hooks/useModalManager";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 proves the standardized Planning chrome through its PRODUCTION host rather than the destination alone:
PlanningKeepAlive mounts the real PlanningModeModal, keeps it alive while another view is active, and must never
grow a second header, lose its rail, or steal the phone screen for an implicitly kept session.
*/

vi.mock("../../hooks/useViewportMode", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../hooks/useViewportMode")>(),
  useViewportMode: vi.fn(() => "desktop"),
  isShortViewport: vi.fn(() => false),
}));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useToast", () => ({ useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }), useOptionalToast: () => null }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../HeaderWorkflowSwitcherSlot", () => ({ HeaderWorkflowSwitcherSlot: () => null }));
vi.mock("../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api")>(),
  fetchAiSessions: vi.fn(),
  fetchAiSession: vi.fn(),
  fetchModels: vi.fn().mockResolvedValue([]),
  parseConversationHistory: vi.fn(() => []),
}));

const viewport = await import("../../hooks/useViewportMode");

const modalManager = {
  planningInitialPlan: null,
  planningSourceIssue: undefined,
  planningWorkflowId: null,
  planningResumeSessionId: undefined,
  clearPlanningInitialPlan: vi.fn(),
  closePlanning: vi.fn(),
} as unknown as ModalManager;

function renderHost(active: boolean, handleChangeTaskView = vi.fn()) {
  return render(
    <ViewLayoutProvider projectId="project-1">
      <PlanningKeepAlive
        active={active}
        projectId="project-1"
        tasks={[]}
        bgPlanningSessions={[]}
        modalManager={modalManager}
        handleChangeTaskView={handleChangeTaskView}
        handlePlanningTaskCreated={vi.fn()}
        handlePlanningTasksCreated={vi.fn()}
        openBoardTaskDetail={vi.fn()}
      />
    </ViewLayoutProvider>,
  );
}

describe("FN-379 standardized chrome through the Planning keep-alive host", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(viewport.useViewportMode).mockReturnValue("desktop");
    vi.mocked(api.fetchAiSessions).mockResolvedValue([]);
  });

  it("hosts exactly one canonical header owning creation beside the session rail", async () => {
    renderHost(true);
    const host = await screen.findByTestId("planning-keep-alive");
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());

    expect(host.querySelectorAll(".view-header")).toHaveLength(1);
    const header = within(host).getByRole("banner");
    const create = within(header).getByRole("button", { name: "New session" });
    expect(create).toHaveClass("view-action-button--create");
    expect(screen.getAllByRole("button", { name: "New session" })).toHaveLength(1);
    expect(within(host).getByTestId("planning-sidebar")).toBeVisible();
  });

  it("keeps the hidden kept-alive host free of a competing header and restores it intact on reveal", async () => {
    const { rerender } = renderHost(true);
    const host = await screen.findByTestId("planning-keep-alive");
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());
    const sessionLoads = vi.mocked(api.fetchAiSessions).mock.calls.length;

    rerender(
      <ViewLayoutProvider projectId="project-1">
        <PlanningKeepAlive
          active={false}
          projectId="project-1"
          tasks={[]}
          bgPlanningSessions={[]}
          modalManager={modalManager}
          handleChangeTaskView={vi.fn()}
          handlePlanningTaskCreated={vi.fn()}
          handlePlanningTasksCreated={vi.fn()}
          openBoardTaskDetail={vi.fn()}
        />
      </ViewLayoutProvider>,
    );
    // Hidden, still mounted: the host keeps one header and never duplicates the destination chrome.
    expect(host.querySelectorAll(".view-header")).toHaveLength(1);
    expect(host.querySelectorAll(".view-action-button--create")).toHaveLength(1);
    expect(vi.mocked(api.fetchAiSessions).mock.calls.length).toBe(sessionLoads);
  });

  it("starts the phone host on its session list instead of a detail screen", async () => {
    vi.mocked(viewport.useViewportMode).mockReturnValue("mobile");
    renderHost(true);
    const host = await screen.findByTestId("planning-keep-alive");
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());

    expect(within(host).getByTestId("view-layout-content").closest(".view-layout")).toHaveAttribute("data-mobile-pane", "list");
    expect(host.querySelectorAll(".view-header")).toHaveLength(1);
  });

  it("returns to the board through the host close path without a second exit control", async () => {
    const handleChangeTaskView = vi.fn();
    renderHost(true, handleChangeTaskView);
    const host = await screen.findByTestId("planning-keep-alive");
    await waitFor(() => expect(api.fetchAiSessions).toHaveBeenCalled());

    const closes = host.querySelectorAll(".modal-close");
    expect(closes.length).toBeLessThanOrEqual(1);
    if (closes.length === 1) {
      fireEvent.click(closes[0]);
      expect(handleChangeTaskView).toHaveBeenCalledWith("board");
    }
    cleanup();
  });
});
