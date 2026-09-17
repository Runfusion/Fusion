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

/*
FNXC:PlanningSessionRowActions 2026-09-17-03:18:
FN-486 : lentrée du scénario devient le clic droit sur la LIGNE (ou son appui long). Les assertions de
mutation, de rollback et de confirmation sont conservées telles quelles : seul le geille douverture change.
*/
async function openRowMenu(row: HTMLElement) {
  const trigger = row.querySelector(".planning-sidebar-item-button") as HTMLElement;
  fireEvent.contextMenu(trigger, { clientX: 20, clientY: 20 });
  return screen.getByTestId("planning-session-context-menu");
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
  it("(a) offers Rename and Delete from each row context menu, with no permanent row buttons left", async () => {
    renderPlanning();

    for (const title of ["First session", "Second session"]) {
      const row = await findRow(title);
      expect(row.querySelector(".planning-sidebar-item-actions")).toBeNull();
      expect(within(row).queryByLabelText("Rename session")).toBeNull();
      expect(within(row).queryByLabelText("Delete session")).toBeNull();
      const menu = await openRowMenu(row);
      expect(within(menu).getByTestId("planning-session-menu-rename")).toBeInTheDocument();
      expect(within(menu).getByTestId("planning-session-menu-delete")).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });

  it("(b) renames an unselected row through its own session id", async () => {
    renderPlanning();
    const row = await findRow("Second session");

    fireEvent.click(within(await openRowMenu(row)).getByTestId("planning-session-menu-rename"));
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

    fireEvent.click(within(await openRowMenu(row)).getByTestId("planning-session-menu-rename"));
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

    fireEvent.click(within(await openRowMenu(row)).getByTestId("planning-session-menu-rename"));
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

  it("(f) shows the delete confirmation form once a delete is requested from the row menu", async () => {
    renderPlanning();
    const row = await findRow("First session");

    fireEvent.click(within(await openRowMenu(row)).getByTestId("planning-session-menu-delete"));

    expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.queryByTestId("planning-session-context-menu")).toBeNull();
  });

  /*
  FNXC:PlanningSessionRename 2026-09-16-15:50:
  FN-465 retire l'archivage des sessions de planification : une session archivée n'est plus listée du
  tout, donc la moitié « archived » de ce cas n'a plus de sujet et devient un contrôle négatif. La
  garantie conservée est que le brouillon — l'autre ligne non ouvrable auparavant — reste renommable.
  */
  it("(g) exposes the rename control on draft rows and never lists an archived session", async () => {
    mockFetchAiSessions.mockResolvedValue([
      session({ id: "session-archived", title: "Archived session", archived: true }),
      session({ id: "session-draft", title: "New planning session", status: "draft", preview: "Draft preview" }),
    ]);
    renderPlanning();

    const draftRow = await findRow("Draft preview");
    expect(screen.queryByText("Archived session")).toBeNull();
    fireEvent.click(within(await openRowMenu(draftRow)).getByTestId("planning-session-menu-rename"));
    expect((within(draftRow).getByRole("textbox", { name: "Rename session" }) as HTMLInputElement).value).toBe("Draft preview");
  });
});
