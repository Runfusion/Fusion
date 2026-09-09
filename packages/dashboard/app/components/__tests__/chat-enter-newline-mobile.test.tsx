import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Agent, AgentLogEntry, Task } from "@fusion/core";
import { ChatSubmitOnEnterProvider, type ChatSubmitOnEnterMode } from "../../context/ChatSubmitOnEnterContext";
import { QuickAddSubmitOnEnterProvider } from "../../hooks/useQuickAddSubmitOnEnter";
import { COARSE_POINTER_MEDIA_QUERY } from "../../hooks/useCoarsePointer";
import { __test_resetChatSnippetsCache } from "../../hooks/useChatSnippetsCache";
import { TaskChatTab } from "../TaskChatTab";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";
import { QuickEntryBox } from "../QuickEntryBox";
import { useAgentLogs } from "../../hooks/useAgentLogs";
import {
  activeSessionFixture,
  installChatViewEnv,
  renderChatDetailWithAct,
  setupMockChat,
} from "./ChatView.test-harness";
import { ChatView } from "../ChatView";

const apiMocks = vi.hoisted(() => ({
  addSteeringComment: vi.fn(),
  refineTask: vi.fn(),
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchSettings: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  fetchTasks: vi.fn(),
  searchFiles: vi.fn(),
  fetchChatSession: vi.fn(),
  ensureTaskPlannerChatSession: vi.fn(),
  fetchTaskPlannerChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  fetchTaskDetail: vi.fn(),
  updateChatSession: vi.fn(),
  streamChatResponse: vi.fn(),
  attachChatStream: vi.fn(),
  cancelChatResponse: vi.fn(),
  checkDuplicateTasks: vi.fn(),
  fetchAuthStatus: vi.fn(),
  fetchWorkflowOptionalSteps: vi.fn(),
  refineText: vi.fn(),
  uploadAttachment: vi.fn(),
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useAgentLogs", () => ({ useAgentLogs: vi.fn() }));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});
vi.mock("../../hooks/useNodes", () => ({ useNodes: () => ({ nodes: [], loading: false, error: null }) }));
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return { ...actual, ...apiMocks };
});

installChatViewEnv();

const snippet = {
  name: "test",
  prompt: "lance toujours les tests avec chrome devtool mcp",
};

const plannerSession = {
  id: "chat-planner",
  agentId: "task-planner:FN-298",
  title: "FN-298 planner chat",
  status: "active",
  projectId: null,
  modelProvider: "anthropic",
  modelId: "claude-plan",
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  cliSessionFile: null,
  cliExecutorAdapterId: null,
  inFlightGeneration: null,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-298",
    title: "Mobile chat newline",
    description: "Test task",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    assignedAgentId: "agent-1",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function installPointer(coarse: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: query === COARSE_POINTER_MEDIA_QUERY ? coarse : query === "(prefers-color-scheme: dark)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function installCoarsePointer() {
  installPointer(true);
}

function installFinePointer() {
  installPointer(false);
}

function dispatchEnter(input: HTMLElement, modifiers: Record<string, boolean | number> = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  for (const [key, value] of Object.entries(modifiers)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  fireEvent(input, event);
  return event;
}

function mockLogs() {
  vi.mocked(useAgentLogs).mockReturnValue({
    entries: [] as AgentLogEntry[],
    loading: false,
    clear: vi.fn(),
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    total: 0,
    loadingMore: false,
  });
}

type ComposerName = "ChatView" | "TaskChatTab" | "TaskPlannerChatTab";

interface RenderedComposer {
  input: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  sendSpy: ReturnType<typeof vi.fn>;
}

async function renderComposer(
  name: ComposerName,
  mode: ChatSubmitOnEnterMode,
  options: { draft?: string; snippets?: boolean; agents?: Agent[] } = {},
): Promise<RenderedComposer> {
  apiMocks.fetchGlobalSettings.mockResolvedValue({ chatSnippets: options.snippets ? [snippet] : [] });

  if (name === "ChatView") {
    const sendSpy = vi.fn();
    const agentsMap = new Map((options.agents ?? []).map((agent) => [agent.id, agent]));
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage: sendSpy, agentsMap });
    await renderChatDetailWithAct(
      <ChatSubmitOnEnterProvider value={mode}>
        <ChatView projectId="project-1" addToast={vi.fn()} />
      </ChatSubmitOnEnterProvider>,
    );
    const input = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    if (options.draft !== undefined) fireEvent.change(input, { target: { value: options.draft } });
    return {
      input,
      sendButton: screen.getByRole("button", { name: "Send" }) as HTMLButtonElement,
      sendSpy,
    };
  }

  if (name === "TaskChatTab") {
    render(
      <ChatSubmitOnEnterProvider value={mode}>
        <TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />
      </ChatSubmitOnEnterProvider>,
    );
    const input = screen.getByLabelText("Message active agent session") as HTMLTextAreaElement;
    if (options.draft !== undefined) fireEvent.change(input, { target: { value: options.draft } });
    return {
      input,
      sendButton: screen.getByRole("button", { name: "Send" }) as HTMLButtonElement,
      sendSpy: apiMocks.addSteeringComment,
    };
  }

  render(
    <ChatSubmitOnEnterProvider value={mode}>
      <TaskPlannerChatTab
        task={makeTask()}
        projectId="project-1"
        active
        taskChatModel={{ provider: "anthropic", modelId: "claude-plan" }}
        addToast={vi.fn()}
      />
    </ChatSubmitOnEnterProvider>,
  );
  const input = await screen.findByLabelText("Message task chat") as HTMLTextAreaElement;
  if (options.draft !== undefined) fireEvent.change(input, { target: { value: options.draft } });
  return {
    input,
    sendButton: screen.getByRole("button", { name: "Send" }) as HTMLButtonElement,
    sendSpy: apiMocks.streamChatResponse,
  };
}

async function openSnippetMenu(name: ComposerName, mode: ChatSubmitOnEnterMode = "auto") {
  const rendered = await renderComposer(name, mode, { draft: name === "TaskPlannerChatTab" ? "/tes" : "/te", snippets: true });
  await screen.findByRole("option", { name: /\/test/i });
  return rendered;
}

beforeEach(() => {
  __test_resetChatSnippetsCache();
  mockLogs();
  apiMocks.addSteeringComment.mockResolvedValue(makeTask());
  apiMocks.refineTask.mockResolvedValue(makeTask({ id: "FN-299", column: "todo" }));
  apiMocks.fetchGlobalSettings.mockResolvedValue({ chatSnippets: [] });
  apiMocks.updateGlobalSettings.mockResolvedValue({ chatSnippets: [] });
  apiMocks.fetchSettings.mockResolvedValue({});
  apiMocks.fetchModels.mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] });
  apiMocks.fetchAgents.mockResolvedValue([]);
  apiMocks.fetchDiscoveredSkills.mockResolvedValue([]);
  apiMocks.fetchTasks.mockResolvedValue([]);
  apiMocks.searchFiles.mockResolvedValue({ files: [] });
  apiMocks.fetchChatSession.mockResolvedValue({ session: plannerSession });
  apiMocks.ensureTaskPlannerChatSession.mockResolvedValue({ session: plannerSession });
  apiMocks.fetchTaskPlannerChatSession.mockResolvedValue({ session: plannerSession });
  apiMocks.fetchChatMessages.mockResolvedValue({ messages: [] });
  apiMocks.fetchTaskDetail.mockResolvedValue(makeTask());
  apiMocks.updateChatSession.mockResolvedValue({ session: plannerSession });
  apiMocks.streamChatResponse.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  apiMocks.attachChatStream.mockReturnValue({ close: vi.fn(), isConnected: () => true });
  apiMocks.cancelChatResponse.mockResolvedValue({ success: true, interrupted: false });
  apiMocks.checkDuplicateTasks.mockResolvedValue([]);
  apiMocks.fetchAuthStatus.mockResolvedValue({ providers: [] });
  apiMocks.fetchWorkflowOptionalSteps.mockResolvedValue([]);
  apiMocks.uploadAttachment.mockResolvedValue({});
});

