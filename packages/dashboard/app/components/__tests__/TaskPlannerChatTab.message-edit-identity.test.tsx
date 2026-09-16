/*
FNXC:ChatMessageEdit 2026-09-16-05:58:
FN-459. The task planner chat shares the same optimistic-bubble problem as the direct Chat: its
`optimistic-<ts>` row was only ever reconciled by CONTENT equality inside
`mergePlannerTranscriptWithOptimistic`, which cannot distinguish two identical consecutive sends.
These tests pin the in-band `user_message` replacement by EXACT optimistic id, and confirm the
affordance still appears as soon as a row is persisted (`msg-<uuid8>`) and stays hidden while sending.
*/
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";
import { __test_resetChatSnippetsCache } from "../../hooks/useChatSnippetsCache";

const mockModelCatalog = vi.hoisted(() => ({
  favoriteProviders: [] as string[],
  favoriteModels: [] as string[],
  refresh: vi.fn().mockResolvedValue(undefined),
  providerInstances: {} as Record<string, { instances: [] }>,
  models: [{ provider: "anthropic", id: "claude-plan", name: "Claude Plan", reasoning: true, contextWindow: 200000 }],
}));

const {
  mockEnsureTaskPlannerChatSession,
  mockFetchTaskPlannerChatSession,
  mockFetchChatSession,
  mockFetchChatMessages,
  mockFetchSettings,
  mockFetchGlobalSettings,
  mockUpdateGlobalSettings,
  mockFetchTaskDetail,
  mockUpdateChatSession,
  mockStreamChatResponse,
  mockAttachChatStream,
  mockCancelChatResponse,
} = vi.hoisted(() => ({
  mockEnsureTaskPlannerChatSession: vi.fn(),
  mockFetchTaskPlannerChatSession: vi.fn(),
  mockFetchChatSession: vi.fn(),
  mockFetchChatMessages: vi.fn(),
  mockFetchSettings: vi.fn().mockResolvedValue({}),
  mockFetchGlobalSettings: vi.fn().mockResolvedValue({ chatSnippets: [] }),
  mockUpdateGlobalSettings: vi.fn().mockResolvedValue({ chatSnippets: [] }),
  mockFetchTaskDetail: vi.fn(),
  mockUpdateChatSession: vi.fn(),
  mockStreamChatResponse: vi.fn(),
  mockAttachChatStream: vi.fn(),
  mockCancelChatResponse: vi.fn(),
}));

vi.mock("../../hooks/useModelsCache", () => ({
  useModelsCache: () => ({
    models: mockModelCatalog.models,
    favoriteProviders: mockModelCatalog.favoriteProviders,
    favoriteModels: mockModelCatalog.favoriteModels,
    refresh: mockModelCatalog.refresh,
  }),
}));
vi.mock("../../hooks/useVoiceDictation", () => ({
  useVoiceDictation: () => ({
    enabled: true,
    supported: true,
    state: "idle",
    partialText: "",
    finalText: "",
    error: undefined,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Loader2: (props: Record<string, unknown>) => React.createElement("svg", { "data-testid": "loader2-icon", ...props }),
    Maximize2: (props: Record<string, unknown>) => React.createElement("svg", { "data-testid": "maximize2-icon", ...props }),
    Minimize2: (props: Record<string, unknown>) => React.createElement("svg", { "data-testid": "minimize2-icon", ...props }),
    Send: (props: Record<string, unknown>) => React.createElement("svg", { "data-testid": "send-icon", ...props }),
  };
});
/*
FNXC:DashboardTests 2026-09-16-05:58:
`t` MUST be a stable hoisted function. Returning a fresh arrow from `useTranslation()` on every render
makes every effect that depends on `t` re-run forever, which surfaces as "Maximum update depth
exceeded" and silently prevents the inline editor from ever opening.
*/
const mockT = vi.hoisted(() => (key: string, fallback?: string | { defaultValue?: string }) =>
  (typeof fallback === "string" ? fallback : fallback?.defaultValue) ?? key);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mockT }),
}));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    ensureTaskPlannerChatSession: mockEnsureTaskPlannerChatSession,
    fetchTaskPlannerChatSession: mockFetchTaskPlannerChatSession,
    fetchChatSession: mockFetchChatSession,
    fetchChatMessages: mockFetchChatMessages,
    fetchSettings: mockFetchSettings,
    fetchGlobalSettings: mockFetchGlobalSettings,
    updateGlobalSettings: mockUpdateGlobalSettings,
    fetchTaskDetail: mockFetchTaskDetail,
    updateChatSession: mockUpdateChatSession,
    streamChatResponse: mockStreamChatResponse,
    attachChatStream: mockAttachChatStream,
    cancelChatResponse: mockCancelChatResponse,
  };
});

function makeTask(id: string) {
  return {
    id,
    description: "Test task",
    column: "todo",
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    planningModelProvider: "anthropic",
    planningModelId: "claude-plan",
  } as never;
}

function makePlannerSession() {
  return {
    id: "chat-planner",
    agentId: "task-planner:FN-459",
    title: "FN-459 planner chat",
    status: "active",
    projectId: null,
    modelProvider: "anthropic",
    modelId: "claude-plan",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    cliSessionFile: null,
    cliExecutorAdapterId: null,
    inFlightGeneration: null,
  };
}

function persistedUserRow(id: string, content: string, createdAt: string) {
  return { id, sessionId: "chat-planner", role: "user", content, thinkingOutput: null, metadata: null, createdAt };
}

function renderPlannerChat() {
  return render(
    <TaskPlannerChatTab
      task={makeTask("FN-459")}
      active
      taskChatModel={{ provider: "anthropic", modelId: "claude-plan" }}
      addToast={vi.fn()}
    />,
  );
}

