// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanningModeModal } from "../PlanningModeModal";
import { mockFetchAiSession, mockFetchAiSessions, mockTasks } from "./PlanningModeModal.test-helpers";

/*
FNXC:PlanningSessionRename 2026-09-15-03:29:
FN-402 regression. The rename pencil used to live in the Planning header, so only the session already open could be
renamed. It now lives on the session ROW, immediately beside the delete control, and renames that row's own session.
*/

const mockUpdatePlanningSessionTitle = vi.hoisted(() => vi.fn());
const mockViewportMode = vi.hoisted(() => vi.fn(() => "desktop" as "desktop" | "tablet" | "mobile"));

vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }) }));
vi.mock("../../hooks/useNavigationHistory", () => ({ useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../hooks/useViewportMode", () => ({ MOBILE_MEDIA_QUERY: "(max-width: 768px)", isFullScreenSheetViewport: () => false, isShortViewport: () => false, getViewportMode: () => mockViewportMode(), isMobileViewport: () => mockViewportMode() === "mobile", isTabletTouchViewport: (mode?: string) => mode === "tablet", useViewportMode: () => mockViewportMode() }));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));
vi.mock("../../api", () => {
  const fn = vi.fn;
  return {
    fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args),
    fetchAiSessions: (...args: unknown[]) => mockFetchAiSessions(...args),
    updatePlanningSessionTitle: (...args: unknown[]) => mockUpdatePlanningSessionTitle(...args),
    respondToPlanning: fn(), validatePlanningSession: fn(), createTaskFromPlanning: fn(),
    fetchSettings: fn().mockResolvedValue({ modelPresets: [], autoSelectModelPreset: false, defaultPresetBySize: {} }),
    fetchGlobalSettings: fn().mockResolvedValue({}), fetchModels: fn().mockResolvedValue([]),
    fetchWorkflowSteps: fn().mockResolvedValue([]), fetchBoardWorkflows: fn().mockResolvedValue({ workflows: [] }),
    startPlanning: fn(), startPlanningStreaming: fn(), createPlanningDraft: fn(), connectPlanningStream: fn(),
    rewindPlanningSession: fn(), retryPlanningSession: fn(), cancelPlanning: fn(), stopPlanningGeneration: fn(),
    updatePlanningSessionDraft: fn(), startPlanningBreakdown: fn(), createTasksFromPlanning: fn(),
    parseConversationHistory: (raw: string) => JSON.parse(raw || "[]"),
    acquireSessionLock: fn(), releaseSessionLock: fn(), forceAcquireSessionLock: fn(),
    uploadAttachment: fn(), deleteAttachment: fn(), updateTask: fn(), pauseTask: fn(), unpauseTask: fn(),
    fetchTaskDetail: fn(), requestSpecRevision: fn(), approvePlan: fn(), rejectPlan: fn(), refineTask: fn(),
    deleteAiSession: fn(), archiveAiSession: fn(), unarchiveAiSession: fn(), refineText: fn(),
    getRefineErrorMessage: (error: Error) => error.message,
  };
});

const updatedAt = "2026-09-15T03:29:00.000Z";

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    title: "First session",
    projectId: "project-1",
    type: "planning",
    status: "complete",
    updatedAt,
    archived: false,
    conversationHistory: "[]",
    thinkingOutput: "",
    ...overrides,
  };
}

function renderPlanning() {
  return render(
    <PlanningModeModal isOpen onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={mockTasks} projectId="project-1" />,
  );
}

