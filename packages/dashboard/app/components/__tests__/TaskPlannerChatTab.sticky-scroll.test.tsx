import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";

/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 — Planner Chat décidait du suivi uniquement par le seuil de 48 px, et son fencing d'écriture reposait sur un
drapeau synchrone qui ne couvrait pas un `scroll` livré plus tard. Un petit geste laissait donc le suivi engagé et la
croissance de streaming réécrivait `scrollTop` en bas. Ces cas rejouent le geste puis la croissance.
*/

const mocks = vi.hoisted(() => ({
  fetchTaskPlannerChatSession: vi.fn(),
  fetchChatSession: vi.fn(),
  fetchChatMessages: vi.fn(),
  attachChatStream: vi.fn(() => ({ close: vi.fn(), isConnected: () => true })),
  t: (_key: string, fallback: string) => fallback,
}));

vi.mock("../../hooks/useModelsCache", () => ({ useModelsCache: () => ({ models: [], favoriteProviders: [], favoriteModels: [] }) }));
vi.mock("../../hooks/useFavorites", () => ({
  useFavorites: () => ({ availableModels: [], favoriteProviders: [], favoriteModels: [], providerInstances: {}, toggleFavoriteProvider: vi.fn(), toggleFavoriteModel: vi.fn() }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchTaskPlannerChatSession: mocks.fetchTaskPlannerChatSession,
  fetchChatSession: mocks.fetchChatSession,
  fetchChatMessages: mocks.fetchChatMessages,
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchGlobalSettings: vi.fn().mockResolvedValue({ chatSnippets: [] }),
  fetchTaskDetail: vi.fn(),
  updateChatSession: vi.fn(),
  attachChatStream: mocks.attachChatStream,
  streamChatResponse: vi.fn(() => ({ close: vi.fn(), isConnected: () => true })),
  cancelChatResponse: vi.fn().mockResolvedValue({ success: true }),
  ensureTaskPlannerChatSession: vi.fn(),
  addSteeringComment: vi.fn(),
}));

const session = {
  id: "planner-session",
  agentId: "task-planner:FN-398",
  title: "Planner",
  status: "active",
  projectId: null,
  modelProvider: "anthropic",
  modelId: "model",
  thinkingLevel: null,
  createdAt: "2026-09-14T00:00:00.000Z",
  updatedAt: "2026-09-14T00:00:00.000Z",
  pinnedAt: null,
  cliSessionFile: null,
  cliExecutorAdapterId: null,
  inFlightGeneration: null,
};

const generatingSession = {
  ...session,
  isGenerating: true,
  inFlightGeneration: {
    status: "generating" as const,
    streamingText: "",
    streamingThinking: "",
    toolCalls: [],
    replayFromEventId: 1,
    updatedAt: session.updatedAt,
  },
};

const messages = Array.from({ length: 40 }, (_, index) => ({
  id: `planner-${String(index).padStart(4, "0")}`,
  sessionId: session.id,
  role: index % 2 ? "assistant" as const : "user" as const,
  content: `Message planner ${index}`,
  thinkingOutput: null,
  metadata: null,
  createdAt: "2026-09-14T12:00:00.000Z",
}));

class FakeIntersectionObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = "0px";
  thresholds = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  mocks.fetchTaskPlannerChatSession.mockResolvedValue({ session: generatingSession });
  mocks.fetchChatSession.mockResolvedValue({ session: generatingSession });
  mocks.fetchChatMessages.mockResolvedValue({ messages: [...messages].reverse() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderPlanner() {
  return render(<TaskPlannerChatTab
    task={{ id: "FN-398", description: "Task", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: session.createdAt, updatedAt: session.updatedAt } as never}
    active
    expanded={false}
    taskChatModel={{ provider: "anthropic", modelId: "model" }}
    addToast={vi.fn()}
  />);
}

interface PlannerHarness {
  transcript: HTMLElement;
  readonly scrollTop: number;
  setScrollTop(value: number): void;
  grow(byPx: number): void;
  readonly scrollHeight: number;
  stream: {
    onText(delta: string): void;
    onThinking(delta: string): void;
    onToolStart(data: { toolName: string; args?: Record<string, unknown> }): void;
  };
}

async function mountPlannerAtBottom(): Promise<PlannerHarness> {
  let streamHandlers: PlannerHarness["stream"] | undefined;
  mocks.attachChatStream.mockImplementation(((_sessionId: string, handlers: PlannerHarness["stream"]) => {
    streamHandlers = handlers;
    return { close: vi.fn(), isConnected: () => true };
  }) as never);

  renderPlanner();
  await waitFor(() => expect(mocks.fetchChatMessages).toHaveBeenCalled());
  await waitFor(() => expect(streamHandlers).toBeDefined());

  const transcript = document.querySelector<HTMLElement>(".task-planner-chat-transcript")!;
  let scrollHeight = 4_000;
  let scrollTop = 3_600;
  Object.defineProperties(transcript, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - 400)); } },
  });

  return {
    transcript,
    get scrollTop() { return scrollTop; },
    get scrollHeight() { return scrollHeight; },
    setScrollTop(value: number) { scrollTop = value; },
    grow(byPx: number) { scrollHeight += byPx; },
    stream: streamHandlers!,
  };
}

function wheelUp(element: HTMLElement, deltaY = -30) {
  const event = new Event("wheel", { bubbles: true });
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "target", { value: element });
  act(() => { element.dispatchEvent(event); });
}

describe("FN-398 TaskPlannerChatTab — a manual gesture always wins over tail following", () => {
  it("stops following after a 30px wheel-up, so streamed growth no longer moves the viewport", async () => {
    const planner = await mountPlannerAtBottom();

    wheelUp(planner.transcript);
    planner.setScrollTop(3_570);
    act(() => { fireEvent.scroll(planner.transcript); });

    planner.grow(200);
    await act(async () => { planner.stream.onText("Plan en cours"); });

    expect(planner.scrollTop).toBe(3_570);
  });

  it("honours the gesture when growth lands before the scroll event is delivered", async () => {
    const planner = await mountPlannerAtBottom();

    wheelUp(planner.transcript);
    planner.setScrollTop(3_570);

    planner.grow(200);
    await act(async () => { planner.stream.onThinking("Raisonnement Planner"); });

    expect(planner.scrollTop).toBe(3_570);
  });

  it("follows the tail again once the reader scrolls back down to the bottom", async () => {
    const planner = await mountPlannerAtBottom();

    wheelUp(planner.transcript);
    planner.setScrollTop(3_570);
    act(() => { fireEvent.scroll(planner.transcript); });

    planner.setScrollTop(planner.scrollHeight - 400);
    act(() => { fireEvent.scroll(planner.transcript); });

    planner.grow(200);
    await act(async () => { planner.stream.onText("Suite du plan"); });

    expect(planner.scrollTop).toBe(planner.scrollHeight - 400);
  });
});