/**
 * Drive the planner edit path, the same seam the FN-459 defect lived on: the pencil opens the inline
 * editor, Save issues ONE replacement-aware stream whose optimistic bubble must be retired by the
 * in-band `user_message` event.
 */
async function editPlannerMessage(messageId: string, text: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByTestId(`chat-message-edit-${messageId}`));
  const editor = await screen.findByTestId(`chat-message-edit-editor-${messageId}`);
  const textarea = editor.querySelector("textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  await user.click(screen.getByText("Save"));
}

describe("TaskPlannerChatTab persisted message identity (FN-459)", () => {
  const streamHandlers: Array<Record<string, (payload: never) => void>> = [];

  beforeEach(() => {
    __test_resetChatSnippetsCache();
    vi.clearAllMocks();
    streamHandlers.length = 0;
    const session = makePlannerSession();
    mockFetchTaskPlannerChatSession.mockResolvedValue({ session });
    mockFetchChatSession.mockResolvedValue({ session });
    mockEnsureTaskPlannerChatSession.mockResolvedValue({ session });
    mockFetchChatMessages.mockResolvedValue({ messages: [] });
    mockFetchTaskDetail.mockResolvedValue(makeTask("FN-459"));
    mockUpdateChatSession.mockResolvedValue({ session });
    mockFetchGlobalSettings.mockReturnValue(new Promise(() => {}));
    mockAttachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
    mockCancelChatResponse.mockResolvedValue({ success: true, interrupted: false });
    mockStreamChatResponse.mockImplementation(((_sessionId: string, _content: string, handlers: never) => {
      streamHandlers.push(handlers as unknown as Record<string, (payload: never) => void>);
      return { close: vi.fn(), isConnected: () => true };
    }) as never);
  });

  it("(a) replaces the optimistic replacement bubble with the persisted row from the in-band user_message", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [persistedUserRow("msg-history01", "bonjour", "2026-09-16T00:00:00.500Z")],
    });
    renderPlannerChat();
    await screen.findByText("bonjour");

    await editPlannerMessage("msg-history01", "bonjour corrigé");
    await waitFor(() => expect(streamHandlers).toHaveLength(1));
    // The replacement turn shows a purely local `optimistic-<ts>` bubble until the server answers.
    await waitFor(() => expect(document.querySelector('[data-message-id^="optimistic-"]')).toBeTruthy());

    await act(async () => {
      streamHandlers[0]!.onUserMessage?.({
        message: persistedUserRow("msg-ab12cd34", "bonjour corrigé", "2026-09-16T00:00:01.000Z"),
      } as never);
    });

    await waitFor(() => expect(screen.getByTestId("chat-message-msg-ab12cd34")).toBeInTheDocument());
    expect(document.querySelector('[data-message-id^="optimistic-"]')).toBeNull();
  });

  it("(b) does not confuse two turns carrying identical text", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [
        persistedUserRow("msg-first001", "même texte", "2026-09-16T00:00:00.500Z"),
        persistedUserRow("msg-keepme002", "même texte", "2026-09-16T00:00:00.600Z"),
      ],
    });
    renderPlannerChat();
    await screen.findByTestId("chat-message-msg-keepme002");

    // Edit the SECOND row, whose content is identical to the first: a content-equality join would
    // have replaced the wrong bubble. The id-based join must leave the first row untouched.
    await editPlannerMessage("msg-keepme002", "même texte corrigé");
    await waitFor(() => expect(streamHandlers).toHaveLength(1));

    await act(async () => {
      streamHandlers[0]!.onUserMessage?.({
        message: persistedUserRow("msg-second02", "même texte corrigé", "2026-09-16T00:00:05.000Z"),
      } as never);
    });

    await waitFor(() => expect(screen.getByTestId("chat-message-msg-second02")).toBeInTheDocument());
    expect(screen.getByTestId("chat-message-msg-first001")).toBeInTheDocument();
    expect(document.querySelector('[data-message-id^="optimistic-"]')).toBeNull();
  });

  it("(c) hides the pencil while sending and offers it again on the persisted row once idle", async () => {
    mockFetchChatMessages.mockResolvedValue({
      messages: [persistedUserRow("msg-history01", "bonjour", "2026-09-16T00:00:00.500Z")],
    });
    renderPlannerChat();
    // A persisted `msg-<uuid8>` row is editable at rest — the guard narrows the affordance, it does
    // not remove it.
    expect(await screen.findByTestId("chat-message-edit-msg-history01")).toBeInTheDocument();

    await editPlannerMessage("msg-history01", "bonjour corrigé");
    await waitFor(() => expect(streamHandlers).toHaveLength(1));

    await act(async () => {
      streamHandlers[0]!.onUserMessage?.({
        message: persistedUserRow("msg-ab12cd34", "bonjour corrigé", "2026-09-16T00:00:01.000Z"),
      } as never);
    });

    // Persisted, but a generation is still in flight: no pencil while composerState is "sending".
    await waitFor(() => expect(screen.getByTestId("chat-message-msg-ab12cd34")).toBeInTheDocument());
    expect(screen.queryByTestId("chat-message-edit-msg-ab12cd34")).toBeNull();

    mockFetchChatMessages.mockResolvedValue({
      messages: [persistedUserRow("msg-ab12cd34", "bonjour corrigé", "2026-09-16T00:00:01.000Z")],
    });
    await act(async () => {
      streamHandlers[0]!.onDone?.({ messageId: "msg-reply1" } as never);
    });

    expect(await screen.findByTestId("chat-message-edit-msg-ab12cd34")).toBeInTheDocument();
  });
});
