import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComposeChatPanel } from "../ComposeChatPanel";
import { QuickEntryBox } from "../QuickEntryBox";
import { TaskComments } from "../TaskComments";
import { TaskForm } from "../TaskForm";
import { NewTaskModal } from "../NewTaskModal";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";
import { TaskChatTab } from "../TaskChatTab";
import { PlanningModeModal, QuestionForm, SummaryView } from "../PlanningModeModal";
import { StandardChatMessageItem } from "../StandardChatSurface";
import { ChatView } from "../ChatView";
import { QuickChatFAB } from "../QuickChatFAB";
import { ToastProvider } from "../../hooks/useToast";
import { NavigationHistoryProvider } from "../../hooks/useNavigationHistory";

const mockFetchAiSession = vi.hoisted(() => vi.fn());

let voice = {
  enabled: true,
  supported: true,
  state: "idle" as "idle" | "listening" | "transcribing" | "error",
  partialText: "",
  finalText: "",
  error: undefined as string | undefined,
  start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};
const voiceListeners = new Set<() => void>();
const voiceProjectIds: Array<string | undefined> = [];

vi.mock("../../hooks/useVoiceDictation", async () => {
  const React = await import("react");
  return {
    useVoiceDictation: (projectId?: string) => {
      voiceProjectIds.push(projectId);
      return React.useSyncExternalStore(
      (listener) => { voiceListeners.add(listener); return () => voiceListeners.delete(listener); },
      () => voice,
      () => voice,
    );
    },
  };
});

const chatSession = { id: "voice-session", agentId: "agent-1", status: "active", title: "Voice", createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z" };
const chatState = {
  sessions: [chatSession], activeSession: chatSession, sessionsLoading: false, messages: [], messagesLoading: false,
  isStreaming: false, streamingText: "", streamingThinking: "", streamingToolCalls: [], selectSession: vi.fn(),
  createSession: vi.fn(), archiveSession: vi.fn(), renameSession: vi.fn(), pinSession: vi.fn(), pinnedCount: 0,
  setSessionModel: vi.fn(), setSessionThinkingLevel: vi.fn(), deleteSession: vi.fn(), tags: [], selectedTagId: null,
  setSelectedTagId: vi.fn(), createTag: vi.fn(), renameTag: vi.fn(), deleteTag: vi.fn(), setSessionTags: vi.fn(),
  sendMessage: vi.fn(), editMessageAndResend: vi.fn(), stopStreaming: vi.fn(), pendingMessages: [], clearPendingMessage: vi.fn(),
  loadMoreMessages: vi.fn(), hasMoreMessages: false, searchQuery: "", setSearchQuery: vi.fn(), filteredSessions: [chatSession],
  agentsMap: new Map(),
};
vi.mock("../../hooks/useChat", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../hooks/useChat")>()), useChat: () => chatState }));
vi.mock("../../hooks/useChatRooms", () => ({ useChatRooms: () => ({ rooms: [], roomsLoading: false, roomsError: null, activeRoom: null, activeRoomMembers: [], messages: [], messagesLoading: false, selectRoom: vi.fn(), createRoom: vi.fn(), deleteRoom: vi.fn(), sendRoomMessage: vi.fn(), clearRoom: vi.fn(), refreshRooms: vi.fn() }) }));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()), useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) }));
vi.mock("../../api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../api")>()), fetchAiSession: (...args: unknown[]) => mockFetchAiSession(...args), fetchSettings: vi.fn().mockResolvedValue({}), fetchAgents: vi.fn().mockResolvedValue([]), fetchDiscoveredSkills: vi.fn().mockResolvedValue([]), fetchTasks: vi.fn().mockResolvedValue([]), searchFiles: vi.fn().mockResolvedValue({ files: [] }) }));

function setVoice(next: Partial<typeof voice>) {
  voice = { ...voice, ...next };
  voiceListeners.forEach((listener) => listener());
}

