import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentLogEntry, Task } from "@fusion/core";
import { TaskChatTab } from "../TaskChatTab";
import { isCliSessionLive, type CliSessionSummaryRecord } from "../TaskDetailModal";
import { useAgentLogs } from "../../hooks/useAgentLogs";
import { addSteeringComment } from "../../api";

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(),
}));

vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
}));

const mockedUseAgentLogs = vi.mocked(useAgentLogs);
const mockedAddSteeringComment = vi.mocked(addSteeringComment);
const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
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

function makeCliSession(agentState: CliSessionSummaryRecord["agentState"]): CliSessionSummaryRecord {
  return {
    id: "session-1",
    taskId: "FN-001",
    projectId: "project-1",
    adapterId: "claude",
    agentState,
    terminationReason: null,
  };
}

function makeEntry(overrides: Partial<AgentLogEntry>): AgentLogEntry {
  return {
    timestamp: "2026-06-12T00:00:00.000Z",
    taskId: "FN-001",
    type: "text",
    text: "message",
    ...overrides,
  } as AgentLogEntry;
}

function mockLogs(entries: AgentLogEntry[] = [], loading = false) {
  mockedUseAgentLogs.mockReturnValue({
    entries,
    loading,
    clear: vi.fn(),
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    total: entries.length,
    loadingMore: false,
  });
}

function restoreMetricDescriptor(name: "scrollTop" | "scrollHeight" | "clientHeight", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
    return;
  }
  delete (HTMLElement.prototype as Record<string, unknown>)[name];
}

function mockTranscriptMetrics({
  scrollHeight = 1200,
  clientHeight = 240,
  initialScrollTop = 0,
}: {
  scrollHeight?: number;
  clientHeight?: number;
  initialScrollTop?: number;
} = {}) {
  let scrollTopValue = initialScrollTop;
  let scrollHeightValue = scrollHeight;
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return this instanceof HTMLElement && this.classList.contains("task-chat-transcript") ? scrollHeightValue : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return this instanceof HTMLElement && this.classList.contains("task-chat-transcript") ? clientHeight : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return this instanceof HTMLElement && this.classList.contains("task-chat-transcript") ? scrollTopValue : 0;
    },
    set(value) {
      if (this instanceof HTMLElement && this.classList.contains("task-chat-transcript")) {
        scrollTopValue = Number(value);
      }
    },
  });
  return {
    get scrollTop() {
      return scrollTopValue;
    },
    set scrollTop(value: number) {
      scrollTopValue = value;
    },
    get scrollHeight() {
      return scrollHeightValue;
    },
    set scrollHeight(value: number) {
      scrollHeightValue = value;
    },
  };
}

function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

function mockRequestAnimationFrame() {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  const cancelAnimationFrame = vi.fn((id: number) => {
    callbacks.delete(id);
  });

  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: requestAnimationFrame,
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: cancelAnimationFrame,
  });

  return {
    requestAnimationFrame,
    cancelAnimationFrame,
    flushNext() {
      const next = callbacks.entries().next();
      if (next.done) return false;
      const [id, callback] = next.value;
      callbacks.delete(id);
      callback(performance.now());
      return true;
    },
    get pendingCount() {
      return callbacks.size;
    },
  };
}