const composers: ComposerName[] = ["ChatView", "TaskChatTab", "TaskPlannerChatTab"];

for (const composer of composers) {
  describe(composer, () => {
    it.each([
      [true, "auto", false, false],
      [true, "always", true, true],
      [false, "auto", true, true],
      [false, "never", false, false],
    ] as const)(
      "resolves coarse=%s mode=%s for plain Enter",
      async (coarse, mode, sends, prevented) => {
        coarse ? installCoarsePointer() : installFinePointer();
        const { input, sendSpy } = await renderComposer(composer, mode, { draft: "multi-line message" });
        const event = dispatchEnter(input);
        expect(event.defaultPrevented).toBe(prevented);
        if (sends) await waitFor(() => expect(sendSpy).toHaveBeenCalled());
        else expect(sendSpy).not.toHaveBeenCalled();
      },
    );

    it.each([
      [true, "auto", "ctrlKey"],
      [true, "auto", "metaKey"],
      [false, "never", "ctrlKey"],
      [false, "never", "metaKey"],
    ] as const)(
      "sends %s/%s %s+Enter when no menu is open",
      async (coarse, mode, modifier) => {
        coarse ? installCoarsePointer() : installFinePointer();
        const { input, sendSpy } = await renderComposer(composer, mode, { draft: "shortcut message" });
        const event = dispatchEnter(input, { [modifier]: true });
        expect(event.defaultPrevented).toBe(true);
        await waitFor(() => expect(sendSpy).toHaveBeenCalled());
      },
    );

    it.each([true, false])("keeps Shift+Enter as a browser newline with coarse=%s", async (coarse) => {
      coarse ? installCoarsePointer() : installFinePointer();
      const { input, sendSpy } = await renderComposer(composer, "auto", { draft: "line one" });
      const event = dispatchEnter(input, { shiftKey: true });
      expect(event.defaultPrevented).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();
    });

    /*
    FNXC:ChatComposerTests 2026-09-06-01:54:
    Le fait vérifié n° 3 impose l’ordre déjà utilisé par QuickEntryBox : Shift précède l’accélérateur. Ces cas empêchent Cmd/Ctrl+Shift+Enter de devenir un envoi lors d’un futur remaniement.
    */
    it.each([
      [true, "auto", "ctrlKey"],
      [true, "auto", "metaKey"],
      [false, "never", "ctrlKey"],
      [false, "never", "metaKey"],
    ] as const)(
      "keeps Shift ahead of %s/%s %s+Enter",
      async (coarse, mode, modifier) => {
        coarse ? installCoarsePointer() : installFinePointer();
        const { input, sendSpy } = await renderComposer(composer, mode, { draft: "line one" });
        const event = dispatchEnter(input, { shiftKey: true, [modifier]: true });
        expect(event.defaultPrevented).toBe(false);
        expect(sendSpy).not.toHaveBeenCalled();
      },
    );

    it("keeps an empty coarse-pointer draft non-submitting with its send button disabled", async () => {
      installCoarsePointer();
      const { input, sendButton, sendSpy } = await renderComposer(composer, "auto");
      const event = dispatchEnter(input);
      expect(event.defaultPrevented).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();
      expect(sendButton).toBeDisabled();
    });

    it.each([
      [false, true, true],
      [true, false, false],
    ])("treats Alt+Enter like plain Enter with coarse=%s", async (coarse, sends, prevented) => {
      coarse ? installCoarsePointer() : installFinePointer();
      const { input, sendSpy } = await renderComposer(composer, "auto", { draft: "alt message" });
      const event = dispatchEnter(input, { altKey: true });
      expect(event.defaultPrevented).toBe(prevented);
      if (sends) await waitFor(() => expect(sendSpy).toHaveBeenCalled());
      else expect(sendSpy).not.toHaveBeenCalled();
    });

    it.each([
      [true, "enter"],
      [false, "send"],
    ])("sets enterkeyhint for coarse=%s to %s in auto mode", async (coarse, hint) => {
      coarse ? installCoarsePointer() : installFinePointer();
      const { input } = await renderComposer(composer, "auto", { draft: "hint" });
      expect(input).toHaveAttribute("enterkeyhint", hint);
    });

    it("lets a non-empty autocomplete menu consume plain Enter", async () => {
      installCoarsePointer();
      const { input, sendSpy } = await openSnippetMenu(composer);
      const event = dispatchEnter(input);
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(input).toHaveValue(snippet.prompt));
      expect(sendSpy).not.toHaveBeenCalled();
    });

    /*
    FNXC:ChatComposerTests 2026-09-06-01:54:
    L’autocomplétion garde volontairement la priorité sur l’accélérateur : un menu ouvert consomme Ctrl+Enter au lieu d’envoyer le brouillon.
    */
    it("lets a non-empty autocomplete menu consume Ctrl+Enter", async () => {
      installCoarsePointer();
      const { input, sendSpy } = await openSnippetMenu(composer);
      const event = dispatchEnter(input, { ctrlKey: true });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(input).toHaveValue(snippet.prompt));
      expect(sendSpy).not.toHaveBeenCalled();
    });

    it("keeps the send button active while a non-empty autocomplete menu is open", async () => {
      installCoarsePointer();
      const { sendButton } = await openSnippetMenu(composer);
      expect(sendButton).toBeInTheDocument();
      expect(sendButton).toBeEnabled();
    });

    it("restores plain and accelerated rules after Escape closes autocomplete", async () => {
      installCoarsePointer();
      const { input, sendSpy } = await openSnippetMenu(composer);
      fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
      await waitFor(() => expect(screen.queryByRole("option", { name: /\/test/i })).not.toBeInTheDocument());

      const plainEvent = dispatchEnter(input);
      expect(plainEvent.defaultPrevented).toBe(false);
      expect(sendSpy).not.toHaveBeenCalled();

      const acceleratedEvent = dispatchEnter(input, { ctrlKey: true });
      expect(acceleratedEvent.defaultPrevented).toBe(true);
      await waitFor(() => expect(sendSpy).toHaveBeenCalled());
    });

    /*
    FNXC:ChatComposerTests 2026-09-06-01:54:
    Le fait vérifié n° 6 et le sous-cas B conservent l’asymétrie existante : Chat consomme Shift+Enter dans ses menus, tandis que les Chats de tâche et du planificateur la laissent produire une nouvelle ligne.
    */
    it("preserves the existing Shift+Enter versus autocomplete ordering", async () => {
      installCoarsePointer();
      const { input, sendSpy } = await openSnippetMenu(composer);
      const event = dispatchEnter(input, { shiftKey: true });
      expect(sendSpy).not.toHaveBeenCalled();
      if (composer === "ChatView") {
        expect(event.defaultPrevented).toBe(true);
        await waitFor(() => expect(input).toHaveValue(snippet.prompt));
      } else {
        expect(event.defaultPrevented).toBe(false);
        expect(input).toHaveValue(composer === "TaskPlannerChatTab" ? "/tes" : "/te");
      }
    });

    it("uses pointer capability rather than a narrow desktop viewport", async () => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
      installFinePointer();
      const { input, sendSpy } = await renderComposer(composer, "auto", { draft: "narrow desktop" });
      expect(dispatchEnter(input).defaultPrevented).toBe(true);
      await waitFor(() => expect(sendSpy).toHaveBeenCalled());
    });
  });
}

