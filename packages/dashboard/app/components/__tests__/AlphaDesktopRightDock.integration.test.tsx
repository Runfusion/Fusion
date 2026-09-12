import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ChatSession } from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useAppAlphaDesktopRightDockComposition,
  useAppAlphaDesktopRightDockWindows,
} from "../../App";
import { useChat } from "../../hooks/useChat";
import { NavigationHistoryProvider, useNavigationHistory } from "../../hooks/useNavigationHistory";
import { ConfirmDialogProvider } from "../../hooks/useConfirm";
import { RIGHT_DOCK_OPEN_STORAGE_KEY, RIGHT_DOCK_VIEW_STORAGE_KEY } from "../RightDock";
import type { RightDockControllerInput } from "../useRightDockController";

const api = vi.hoisted(() => ({
  fetchChatSessions: vi.fn(),
  fetchChatSession: vi.fn(),
  createChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  updateChatSession: vi.fn(),
  deleteChatSession: vi.fn(),
  backfillChatSessionToStash: vi.fn(),
  attachChatStream: vi.fn(),
  streamChatResponse: vi.fn(),
  cancelChatResponse: vi.fn(),
  fetchChatTags: vi.fn(),
  createChatTag: vi.fn(),
  renameChatTag: vi.fn(),
  deleteChatTag: vi.fn(),
  fetchSettings: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  fetchTasks: vi.fn(),
  searchFiles: vi.fn(),
}));
const notesApi = vi.hoisted(() => ({
  fetchNotes: vi.fn(),
  fetchNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
}));
const sse = vi.hoisted(() => ({ handlers: {} as Record<string, (event: MessageEvent) => void> }));

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  ...api,
}));
vi.mock("../../api/notes", () => notesApi);
vi.mock("../../sse-bus", () => ({
  subscribeSse: vi.fn((_url: string, options: { events?: Record<string, (event: MessageEvent) => void> }) => {
    sse.handlers = options.events ?? {};
    return () => {};
  }),
}));

function session(id: string, projectId: string, title: string, updatedAt: string): ChatSession {
  return {
    id,
    projectId,
    agentId: "agent-1",
    status: "active",
    title,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    pinnedAt: null,
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt,
  };
}

function useProductionOwnership(projectId?: string) {
  return {
    chat: useChat(projectId),
    windows: useAppAlphaDesktopRightDockWindows(projectId),
  };
}

function IntegrationProviders({ children }: { children: React.ReactNode }) {
  const navigation = useNavigationHistory({ enabled: true });
  return <NavigationHistoryProvider value={navigation}>{children}</NavigationHistoryProvider>;
}

function controllerInput(hostMode: "alpha-desktop" | "standard"): Omit<RightDockControllerInput,
  "projectId" | "onOpenSessionInNewWindow" | "openChatWindows" | "onOpenNote"
> {
  return {
    active: true,
    addToast: vi.fn(),
    settingsLoaded: true,
    researchReadinessVersion: 0,
    tasks: [],
    workflowSteps: [],
    subscribePluginEvents: () => () => {},
    openDetailTask: vi.fn(),
    openFileInBrowser: vi.fn(),
    onDeleteTask: vi.fn(),
    onMergeTask: vi.fn(),
    openSettings: vi.fn(),
    onSendSelectionToTask: vi.fn(),
    onCreateTaskFromInsight: vi.fn(),
    onNavigateToMission: vi.fn(),
    onTaskCreated: vi.fn(),
    prAuthAvailable: false,
    autoMerge: true,
    taskDetailChatFirst: false,
    visibilityOptions: { hostMode, experimentalFeatures: {} },
    footerVisible: true,
  };
}

function AppCompositionHarness({
  projectId,
  hostMode = "alpha-desktop",
}: {
  projectId: string;
  hostMode?: "alpha-desktop" | "standard";
}) {
  const owner = useAppAlphaDesktopRightDockWindows(projectId);
  const composition = useAppAlphaDesktopRightDockComposition({
    projectId,
    owner,
    controllerInput: controllerInput(hostMode),
    chatWindowProps: { addToast: vi.fn() },
    noteWindowProps: { addToast: vi.fn() },
  });
  return <ConfirmDialogProvider>
    {composition.rightDock.dock}
    {composition.windows}
    <button type="button" data-testid="minimize-chats" onClick={owner.chats.minimizeAll}>minimize</button>
  </ConfirmDialogProvider>;
}