describe("TaskChatTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogs();
  });

  afterEach(() => {
    restoreMetricDescriptor("scrollTop", originalScrollTopDescriptor);
    restoreMetricDescriptor("scrollHeight", originalScrollHeightDescriptor);
    restoreMetricDescriptor("clientHeight", originalClientHeightDescriptor);
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
  });

  it("subscribes to live agent logs only when active", () => {
    render(<TaskChatTab task={makeTask()} active={false} projectId="project-1" addToast={vi.fn()} />);
    expect(mockedUseAgentLogs).toHaveBeenCalledWith("FN-001", false, "project-1");
  });

  it("renders empty state when no agent output exists", () => {
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByText(/No agent output yet/)).toBeTruthy();
  });

  it("labels every agent role and the legacy undefined-agent fallback", () => {
    mockLogs([
      makeEntry({ agent: "triage", text: "planning output" }),
      makeEntry({ agent: "executor", text: "executor output" }),
      makeEntry({ agent: "reviewer", text: "reviewer output" }),
      makeEntry({ agent: "merger", text: "merger output" }),
      makeEntry({ text: "legacy output" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByText("Planner")).toBeTruthy();
    expect(screen.getByText("Executor")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Merger")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("legacy output")).toBeTruthy();
  });

  it("groups consecutive entries by agent role", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "first" }),
      makeEntry({ agent: "executor", text: "second" }),
      makeEntry({ agent: "reviewer", text: "third" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByText("2 entries")).toBeTruthy();
    expect(screen.getByLabelText("Executor messages")).toBeTruthy();
    expect(screen.getByLabelText("Reviewer messages")).toBeTruthy();
  });

  it("counts a tool call plus result as one collapsed invocation and shows the tool name", async () => {
    const user = userEvent.setup();
    mockLogs([
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: "pnpm test" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "bash", detail: "ok" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const toolGroup = screen.getByTestId("task-chat-tool-group");
    const summary = toolGroup.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(toolGroup).not.toHaveAttribute("open");
    expect(within(summary as HTMLElement).getByText("1 tool call")).toBeVisible();
    expect(within(summary as HTMLElement).getByText("bash")).toBeVisible();
    expect(screen.queryByText("2 tool calls")).not.toBeInTheDocument();
    expect(screen.getByText("pnpm test")).not.toBeVisible();
    expect(screen.getByText("ok")).not.toBeVisible();

    await user.click(within(summary as HTMLElement).getByText("1 tool call"));

    expect(toolGroup).toHaveAttribute("open");
    expect(screen.getByText("Tool call → result")).toBeVisible();
    expect(screen.getByText("Arguments")).toBeVisible();
    expect(screen.getByText("Result")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
    expect(screen.getByText("ok")).toBeVisible();
  });

  it("summarizes multiple invocations with deduped names and overflow", () => {
    mockLogs([
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: "run tests" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "bash", detail: "ok" }),
      makeEntry({ agent: "executor", type: "tool", text: "read", detail: "open file" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "read", detail: "contents" }),
      makeEntry({ agent: "executor", type: "tool", text: "edit", detail: "patch" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "edit", detail: "done" }),
      makeEntry({ agent: "executor", type: "tool", text: "grep", detail: "search" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "grep", detail: "matches" }),
      makeEntry({ agent: "executor", type: "tool", text: "find", detail: "glob" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "find", detail: "paths" }),
      makeEntry({ agent: "executor", type: "tool", text: "write", detail: "file" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "write", detail: "saved" }),
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: "rerun" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "bash", detail: "ok again" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const summary = screen.getByTestId("task-chat-tool-group").querySelector("summary");
    expect(summary).toBeTruthy();
    expect(within(summary as HTMLElement).getByText("7 tool calls")).toBeVisible();
    const names = within(summary as HTMLElement).getByLabelText("Tool names");
    expect(names).toHaveTextContent("bash, read, edit, grep, find, +1 more");
    expect(within(summary as HTMLElement).getByText(", +1 more")).toBeVisible();
  });

  it("surfaces tool errors in the summary and paired expanded body", async () => {
    const user = userEvent.setup();
    mockLogs([
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: "pnpm test" }),
      makeEntry({ agent: "executor", type: "tool_error", text: "bash", detail: "stderr" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const toolGroup = screen.getByTestId("task-chat-tool-group");
    const summary = toolGroup.querySelector("summary");
    expect(summary).toBeTruthy();
    const errorCount = within(summary as HTMLElement).getByText("1 error");
    expect(errorCount).toBeVisible();
    expect(errorCount).toHaveClass("task-chat-tool-group-error-count");
    expect(screen.getByText("stderr")).not.toBeVisible();

    await user.click(within(summary as HTMLElement).getByText("1 tool call"));

    expect(screen.getByText("Tool call → error")).toBeVisible();
    expect(screen.getByText("Error")).toBeVisible();
    expect(screen.getByText("stderr")).toBeVisible();
  });

  it("renders a single tool entry as one collapsed group and tolerates missing detail", () => {
    mockLogs([
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: undefined }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const toolGroup = screen.getByTestId("task-chat-tool-group");
    const summary = toolGroup.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(toolGroup).not.toHaveAttribute("open");
    expect(within(summary as HTMLElement).getByText("1 tool call")).toBeVisible();
    expect(within(summary as HTMLElement).getByText("bash")).toBeVisible();
    expect(screen.queryByText("Arguments")).not.toBeInTheDocument();
  });

  it("falls back to result entries when a tool completion has no preceding call", () => {
    mockLogs([
      makeEntry({ agent: "executor", type: "tool_result", text: "bash", detail: "ok" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const toolGroup = screen.getByTestId("task-chat-tool-group");
    const summary = toolGroup.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(toolGroup).not.toHaveAttribute("open");
    expect(within(summary as HTMLElement).getByText("1 tool call")).toBeVisible();
    expect(within(summary as HTMLElement).getByText("bash")).toBeVisible();
    expect(screen.queryByText("0 tool calls")).not.toBeInTheDocument();
  });

  it("renders thinking in an expanded-by-default collapsible block", async () => {
    const user = userEvent.setup();
    mockLogs([
      makeEntry({ agent: "triage", type: "thinking", text: "I am considering options" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const thinking = screen.getByTestId("task-chat-thinking");
    expect(thinking).toHaveAttribute("open");
    expect(screen.getByText("Thinking")).toBeVisible();
    expect(screen.getByText("I am considering options")).toBeVisible();

    await user.click(within(thinking).getByText("Thinking"));

    expect(thinking).not.toHaveAttribute("open");
    expect(screen.getByText("I am considering options")).not.toBeVisible();
  });

  it("creates distinct tool segments when text or thinking entries are interleaved", () => {
    mockLogs([
      makeEntry({ agent: "executor", type: "tool", text: "first tool", detail: "first detail" }),
      makeEntry({ agent: "executor", text: "plain response" }),
      makeEntry({ agent: "executor", type: "thinking", text: "thinking between tools" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "second tool", detail: "second detail" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const toolGroups = screen.getAllByTestId("task-chat-tool-group");
    expect(toolGroups).toHaveLength(2);
    expect(toolGroups[0]).not.toHaveAttribute("open");
    expect(toolGroups[1]).not.toHaveAttribute("open");
    expect(screen.getAllByText("1 tool call")).toHaveLength(2);
    expect(within(toolGroups[0]).getByLabelText("Tool names")).toHaveTextContent("first tool");
    expect(within(toolGroups[1]).getByLabelText("Tool names")).toHaveTextContent("second tool");
    expect(screen.getByText("plain response")).toBeVisible();
    expect(screen.getByText("thinking between tools")).toBeVisible();
  });

  it("appends newly streamed entries from the hook without auto-opening tool groups", () => {
    const firstEntries = [makeEntry({ agent: "executor", text: "first live chunk" })];
    const secondEntries = [
      ...firstEntries,
      makeEntry({ agent: "executor", type: "tool", text: "streamed tool", detail: "streamed detail", timestamp: "2026-06-12T00:00:01.000Z" }),
      makeEntry({ agent: "executor", text: "second live chunk", timestamp: "2026-06-12T00:00:02.000Z" }),
    ];
    mockedUseAgentLogs.mockReturnValueOnce({ entries: firstEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 1, loadingMore: false });
    mockedUseAgentLogs.mockReturnValueOnce({ entries: secondEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 3, loadingMore: false });

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByText("first live chunk")).toBeVisible();

    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const toolGroup = screen.getByTestId("task-chat-tool-group");
    expect(toolGroup).not.toHaveAttribute("open");
    expect(screen.getByText("1 tool call")).toBeVisible();
    expect(screen.getByText("streamed detail")).not.toBeVisible();
    expect(screen.getByText("second live chunk")).toBeVisible();
  });

  it.each([
    ["desktop", false],
    ["mobile", true],
  ])("snaps populated transcripts to the bottom on initial %s render", (_label, matchesMobile) => {
    mockMatchMedia(matchesMobile);
    const metrics = mockTranscriptMetrics({ scrollHeight: 1400, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([
      makeEntry({ agent: "executor", text: "older output" }),
      makeEntry({ agent: "executor", text: "latest output", timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByTestId("task-chat-transcript")).toBeTruthy();
    expect(metrics.scrollTop).toBe(metrics.scrollHeight);
  });

  it("snaps to the bottom when the tab reactivates with unchanged cached entries", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    const cachedEntries = [
      makeEntry({ agent: "executor", text: "cached first" }),
      makeEntry({ agent: "executor", text: "cached latest", timestamp: "2026-06-12T00:00:01.000Z" }),
    ];
    mockLogs(cachedEntries);

    const { rerender } = render(<TaskChatTab task={makeTask()} active={false} addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(0);

    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(metrics.scrollHeight);
  });

  it("snaps when entries first become populated after an active empty render", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1100, clientHeight: 240, initialScrollTop: 0 });
    const loadedEntries = [makeEntry({ agent: "executor", text: "loaded output" })];
    mockedUseAgentLogs
      .mockReturnValueOnce({ entries: [], loading: true, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 0, loadingMore: false })
      .mockReturnValueOnce({ entries: loadedEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 1, loadingMore: false });

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(0);

    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(metrics.scrollHeight);
  });

  it("FN-6337: re-pins populated transcripts to the bottom after async height growth", () => {
    const raf = mockRequestAnimationFrame();
    const metrics = mockTranscriptMetrics({ scrollHeight: 600, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([
      makeEntry({ agent: "executor", text: "older output" }),
      makeEntry({ agent: "executor", type: "thinking", text: "expanded thinking", timestamp: "2026-06-12T00:00:01.000Z" }),
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: "pnpm test", timestamp: "2026-06-12T00:00:02.000Z" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(600);
    metrics.scrollHeight = 900;
    expect(raf.flushNext()).toBe(true);
    expect(metrics.scrollTop).toBe(900);

    metrics.scrollHeight = 1200;
    expect(raf.flushNext()).toBe(true);
    expect(metrics.scrollTop).toBe(1200);

    expect(raf.flushNext()).toBe(true);
    expect(metrics.scrollTop).toBe(1200);
    expect(raf.flushNext()).toBe(true);
    expect(metrics.scrollTop).toBe(metrics.scrollHeight);
    expect(raf.pendingCount).toBe(0);
  });

  it("FN-6337: bounds and cleans up the settle loop", () => {
    const raf = mockRequestAnimationFrame();
    const metrics = mockTranscriptMetrics({ scrollHeight: 500, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([makeEntry({ agent: "executor", text: "output" })]);

    const { unmount } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    for (let frame = 0; frame < 5; frame += 1) {
      metrics.scrollHeight += 100;
      expect(raf.flushNext()).toBe(true);
    }
    expect(metrics.scrollTop).toBe(1000);
    expect(raf.pendingCount).toBe(0);

    metrics.scrollHeight = 1300;
    mockLogs([makeEntry({ agent: "executor", text: "output after remount" })]);
    const mountedAgain = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(raf.pendingCount).toBe(1);
    mountedAgain.unmount();
    expect(raf.cancelAnimationFrame).toHaveBeenCalled();
    expect(raf.pendingCount).toBe(0);

    metrics.scrollHeight = 1600;
    expect(raf.flushNext()).toBe(false);
    expect(metrics.scrollTop).toBe(1300);
    unmount();
  });

  it("does not mutate scroll position for an empty transcript", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 900, clientHeight: 240, initialScrollTop: 25 });
    mockLogs([]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByText(/No agent output yet/)).toBeTruthy();
    expect(metrics.scrollTop).toBe(25);
  });

  it("continues following new entries when the user is near the bottom", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1000, clientHeight: 240, initialScrollTop: 0 });
    const firstEntries = [makeEntry({ agent: "executor", text: "first output" })];
    const secondEntries = [...firstEntries, makeEntry({ agent: "executor", text: "second output", timestamp: "2026-06-12T00:00:01.000Z" })];
    mockedUseAgentLogs
      .mockReturnValueOnce({ entries: firstEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 1, loadingMore: false })
      .mockReturnValueOnce({ entries: secondEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 2, loadingMore: false });

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(1000);

    metrics.scrollTop = 720;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    metrics.scrollHeight = 1400;
    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(1400);
  });

  it("does not yank a scrolled-up user when a new entry arrives", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1000, clientHeight: 240, initialScrollTop: 0 });
    const firstEntries = [makeEntry({ agent: "executor", text: "first output" })];
    const secondEntries = [...firstEntries, makeEntry({ agent: "executor", text: "second output", timestamp: "2026-06-12T00:00:01.000Z" })];
    mockedUseAgentLogs
      .mockReturnValueOnce({ entries: firstEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 1, loadingMore: false })
      .mockReturnValueOnce({ entries: secondEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 2, loadingMore: false });

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(1000);

    metrics.scrollTop = 120;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    metrics.scrollHeight = 1400;
    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(120);
  });

  it("posts composer text through addSteeringComment and clears on success", async () => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(makeTask());
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    await user.type(input, "Please inspect the failing test");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Please inspect the failing test", "project-1");
    });
    expect(input).toHaveValue("");
  });

  it.each([
    ["queued", "Please continue after dispatch"],
    [undefined, "Please continue with a cleared status"],
  ])("enables in-progress steering for realistic %s status and posts guidance", async (status, message) => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(makeTask({ status }));
    render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1", status })} projectId="project-1" active addToast={vi.fn()} />);

    expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    await user.type(input, message);
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", message, "project-1");
    });
  });

  it.each(["starting", "ready", "busy", "waitingOnInput"] as const)(
    "enables steering for a live %s CLI session when static task fields are not steerable",
    async (agentState) => {
      const user = userEvent.setup();
      mockedAddSteeringComment.mockResolvedValue(makeTask({ column: "in-review", status: "queued" }));
      render(
        <TaskChatTab
          task={makeTask({ column: "in-review", status: "queued", assignedAgentId: undefined, checkedOutBy: undefined })}
          projectId="project-1"
          active
          addToast={vi.fn()}
          sessionLive={isCliSessionLive(makeCliSession(agentState))}
        />,
      );

      expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
      const input = screen.getByLabelText("Message active agent session");
      expect(input).not.toBeDisabled();
      await user.type(input, `Please continue ${agentState}`);
      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).not.toBeDisabled();
      await user.click(sendButton);

      await waitFor(() => {
        expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", `Please continue ${agentState}`, "project-1");
      });
    },
  );

  it("enables steering for a live CLI session in a terminal column that static task fields reject", () => {
    render(
      <TaskChatTab
        task={makeTask({ column: "todo", status: undefined, assignedAgentId: undefined, checkedOutBy: undefined })}
        active
        addToast={vi.fn()}
        sessionLive={true}
      />,
    );

    expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Message active agent session")).not.toBeDisabled();
  });

  it.each(["busy", "ready", "starting", "waitingOnInput"] as const)("treats %s CLI sessions as live", (agentState) => {
    expect(isCliSessionLive(makeCliSession(agentState))).toBe(true);
  });

  it.each(["done", "dead", "needsAttention"] as const)("treats %s CLI sessions as not live", (agentState) => {
    expect(isCliSessionLive(makeCliSession(agentState))).toBe(false);
  });

  it("treats a missing CLI session as not live", () => {
    expect(isCliSessionLive(null)).toBe(false);
  });

  it.each([undefined, null, "queued", "planning", "merging", "merging-fix"])(
    "enables in-progress steering for assigned agents with %s status",
    (status) => {
      render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1", status })} active addToast={vi.fn()} />);

      expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Message active agent session")).not.toBeDisabled();
    },
  );

  it("enables in-progress steering with checkedOutBy when no assignedAgentId exists", async () => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(makeTask({ status: "queued" }));
    render(
      <TaskChatTab
        task={makeTask({ column: "in-progress", status: "queued", assignedAgentId: undefined, checkedOutBy: "agent-1" })}
        projectId="project-1"
        active
        addToast={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    await user.type(input, "Please keep going");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Please keep going", "project-1");
    });
  });

  it.each(["reviewing", "merging", "merging-fix", "fixing"])(
    "enables in-review steering while %s with an assigned agent",
    async (status) => {
      const user = userEvent.setup();
      mockedAddSteeringComment.mockResolvedValue(makeTask({ column: "in-review", status }));
      render(<TaskChatTab task={makeTask({ column: "in-review", status })} projectId="project-1" active addToast={vi.fn()} />);

      const input = screen.getByLabelText("Message active agent session");
      expect(input).not.toBeDisabled();
      await user.type(input, `Please continue ${status}`);
      const sendButton = screen.getByRole("button", { name: "Send" });
      expect(sendButton).not.toBeDisabled();
      await user.click(sendButton);

      await waitFor(() => {
        expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", `Please continue ${status}`, "project-1");
      });
    },
  );

  it("enables in-review steering with checkedOutBy when no assignedAgentId exists", async () => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(makeTask({ column: "in-review", status: "reviewing" }));
    render(
      <TaskChatTab
        task={makeTask({ column: "in-review", status: "reviewing", assignedAgentId: undefined, checkedOutBy: "agent-1" })}
        projectId="project-1"
        active
        addToast={vi.fn()}
      />,
    );

    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    await user.type(input, "Please review this follow-up");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Please review this follow-up", "project-1");
    });
  });

  it.each([
    ["todo task", makeTask({ column: "todo", assignedAgentId: "agent-1", status: undefined })],
    ["triage task", makeTask({ column: "triage", assignedAgentId: "agent-1", status: undefined })],
    ["done task", makeTask({ column: "done", assignedAgentId: "agent-1", status: undefined })],
    ["archived task", makeTask({ column: "archived", assignedAgentId: "agent-1", status: undefined })],
    ["in-progress task without an assigned or checked-out agent", makeTask({ column: "in-progress", status: "queued", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["paused in-progress task", makeTask({ column: "in-progress", status: "queued", paused: true })],
    ["user-paused in-progress task", makeTask({ column: "in-progress", status: "queued", userPaused: true })],
    ["in-review task without an assigned or checked-out agent", makeTask({ column: "in-review", status: "reviewing", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["paused in-review task", makeTask({ column: "in-review", status: "reviewing", paused: true })],
    ["user-paused in-review task", makeTask({ column: "in-review", status: "reviewing", userPaused: true })],
  ])("disables the composer and shows a hint for %s", (_label, task) => {
    render(<TaskChatTab task={task} active addToast={vi.fn()} />);

    expect(screen.getByText(/No active steerable agent session/)).toBeTruthy();
    expect(screen.getByText(/active assigned task agent or live, non-paused CLI session is required/i)).toBeTruthy();
    expect(screen.getByLabelText("Message active agent session")).toBeDisabled();
    expect(screen.getByPlaceholderText("Active steerable agent session required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it.each([
    ["paused in-progress task with a live session", makeTask({ column: "in-progress", status: "queued", paused: true })],
    ["user-paused in-progress task with a live session", makeTask({ column: "in-progress", status: "queued", userPaused: true })],
    ["paused in-review task with a live session", makeTask({ column: "in-review", status: "reviewing", paused: true })],
    ["user-paused in-review task with a live session", makeTask({ column: "in-review", status: "reviewing", userPaused: true })],
  ])("disables the composer for %s", (_label, task) => {
    render(<TaskChatTab task={task} active addToast={vi.fn()} sessionLive={true} />);

    expect(screen.getByText(/No active steerable agent session/)).toBeTruthy();
    expect(screen.getByLabelText("Message active agent session")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it.each(["paused", "awaiting-user-input", "awaiting-cli-approval", "awaiting-user-review", "failed", "needs-replan"])(
    "disables in-progress steering for non-steerable %s status",
    (status) => {
      render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1", status })} active addToast={vi.fn()} />);

      expect(screen.getByText(/No active steerable agent session/)).toBeTruthy();
      expect(screen.getByLabelText("Message active agent session")).toBeDisabled();
      expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    },
  );

  it("surfaces send failures through addToast", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    mockedAddSteeringComment.mockRejectedValue(new Error("network down"));
    render(<TaskChatTab task={makeTask()} active addToast={addToast} />);

    await user.type(screen.getByLabelText("Message active agent session"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(addToast).toHaveBeenCalledWith("Unable to send message: network down", "error");
    });
  });

  it("keeps mobile breakpoint scaffolding for the transcript, composer, and collapsible groups", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".task-chat-transcript");
    expect(css).toContain(".task-chat-composer-row");
    expect(css).toContain(".task-chat-tool-group-summary");
    expect(css).toContain(".task-chat-tool-group-names");
    expect(css).toContain(".task-chat-tool-group-error-count");
    expect(css).toContain(".task-chat-thinking-summary");
  });
});