describe("ChatView autocomplete edge cases", () => {
  const alphaAgent = {
    id: "agent-alpha",
    name: "Alpha",
    role: "executor",
    roles: ["executor"],
    state: "idle",
  } as Agent;

  it.each(["files/tasks", "agents", "skills"] as const)(
    "keeps Shift+Enter consumed by the %s menu",
    async (menu) => {
      installCoarsePointer();
      apiMocks.fetchTasks.mockResolvedValue([
        { id: "FN-5218", title: "Hash entries in chat", column: "todo" },
      ]);
      const rendered = await renderComposer("ChatView", "auto", {
        draft: menu === "files/tasks" ? "#FN" : menu === "agents" ? "@Al" : "/te",
        snippets: menu === "skills",
        agents: [alphaAgent],
      });
      if (menu === "files/tasks") await screen.findByTestId("task-mention-item-0");
      if (menu === "agents") await screen.findByText("Alpha");
      if (menu === "skills") await screen.findByRole("option", { name: /\/test/i });

      const event = dispatchEnter(rendered.input, { shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(rendered.sendSpy).not.toHaveBeenCalled();
      expect(rendered.input.value).not.toContain("\n");
    },
  );

  /*
  FNXC:ChatComposerTests 2026-09-06-01:54:
  Une popup d’agents visible mais vide absorbe déjà Entrée, Ctrl+Enter et Shift+Enter. Ce test conserve ce sous-cas A et prouve qu’Échap ainsi que le bouton d’envoi restent des sorties disponibles.
  */
  it("keeps the visible empty agent popup absorbing Enter variants without hiding Send", async () => {
    installCoarsePointer();
    const { input, sendButton, sendSpy } = await renderComposer("ChatView", "auto", {
      draft: "@zz",
      agents: [alphaAgent],
    });
    await screen.findByText("No agents found");
    const initialDraft = input.value;

    for (const modifiers of [{}, { ctrlKey: true }, { shiftKey: true }]) {
      const event = dispatchEnter(input, modifiers);
      expect(event.defaultPrevented).toBe(true);
      expect(input).toHaveValue(initialDraft);
    }
    expect(sendSpy).not.toHaveBeenCalled();
    expect(sendButton).toBeEnabled();

    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByText("No agents found")).not.toBeInTheDocument());
  });
});