function taskWithComment() {
  return {
    id: "FN-8573", description: "Voice", column: "todo", dependencies: [], steps: [], currentStep: 0, log: [],
    createdAt: "2026-07-24T00:00:00.000Z", updatedAt: "2026-07-24T00:00:00.000Z",
    comments: [{ id: "comment-1", text: "Original", author: "user", createdAt: "2026-07-24T00:00:00.000Z" }],
  } as any;
}

const formProps = {
  mode: "create" as const, description: "", onDescriptionChange: vi.fn(), dependencies: [], onDependenciesChange: vi.fn(),
  executorModel: "", onExecutorModelChange: vi.fn(), validatorModel: "", onValidatorModelChange: vi.fn(),
  presetMode: "default" as const, onPresetModeChange: vi.fn(), selectedPresetId: "", onSelectedPresetIdChange: vi.fn(),
  selectedWorkflowId: undefined, onWorkflowIdChange: vi.fn(), pendingImages: [], onImagesChange: vi.fn(), tasks: [],
  addToast: vi.fn(), isActive: true, reviewLevel: undefined, onReviewLevelChange: vi.fn(),
};

function ControlledTaskForm() {
  const [description, setDescription] = useState("");
  return <TaskForm {...formProps} description={description} onDescriptionChange={setDescription} />;
}

/** Mirrors App's FAB → full ChatView handoff so this test exercises the reachable shared composer. */
function QuickChatVoicePath() {
  const [open, setOpen] = useState(false);
  return <>
    <QuickChatFAB open={open} onToggle={() => setOpen((current) => !current)} />
    {open && <ChatView projectId="project-1" addToast={vi.fn()} floating />}
  </>;
}

function ControlledSummaryView() {
  const [summary, setSummary] = useState({ title: "Voice", description: "before-after", priority: "normal", suggestedDependencies: [] } as any);
  return <SummaryView projectId="project-1" summary={summary} historyEntries={[]} onSummaryChange={setSummary} tasks={[]} branchMode="project-default" branchName="" baseBranch="main" onBranchModeChange={vi.fn()} onBranchNameChange={vi.fn()} onBaseBranchChange={vi.fn()} onCreateTask={vi.fn()} onBreakIntoTasks={vi.fn()} isCreatingTask={false} isStartingBreakdown={false} isRefiningSummary={false} />;
}

/** Reaches the modal's primary refinement composer rather than a shallow surrogate. */
async function renderRefinementComposer() {
  mockFetchAiSession.mockResolvedValue({
    id: "voice-refinement", title: "Voice refinement", projectId: "project-1", updatedAt: "2026-07-24T00:00:00.000Z", archived: false,
    status: "awaiting_input", currentQuestion: JSON.stringify({ id: "voice-question", type: "text", question: "What should change?" }),
    result: JSON.stringify({ title: "Voice", description: "before-after", priority: "normal", suggestedDependencies: [] }), inputPayload: "{}", conversationHistory: "[]", thinkingOutput: "",
  });
  const view = render(<ToastProvider><NavigationHistoryProvider value={{ pushNav: vi.fn(), removeNav: vi.fn() } as any}><PlanningModeModal isOpen presentation="modal" onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} projectId="project-1" resumeSessionId="voice-refinement" /></NavigationHistoryProvider></ToastProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Refine" }));
  return view;
}

/*
FNXC:ChatNavigation 2026-08-23-17:05:
FN-054 made Chat list-first: a composer exists only inside an explicitly opened conversation, so
every real ChatView surface in this inventory must drill in from the list before a mic can render.
*/
function openDirectThread() {
  fireEvent.click(screen.getByTestId(`chat-session-${chatSession.id}`));
}

