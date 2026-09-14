import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { AgentLogEntry, Task } from "@fusion/core";
import { TaskChatTab } from "../TaskChatTab";
import { useAgentLogs } from "../../hooks/useAgentLogs";

vi.mock("../../hooks/useAgentLogs", () => ({ useAgentLogs: vi.fn() }));
vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
  refineTask: vi.fn(),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  updateGlobalSettings: vi.fn(),
}));

const mockedUseAgentLogs = vi.mocked(useAgentLogs);
const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");

/*
FNXC:StickyBottomScroll 2026-09-14-20:19:
FN-398 — reproduction exacte du symptôme dans une transcription de tâche : le lecteur est « magnétisé » au bas, un
geste de molette de 30 px (sous le seuil de 48 px) devait le libérer. Auparavant `isTranscriptAtBottomRef` restait
vrai, et le `followTail` des observateurs réécrivait `scrollTop` en bas — y compris quand la mutation DOM arrivait
AVANT la livraison de l'événement `scroll`, ce que le second cas vérifie explicitement.
*/

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-398",
    title: "Task",
    description: "Task description",
    column: "in-progress",
    dependencies: [],
    steps: [],
    currentStep: 0,
    assignedAgentId: "agent-1",
    status: undefined,
    ...overrides,
  } as Task;
}

function makeEntry(overrides: Partial<AgentLogEntry>): AgentLogEntry {
  return {
    timestamp: "2026-09-14T20:00:00.000Z",
    taskId: "FN-398",
    agent: "executor",
    type: "text",
    text: "output",
    ...overrides,
  } as AgentLogEntry;
}

function mockLogs(entries: AgentLogEntry[]) {
  mockedUseAgentLogs.mockReturnValue({
    entries,
    loading: false,
    clear: vi.fn(),
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    total: entries.length,
    loadingMore: false,
  } as unknown as ReturnType<typeof useAgentLogs>);
}

function installTranscriptMetrics({ scrollHeight = 1200, clientHeight = 240, initialScrollTop = 0 } = {}) {
  let scrollTopValue = initialScrollTop;
  let scrollHeightValue = scrollHeight;
  const isTranscript = (node: unknown) => node instanceof HTMLElement && node.classList.contains("task-chat-transcript");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) { return isTranscript(this) ? scrollHeightValue : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) { return isTranscript(this) ? clientHeight : 0; },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) { return isTranscript(this) ? scrollTopValue : 0; },
    set(this: HTMLElement, value: number) { if (isTranscript(this)) scrollTopValue = Number(value); },
  });
  return {
    get scrollTop() { return scrollTopValue; },
    set scrollTop(value: number) { scrollTopValue = value; },
    get scrollHeight() { return scrollHeightValue; },
    set scrollHeight(value: number) { scrollHeightValue = value; },
  };
}

function wheelUp(element: HTMLElement, deltaY = -30) {
  const event = new Event("wheel", { bubbles: true });
  Object.defineProperty(event, "deltaY", { value: deltaY });
  Object.defineProperty(event, "target", { value: element });
  act(() => { element.dispatchEvent(event); });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
  if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
});

describe("FN-398 TaskChatTab — a manual gesture always wins over tail following", () => {
  it("stops following after a 30px wheel-up, so streamed growth no longer moves the viewport", async () => {
    const metrics = installTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    const streaming = makeEntry({ text: "streaming output" });
    mockLogs([streaming]);

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(1200);

    const transcript = screen.getByTestId("task-chat-transcript");
    wheelUp(transcript);
    metrics.scrollTop = 1170;
    act(() => { fireEvent.scroll(transcript); });

    metrics.scrollHeight = 1600;
    mockLogs([{ ...streaming, text: "streaming output grows in place" }]);
    await act(async () => { rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />); });

    expect(metrics.scrollTop).toBe(1170);
  });

  it("honours the gesture even when the DOM mutation lands before the scroll event is delivered", async () => {
    const metrics = installTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    const streaming = makeEntry({ text: "streaming output" });
    mockLogs([streaming]);

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    const transcript = screen.getByTestId("task-chat-transcript");
    expect(metrics.scrollTop).toBe(1200);

    // The gesture is seen first; the scroll event has not been delivered yet.
    wheelUp(transcript);
    metrics.scrollTop = 1170;

    metrics.scrollHeight = 1600;
    mockLogs([{ ...streaming, text: "streaming output grows before the scroll event" }]);
    await act(async () => { rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />); });

    expect(metrics.scrollTop).toBe(1170);
  });

  it("rearms following through the jump-to-latest button", async () => {
    const metrics = installTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    const streaming = makeEntry({ text: "streaming output" });
    mockLogs([streaming]);

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    const transcript = screen.getByTestId("task-chat-transcript");

    wheelUp(transcript);
    metrics.scrollTop = 1170;
    act(() => { fireEvent.scroll(transcript); });

    await act(async () => { fireEvent.click(screen.getByTestId("task-chat-jump-to-bottom")); });
    expect(metrics.scrollTop).toBe(1200);

    metrics.scrollHeight = 1600;
    mockLogs([{ ...streaming, text: "streaming output after rearm" }]);
    await act(async () => { rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />); });

    expect(metrics.scrollTop).toBe(1600);
  });

  it("does not rearm following when older history is prepended", async () => {
    const metrics = installTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    const newest = makeEntry({ text: "newest output", timestamp: "2026-09-14T20:00:05.000Z" });
    mockLogs([newest]);

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    const transcript = screen.getByTestId("task-chat-transcript");

    wheelUp(transcript);
    metrics.scrollTop = 1170;
    act(() => { fireEvent.scroll(transcript); });
    const detachedAt = metrics.scrollTop;

    const older = makeEntry({ text: "older output", timestamp: "2026-09-14T19:00:00.000Z" });
    metrics.scrollHeight = 1800;
    mockLogs([older, newest]);
    await act(async () => { rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />); });

    expect(metrics.scrollTop).toBeLessThan(1800 - 240);
    expect(metrics.scrollTop).toBeGreaterThanOrEqual(detachedAt);
  });
});
