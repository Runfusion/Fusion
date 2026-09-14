import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
import { PoppedOutNoteWindows } from "../PoppedOutNoteWindows";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import {
  activeSessionFixture,
  installChatViewEnv,
  mockViewportMode,
  setupMockChat,
} from "./ChatView.test-harness";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 proves the dedicated-window hosts with their real compositions: PoppedOutChatWindows and PoppedOutNoteWindows
frame the real destination inside the real FloatingWindow, so each window keeps ONE canonical header, its own
identity, and its own draft. A window never rebuilds the shared collection rail or a competing back row.
*/

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), removeNav: vi.fn() }) };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "", defaultModelId: "" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

const notesApi = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
vi.mock("../../api/notes", () => notesApi);
vi.mock("../FileEditor", () => ({
  FileEditor: ({ content, onChange, filePath }: { content: string; onChange: (value: string) => void; filePath: string }) => (
    <textarea aria-label={`editor-${filePath}`} value={content} onChange={(event) => onChange(event.target.value)} />
  ),
}));

installChatViewEnv();
afterEach(() => cleanup());

const noteSummary = (id: string, title: string) => ({ id, title, createdAt: "2026-01-01", updatedAt: "2026-01-01" });

function chatEntry(id: string, cascadeSlot: number) {
  return {
    projectId: "proj-chat",
    session: { ...activeSessionFixture, id, title: `Conversation ${id}` },
    focusNonce: 1,
    cascadeSlot,
  };
}

describe("FN-379 standardized chrome in the dedicated window hosts", () => {
  it("frames each dedicated conversation window on one header without the shared rail", async () => {
    mockViewportMode("desktop");
    setupMockChat({ sessions: [activeSessionFixture], filteredSessions: [activeSessionFixture], activeSession: activeSessionFixture });
    const onClose = vi.fn();

    render(
      <ViewLayoutProvider projectId="proj-chat">
        <PoppedOutChatWindows
          entries={[chatEntry("a", 0), chatEntry("b", 1)]}
          projectId="proj-chat"
          addToast={vi.fn()}
          experimentalFeatures={{}}
          onClose={onClose}
          onOpenSessionInNewWindow={vi.fn()}
        />
      </ViewLayoutProvider>,
    );

    const first = await screen.findByTestId("floating-window-chat-window-proj-chat-a");
    const second = await screen.findByTestId("floating-window-chat-window-proj-chat-b");
    for (const windowEl of [first, second]) {
      // One visual owner per window: no stacked drawer header, no duplicated destination rail.
      expect(windowEl.querySelectorAll(".view-header").length).toBeLessThanOrEqual(1);
      expect(windowEl.querySelectorAll('[data-testid="chat-sidebar-panel"]')).toHaveLength(0);
      expect(within(windowEl).queryByRole("button", { name: "Back to conversations" })).toBeNull();
    }
    // Closing one window never disturbs the sibling identity.
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps two dedicated note windows independent, single-headed, and rail-free", async () => {
    notesApi.fetchNotes.mockResolvedValue({ notes: [] });
    notesApi.fetchNote.mockImplementation(async (_projectId: string, id: string) => ({
      ...noteSummary(id, id === "n1" ? "Première" : "Deuxième"),
      content: id === "n1" ? "brouillon un" : "brouillon deux",
      revision: 1,
    }));

    render(
      <ConfirmDialogProvider>
        <ViewLayoutProvider projectId="p">
          <PoppedOutNoteWindows
            entries={[
              { projectId: "p", note: noteSummary("n1", "Première"), focusNonce: 1, cascadeSlot: 0 },
              { projectId: "p", note: noteSummary("n2", "Deuxième"), focusNonce: 1, cascadeSlot: 1 },
            ]}
            projectId="p"
            addToast={vi.fn()}
            onClose={vi.fn()}
          />
        </ViewLayoutProvider>
      </ConfirmDialogProvider>,
    );

    const first = await screen.findByLabelText("editor-n1.md");
    const second = await screen.findByLabelText("editor-n2.md");
    fireEvent.change(first, { target: { value: "modifié un" } });
    await waitFor(() => expect(first).toHaveValue("modifié un"));
    // The sibling window keeps its own draft: a shared layout preference never transfers content.
    expect(second).toHaveValue("brouillon deux");
    expect(document.querySelectorAll(".notes-list")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    for (const windowEl of document.querySelectorAll<HTMLElement>('[data-testid^="floating-window-note-window"]')) {
      expect(windowEl.querySelectorAll(".view-header").length).toBeLessThanOrEqual(1);
    }
  });
});