const primarySurfaceRenders = [
  { name: "ChatView primary composer", render: () => { const result = render(<ChatView projectId="project-1" addToast={vi.fn()} />); openDirectThread(); return result; } },
  { name: "StandardChatSurface correction composer", render: () => { const result = render(<StandardChatMessageItem message={{ id: "message-1", role: "user", content: "Populated", createdAt: "2026-07-24T00:00:00.000Z" } as any} forcePlain={false} agentName="Agent" hideAssistantIdentity={false} showAssistantModelTag={false} activeSessionId="session-1" canEdit onEditMessage={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: /edit/i })); return result; } },
  { name: "QuickChatFAB-opened shared ChatView composer", render: () => { const result = render(<QuickChatVoicePath />); fireEvent.click(screen.getByTestId("quick-chat-fab")); openDirectThread(); return result; } },
  { name: "ComposeChatPanel request composer", render: () => render(<ComposeChatPanel embeds={[]} draftBody="" onUseDraft={vi.fn()} onClose={vi.fn()} />) },
  { name: "TaskPlannerChatTab composer", render: () => render(<ToastProvider><NavigationHistoryProvider value={{ pushNav: vi.fn(), removeNav: vi.fn() } as any}><TaskPlannerChatTab task={taskWithComment()} active taskChatModel={{ provider: "mock", modelId: "mock" }} addToast={vi.fn()} /></NavigationHistoryProvider></ToastProvider>) },
  { name: "TaskChatTab composer", render: () => render(<TaskChatTab task={taskWithComment()} active projectId="project-1" addToast={vi.fn()} />) },
  { name: "QuickEntryBox composer", render: () => render(<QuickEntryBox addToast={vi.fn()} tasks={[]} defaultExpanded />) },
  { name: "TaskForm description composer", render: () => render(<ControlledTaskForm />) },
  { name: "NewTaskModal inherited TaskForm composer", render: () => render(<NewTaskModal isOpen projectId="project-1" tasks={[]} onClose={vi.fn()} onCreateTask={vi.fn()} addToast={vi.fn()} />) },
  { name: "TaskComments new composer", render: () => render(<TaskComments task={taskWithComment()} addToast={vi.fn()} />) },
  { name: "TaskComments edit composer", render: () => { const result = render(<TaskComments task={taskWithComment()} addToast={vi.fn()} />); fireEvent.click(screen.getByRole("button", { name: "Edit" })); return result; } },
  { name: "PlanningModeModal initial-plan composer", render: () => render(<ToastProvider><NavigationHistoryProvider value={{ pushNav: vi.fn(), removeNav: vi.fn() } as any}><PlanningModeModal isOpen presentation="modal" onClose={vi.fn()} onTaskCreated={vi.fn()} onTasksCreated={vi.fn()} tasks={[]} /></NavigationHistoryProvider></ToastProvider>) },
  { name: "PlanningModeModal free-text answer composer", render: () => render(<QuestionForm question={{ id: "voice-question", type: "text", question: "Describe it" } as any} onSubmit={vi.fn()} />) },
  { name: "PlanningModeModal summary description composer", render: () => {
    const view = render(<ControlledSummaryView />);
    fireEvent.click(screen.getByRole("button", { name: "Show raw text" }));
    return view;
  } },
] as const;

async function exerciseRealComposer(renderSurface: () => ReturnType<typeof render>) {
  const view = renderSurface();
  await act(async () => undefined);
  const root = view.container.querySelector("textarea") ? view.container : document;
  const textarea = root.querySelector("textarea") as HTMLTextAreaElement | null;
  const mic = root.querySelector("button[aria-label='Start voice dictation']") as HTMLButtonElement | null;
  expect(textarea).not.toBeNull();
  expect(mic).not.toBeNull();
  fireEvent.change(textarea!, { target: { value: "before-after" } });
  textarea!.setSelectionRange("before".length, "before".length);
  fireEvent.click(mic!);
  act(() => setVoice({ state: "listening", partialText: "partial", finalText: "" }));
  expect(textarea).toHaveValue("beforepartial-after");
  act(() => setVoice({ partialText: "partial-next" }));
  expect(textarea).toHaveValue("beforepartial-next-after");
  act(() => setVoice({ state: "idle", partialText: "", finalText: "final" }));
  expect(textarea).toHaveValue("beforefinal-after");
  view.unmount();
}