async function findRow(title: string) {
  const label = await screen.findByText(title);
  const row = label.closest(".planning-sidebar-item");
  if (!row) throw new Error(`No session row for ${title}`);
  return row as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockViewportMode.mockReturnValue("desktop");
  mockFetchAiSession.mockResolvedValue(null);
  mockFetchAiSessions.mockResolvedValue([
    session(),
    session({ id: "session-2", title: "Second session", status: "awaiting_input" }),
  ]);
  mockUpdatePlanningSessionTitle.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Planning session rows own the rename affordance", () => {
  it("(a) renders Rename session next to Delete session on every row", async () => {
    renderPlanning();

    for (const title of ["First session", "Second session"]) {
      const row = await findRow(title);
      const actions = row.querySelector(".planning-sidebar-item-actions");
      expect(actions).toBeTruthy();
      const rename = within(actions as HTMLElement).getByLabelText("Rename session");
      const remove = within(actions as HTMLElement).getByLabelText("Delete session");
      expect(rename.nextElementSibling).toBe(remove);
    }
  });

  it("(b) renames an unselected row through its own session id", async () => {
    renderPlanning();
    const row = await findRow("Second session");

    fireEvent.click(within(row).getByLabelText("Rename session"));
    const input = within(row).getByRole("textbox", { name: "Rename session" }) as HTMLInputElement;
    expect(input.value).toBe("Second session");
    fireEvent.change(input, { target: { value: "Renamed second" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mockUpdatePlanningSessionTitle).toHaveBeenCalledWith("session-2", "Renamed second", "project-1"));
    expect(await screen.findByText("Renamed second")).toBeInTheDocument();
    expect(screen.queryByText("Second session")).toBeNull();
    expect(screen.getByText("First session")).toBeInTheDocument();
  });

  it("(c) cancels on Escape without any network call", async () => {
    renderPlanning();
    const row = await findRow("First session");

    fireEvent.click(within(row).getByLabelText("Rename session"));
    const input = within(row).getByRole("textbox", { name: "Rename session" });
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Rename session" })).toBeNull());
    expect(mockUpdatePlanningSessionTitle).not.toHaveBeenCalled();
    expect(screen.getByText("First session")).toBeInTheDocument();
  });

  it("(d) restores the previous title when the rename request fails", async () => {
    mockUpdatePlanningSessionTitle.mockRejectedValue(new Error("nope"));
    renderPlanning();
    const row = await findRow("First session");

    fireEvent.click(within(row).getByLabelText("Rename session"));
    const input = within(row).getByRole("textbox", { name: "Rename session" });
    fireEvent.change(input, { target: { value: "Doomed rename" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(mockUpdatePlanningSessionTitle).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("First session")).toBeInTheDocument());
    expect(screen.queryByText("Doomed rename")).toBeNull();
  });

  it("(e) leaves no rename affordance in the Planning header", async () => {
    renderPlanning();
    await findRow("First session");

    const header = screen.getByRole("banner");
    expect(within(header).queryByLabelText("Rename session")).toBeNull();
    expect(within(header).queryByRole("textbox", { name: "Rename session" })).toBeNull();
    for (const button of within(header).getAllByRole("button")) {
      const accessibleName = button.getAttribute("aria-label")?.trim() || button.textContent?.trim() || "";
      expect(accessibleName).not.toBe("");
    }
  });

  it("(f) shows the delete confirmation instead of row actions while a delete is pending", async () => {
    renderPlanning();
    const row = await findRow("First session");

    fireEvent.click(within(row).getByLabelText("Delete session"));

    expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(row).queryByLabelText("Rename session")).toBeNull();
  });

  it("(g) exposes the rename control on archived and draft rows too", async () => {
    mockFetchAiSessions.mockResolvedValue([
      session({ id: "session-archived", title: "Archived session", archived: true }),
      session({ id: "session-draft", title: "New planning session", status: "draft", preview: "Draft preview" }),
    ]);
    renderPlanning();

    const archivedRow = await findRow("Archived session");
    expect(within(archivedRow).getByLabelText("Rename session")).toBeInTheDocument();

    const draftRow = await findRow("Draft preview");
    fireEvent.click(within(draftRow).getByLabelText("Rename session"));
    expect((within(draftRow).getByRole("textbox", { name: "Rename session" }) as HTMLInputElement).value).toBe("Draft preview");
  });
});