/*
FNXC:AlphaDesktopRightDock 2026-09-12-04:56:
Cette intégration exerce ensemble le propriétaire App et le vrai useChat : la création list-only publie d’abord la ligne locale puis ouvre la fenêtre, les événements serveur actualisent la même ligne, et les badges ouvert/minimisé restent strictement projetés dans le projet courant. Elle couvre aussi le refus sans projet utilisé par les hôtes standard avant résolution.
*/
describe("App Alpha desktop right-dock window ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem(RIGHT_DOCK_OPEN_STORAGE_KEY, "true");
    sse.handlers = {};
    api.fetchChatSessions.mockResolvedValue({ sessions: [] });
    api.fetchChatTags.mockResolvedValue({ tags: [] });
    api.fetchChatMessages.mockResolvedValue({ messages: [] });
    api.fetchChatSession.mockResolvedValue({ session: null });
    api.attachChatStream.mockResolvedValue(undefined);
    api.fetchSettings.mockResolvedValue({});
    api.fetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "mock", defaultModelId: "scripted" });
    api.fetchAgents.mockResolvedValue([]);
    api.fetchDiscoveredSkills.mockResolvedValue([]);
    api.fetchTasks.mockResolvedValue([]);
    api.searchFiles.mockResolvedValue({ files: [] });
    notesApi.fetchNotes.mockResolvedValue({ notes: [] });
    notesApi.fetchNote.mockResolvedValue(null);
    notesApi.createNote.mockResolvedValue(null);
    notesApi.updateNote.mockResolvedValue(null);
    notesApi.deleteNote.mockResolvedValue(undefined);
  });

  it("relie la vraie liste Chat Alpha à une fenêtre dédiée sans dupliquer", async () => {
    const existing = session("chat-existing", "project-a", "Conversation du dock", "2026-09-12T01:00:00.000Z");
    api.fetchChatSessions.mockResolvedValue({ sessions: [existing] });
    localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "chat");
    render(<IntegrationProviders><AppCompositionHarness projectId="project-a" /></IntegrationProviders>);

    const row = await screen.findByTestId(`chat-session-${existing.id}`);
    expect(screen.queryByTestId(`chat-session-window-state-${existing.id}`)).toBeNull();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByTestId(`chat-session-window-state-${existing.id}`)).toHaveTextContent("Open"));
    expect(screen.getAllByTestId(`floating-window-chat-window-project-a-${existing.id}`)).toHaveLength(1);

    fireEvent.click(row);
    expect(screen.getAllByTestId(`floating-window-chat-window-project-a-${existing.id}`)).toHaveLength(1);

    fireEvent.click(screen.getByTestId("minimize-chats"));
    expect(screen.getByTestId(`chat-session-window-state-${existing.id}`)).toHaveTextContent("Minimized");

    const updated = session(existing.id, "project-a", "Conversation alimentée", "2026-09-12T02:00:00.000Z");
    act(() => sse.handlers["chat:session:updated"]?.({ data: JSON.stringify(updated) } as MessageEvent));
    expect(await screen.findByText(updated.title)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`chat-session-${existing.id}`));
    expect(screen.getByTestId(`chat-session-window-state-${existing.id}`)).toHaveTextContent("Open");
    expect(screen.getAllByTestId(`floating-window-chat-window-project-a-${existing.id}`)).toHaveLength(1);

    const created = session("chat-created", "project-a", "Conversation créée", "2026-09-12T03:00:00.000Z");
    api.createChatSession.mockResolvedValue({ session: created });
    fireEvent.click(screen.getByTestId("chat-new-btn"));
    expect(await screen.findByTestId(`chat-session-${created.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`chat-session-window-state-${created.id}`)).toHaveTextContent("Open");
    expect(screen.getByTestId(`floating-window-chat-window-project-a-${created.id}`)).toBeInTheDocument();
  });

  it("relie la vraie liste Notes Alpha à une fenêtre dédiée par note", async () => {
    const note = { id: "note-existing", title: "Note du dock", content: "Contenu", revision: 1, createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T01:00:00.000Z" };
    notesApi.fetchNotes.mockResolvedValue({ notes: [note] });
    notesApi.fetchNote.mockResolvedValue(note);
    localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "notes");
    render(<AppCompositionHarness projectId="project-a" />);

    const row = await screen.findByRole("button", { name: /Note du dock/ });
    fireEvent.click(row);
    expect(await screen.findByTestId("floating-window-note-project-a-note-existing")).toBeInTheDocument();
    expect(document.querySelector(".notes-view--list-only .notes-detail")).toBeNull();
    fireEvent.click(row);
    expect(screen.getAllByTestId("floating-window-note-project-a-note-existing")).toHaveLength(1);
  });

  it("isole la composition réelle au changement de projet", async () => {
    const first = session("same-id", "project-a", "Projet A", "2026-09-12T01:00:00.000Z");
    const second = session("same-id", "project-b", "Projet B", "2026-09-12T02:00:00.000Z");
    api.fetchChatSessions.mockImplementation(async (projectId: string) => ({
      sessions: projectId === "project-a" ? [first] : [second],
    }));
    localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "chat");
    const view = render(<IntegrationProviders><AppCompositionHarness projectId="project-a" /></IntegrationProviders>);

    fireEvent.click(await screen.findByTestId(`chat-session-${first.id}`));
    expect(await screen.findByTestId("floating-window-chat-window-project-a-same-id")).toBeInTheDocument();

    view.rerender(<IntegrationProviders><AppCompositionHarness projectId="project-b" /></IntegrationProviders>);
    expect(await screen.findByText("Projet B")).toBeInTheDocument();
    expect(screen.queryByTestId("floating-window-chat-window-project-a-same-id")).toBeNull();
    expect(screen.queryByTestId(`chat-session-window-state-${second.id}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`chat-session-${second.id}`));
    expect(await screen.findByTestId("floating-window-chat-window-project-b-same-id")).toBeInTheDocument();
  });

  it("conserve le Chat standard comme navigation interne sans fenêtre dédiée", async () => {
    const existing = session("chat-standard", "project-a", "Conversation standard", "2026-09-12T01:00:00.000Z");
    api.fetchChatSessions.mockResolvedValue({ sessions: [existing] });
    localStorage.setItem(RIGHT_DOCK_VIEW_STORAGE_KEY, "chat");
    render(<IntegrationProviders><AppCompositionHarness projectId="project-a" hostMode="standard" /></IntegrationProviders>);

    fireEvent.click(await screen.findByTestId(`chat-session-${existing.id}`));
    expect(await screen.findByTestId("chat-back-btn")).toBeInTheDocument();
    expect(screen.queryByTestId(`floating-window-chat-window-project-a-${existing.id}`)).toBeNull();
    expect(screen.queryByTestId(`chat-session-window-state-${existing.id}`)).toBeNull();
  });

  it("synchronise création, événement, déduplication et état minimisé dans le projet courant", async () => {
    const created = session("chat-shared", "project-a", "Nouvelle conversation", "2026-09-12T01:00:00.000Z");
    api.createChatSession.mockResolvedValue({ session: created });
    const { result } = renderHook(() => useProductionOwnership("project-a"));
    await waitFor(() => expect(result.current.chat.sessionsLoading).toBe(false));

    let newSession: Awaited<ReturnType<typeof result.current.chat.createSession>>;
    await act(async () => {
      newSession = await result.current.chat.createSession({ agentId: "agent-1", title: created.title ?? undefined }, { keepActiveSession: true });
      result.current.windows.openSessionInNewWindow(newSession);
    });

    expect(result.current.chat.sessions.map((item) => item.id)).toEqual([created.id]);
    expect(result.current.windows.chats.entries).toHaveLength(1);
    expect(result.current.windows.openChatWindows.get(created.id)).toBe("open");

    const updated = session(created.id, "project-a", "Conversation alimentée", "2026-09-12T02:00:00.000Z");
    act(() => sse.handlers["chat:session:updated"]?.({ data: JSON.stringify(updated) } as MessageEvent));
    await waitFor(() => expect(result.current.chat.sessions[0]).toMatchObject({ title: updated.title, updatedAt: updated.updatedAt }));

    act(() => result.current.windows.openSessionInNewWindow(result.current.chat.sessions[0]));
    expect(result.current.windows.chats.entries).toHaveLength(1);
    expect(result.current.windows.chats.entries[0]).toMatchObject({ focusNonce: 2, session: { title: updated.title } });

    act(() => result.current.windows.chats.minimizeAll());
    expect(result.current.windows.openChatWindows.get(created.id)).toBe("minimized");
    act(() => result.current.windows.openSessionInNewWindow(result.current.chat.sessions[0]));
    expect(result.current.windows.openChatWindows.get(created.id)).toBe("open");
  });

  it("isole les fenêtres entre projets et refuse les ouvertures sans projet", () => {
    const first = session("same-id", "project-a", "Projet A", "2026-09-12T01:00:00.000Z");
    const second = session("same-id", "project-b", "Projet B", "2026-09-12T02:00:00.000Z");
    const noteA = { id: "same-note", title: "Note A", createdAt: first.createdAt, updatedAt: first.updatedAt };
    const noteB = { id: "same-note", title: "Note B", createdAt: second.createdAt, updatedAt: second.updatedAt };
    const { result, rerender } = renderHook(({ projectId }: { projectId?: string }) => useAppAlphaDesktopRightDockWindows(projectId), {
      initialProps: { projectId: "project-a" },
    });

    act(() => {
      result.current.openSessionInNewWindow(first);
      result.current.openNoteInWindow(noteA);
    });
    expect(result.current.openChatWindows.get(first.id)).toBe("open");

    rerender({ projectId: "project-b" });
    expect(result.current.openChatWindows.size).toBe(0);
    act(() => {
      result.current.openSessionInNewWindow(second);
      result.current.openNoteInWindow(noteB);
    });
    expect(result.current.chats.entries.map((entry) => `${entry.projectId}:${entry.session.title}`)).toEqual([
      "project-a:Projet A",
      "project-b:Projet B",
    ]);
    expect(result.current.notes.entries.map((entry) => `${entry.projectId}:${entry.note.title}`)).toEqual([
      "project-a:Note A",
      "project-b:Note B",
    ]);
    expect(result.current.openChatWindows.get(second.id)).toBe("open");

    rerender({ projectId: undefined });
    act(() => {
      result.current.openSessionInNewWindow(session("blocked", "project-a", "Sans projet", first.updatedAt));
      result.current.openNoteInWindow({ ...noteA, id: "blocked" });
    });
    expect(result.current.openChatWindows.size).toBe(0);
    expect(result.current.chats.entries).toHaveLength(2);
    expect(result.current.notes.entries).toHaveLength(2);
  });
});