describe("voice dictation composer inventory", () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.clearAllMocks(); voiceProjectIds.length = 0;
    await act(async () => { setVoice({ enabled: true, supported: true, state: "idle", partialText: "", finalText: "", error: undefined }); });
  });
  afterEach(cleanup);

  it("passes explicit project identity while preserving default-project composers", () => {
    for (const surface of primarySurfaceRenders) {
      const view = surface.render();
      view.unmount();
    }
    expect(voiceProjectIds).toContain("project-1");
    expect(voiceProjectIds).toContain(undefined);
  });

  it("opens the reachable shared ChatView composer from QuickChatFAB", () => {
    render(<QuickChatVoicePath />);
    fireEvent.click(screen.getByTestId("quick-chat-fab"));
    openDirectThread();
    expect(screen.getByRole("button", { name: "Start voice dictation" })).toBeInTheDocument();
  });

  it("opens and dictates into the reachable PlanningModeModal refinement editor", async () => {
    const view = await renderRefinementComposer();
    await exerciseRealComposer(() => view);
  });

  it.each(primarySurfaceRenders)("renders exactly a shared mic on $name and removes its subscription on unmount", ({ render: renderSurface }) => {
    const listenersBefore = voiceListeners.size;
    const view = renderSurface();
    expect(screen.getAllByRole("button", { name: "Start voice dictation" }).length).toBeGreaterThan(0);
    view.unmount();
    expect(voiceListeners.size).toBe(listenersBefore);
  });

  it.each([
    ["voice mode is disabled", { enabled: false }],
    ["runtime status is pending", { supported: false }],
    ["runtime status request failed", { supported: false }],
    ["runtime is unavailable", { supported: false }],
  ] as const)("renders no shell or dangling label on every real composer when %s", async (_caseName, gate) => {
    setVoice(gate);
    for (const surface of primarySurfaceRenders) {
      const view = surface.render();
      expect(screen.queryByRole("button", { name: /voice dictation/i })).not.toBeInTheDocument();
      expect(document.querySelectorAll(".mic-button")).toHaveLength(0);
      expect(document.querySelectorAll("[aria-label*='voice dictation' i]")).toHaveLength(0);
      view.unmount();
    }
    // The refinement editor is reachable only after resuming and opening a modal session.
    const refinementView = await renderRefinementComposer();
    expect(screen.queryByRole("button", { name: /voice dictation/i })).not.toBeInTheDocument();
    expect(document.querySelectorAll(".mic-button")).toHaveLength(0);
    expect(document.querySelectorAll("[aria-label*='voice dictation' i]")).toHaveLength(0);
    refinementView.unmount();
  });

  it.each(primarySurfaceRenders.filter((surface) => surface.name !== "QuickEntryBox composer"))("drives anchored partial → final replacement through real $name", async ({ render: renderSurface }) => {
    await exerciseRealComposer(renderSurface);
  });

  it("drives anchored partial → final replacement through the real QuickEntryBox composer", async () => {
    const view = render(<QuickEntryBox onCreate={async () => undefined} addToast={vi.fn()} tasks={[]} defaultExpanded />);
    await act(async () => undefined);
    const textarea = view.container.querySelector("textarea")!;
    const mic = view.container.querySelector("button[aria-label='Start voice dictation']")!;
    fireEvent.change(textarea, { target: { value: "before-after" } });
    textarea.setSelectionRange("before".length, "before".length);
    fireEvent.click(mic);
    act(() => setVoice({ state: "listening", partialText: "partial", finalText: "" }));
    expect(textarea).toHaveValue("beforepartial-after");
    act(() => setVoice({ partialText: "partial-next" }));
    expect(textarea).toHaveValue("beforepartial-next-after");
    act(() => setVoice({ state: "idle", partialText: "", finalText: "final" }));
    expect(textarea).toHaveValue("beforefinal-after");
  });

  it("leaves no mobile composer shell when voice mode is disabled", () => {
    setVoice({ enabled: false });
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as any;
    render(<ComposeChatPanel embeds={[]} draftBody="" onUseDraft={vi.fn()} onClose={vi.fn()} />);
    expect(document.querySelectorAll(".mic-button")).toHaveLength(0);
    expect(document.querySelectorAll("[aria-label*='voice dictation' i]")).toHaveLength(0);
  });
});