describe("IME precedence", () => {
  it.each([
    ["isComposing with Ctrl", { isComposing: true, ctrlKey: true }],
    ["keyCode 229 with Cmd", { keyCode: 229, metaKey: true }],
  ])("keeps TaskChatTab %s from sending", async (_label, modifiers) => {
    installFinePointer();
    const { input, sendSpy } = await renderComposer("TaskChatTab", "always", { draft: "候補" });
    dispatchEnter(input, modifiers);
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it.each(["ChatView", "TaskPlannerChatTab"] as const)(
    "does not invent an IME guard in %s",
    async (composer) => {
      installFinePointer();
      const { input, sendSpy } = await renderComposer(composer, "always", { draft: "候補" });
      const event = dispatchEnter(input, { isComposing: true, ctrlKey: true });
      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(sendSpy).toHaveBeenCalled());
    },
  );
});

describe("out-of-scope Quick Add control", () => {
  it("keeps QuickEntryBox Enter submission independent from the coarse chat preference", async () => {
    installCoarsePointer();
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatSubmitOnEnterProvider value="auto">
        <QuickAddSubmitOnEnterProvider enabled>
          <QuickEntryBox addToast={vi.fn()} onCreate={onCreate} tasks={[]} />
        </QuickAddSubmitOnEnterProvider>
      </ChatSubmitOnEnterProvider>,
    );
    const input = screen.getByPlaceholderText("Add a task...");
    fireEvent.change(input, { target: { value: "Independent quick task" } });
    expect(dispatchEnter(input).defaultPrevented).toBe(true);
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
  });
});
