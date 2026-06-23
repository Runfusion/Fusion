import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentLogEntry, Task } from "@fusion/core";
import { TaskChatTab } from "../TaskChatTab";
import { isCliSessionLive, type CliSessionSummaryRecord } from "../TaskDetailModal";
import { useAgentLogs } from "../../hooks/useAgentLogs";
import { addSteeringComment, refineTask } from "../../api";

vi.mock("../../hooks/useAgentLogs", () => ({
  useAgentLogs: vi.fn(),
}));

vi.mock("../../api", () => ({
  addSteeringComment: vi.fn(),
  refineTask: vi.fn(),
}));

const mockedUseAgentLogs = vi.mocked(useAgentLogs);
const mockedAddSteeringComment = vi.mocked(addSteeringComment);
const mockedRefineTask = vi.mocked(refineTask);
const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");

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

function makeSteeringComment(overrides: Partial<NonNullable<Task["steeringComments"]>[number]> = {}): NonNullable<Task["steeringComments"]>[number] {
  return {
    id: "steer-1",
    text: "Persisted user guidance",
    createdAt: "2026-06-12T00:00:01.000Z",
    author: "user",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function getCssRuleBlock(css: string, selector: string): string {
  const selectorIndex = css.indexOf(selector);
  if (selectorIndex < 0) return "";
  const ruleStart = css.indexOf("{", selectorIndex);
  const ruleEnd = css.indexOf("}", ruleStart);
  return ruleStart >= 0 && ruleEnd >= 0 ? css.slice(ruleStart + 1, ruleEnd) : "";
}

function getCssAfter(css: string, marker: string): string {
  const markerIndex = css.indexOf(marker);
  return markerIndex >= 0 ? css.slice(markerIndex) : "";
}

function getCssDeclaration(rule: string, propertyName: string): string {
  const declarationMatch = new RegExp(`${propertyName}\\s*:\\s*([^;]+);`).exec(rule);
  return declarationMatch?.[1]?.trim() ?? "";
}

function getRootTokenPxValues(css: string): Record<string, number> {
  const rootRule = getCssRuleBlock(css, ":root");
  const tokenValues: Record<string, number> = {};
  for (const match of rootRule.matchAll(/(--(?:space|icon-size)-[\w-]+)\s*:\s*(\d+)px;/g)) {
    tokenValues[match[1]] = Number(match[2]);
  }
  return tokenValues;
}

function resolveCssPxToken(value: string, tokenValues: Record<string, number>): number {
  const tokenName = /^var\((--[\w-]+)\)$/.exec(value.trim())?.[1];
  if (!tokenName || tokenValues[tokenName] === undefined) {
    throw new Error(`Unable to resolve CSS token value: ${value}`);
  }
  return tokenValues[tokenName];
}

function resolveCssCalcSumPx(value: string, tokenValues: Record<string, number>): number {
  const calcBody = /^calc\((var\(--[\w-]+\)(?:\s*\+\s*var\(--[\w-]+\))+)\)$/.exec(value.trim())?.[1];
  const tokenNames = [...(calcBody?.matchAll(/var\((--[\w-]+)\)/g) ?? [])].map((match) => match[1]);
  if (tokenNames.length === 0 || tokenNames.some((tokenName) => tokenValues[tokenName] === undefined)) {
    throw new Error(`Unable to resolve CSS calc sum: ${value}`);
  }
  return tokenNames.reduce((sum, tokenName) => sum + tokenValues[tokenName], 0);
}

function mockLogs(
  entries: AgentLogEntry[] = [],
  loading = false,
  overrides: Partial<ReturnType<typeof useAgentLogs>> = {},
) {
  mockedUseAgentLogs.mockReturnValue({
    entries,
    loading,
    clear: vi.fn(),
    loadMore: vi.fn(async () => {}),
    hasMore: false,
    total: entries.length,
    loadingMore: false,
    ...overrides,
  });
}

function expectComposerSendableAfterDraft(message = "Please continue") {
  expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
  const input = screen.getByLabelText("Message active agent session");
  expect(input).not.toBeDisabled();
  const sendButton = screen.getByRole("button", { name: "Send" });
  expect(sendButton).toBeDisabled();

  fireEvent.change(input, { target: { value: message } });
  expect(sendButton).not.toBeDisabled();
}

function expectTranscriptTextOrder(...texts: string[]) {
  const transcriptText = screen.getByTestId("task-chat-transcript").textContent ?? "";
  let previousIndex = -1;
  for (const text of texts) {
    const index = transcriptText.indexOf(text);
    expect(index, `Expected transcript to contain ${text}`).toBeGreaterThanOrEqual(0);
    expect(index, `Expected ${text} to appear after the previous transcript text`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

function expectIdleSessionHint() {
  // FNXC:TaskDetailChat 2026-06-22-21:20: The idle "No agent is working…" banner was removed per user request — idle chats stay sendable with no hint shown.
  expect(screen.queryByTestId("task-chat-idle-hint")).not.toBeInTheDocument();
  expect(screen.queryByText(/no agent is working on this task right now/i)).not.toBeInTheDocument();
  expect(screen.getByPlaceholderText("Steer the currently executing agent")).toBeInTheDocument();
}

function expectActiveSessionCopy() {
  expect(screen.getByText(/active agent session/i)).toBeInTheDocument();
  expect(screen.getByText(/delivered to the running session in real time/i)).toBeInTheDocument();
  expect(screen.queryByTestId("task-chat-idle-hint")).not.toBeInTheDocument();
}

function expectDoneRefinementCopy() {
  expect(screen.getByText(/start a refinement task for this completed task/i)).toBeInTheDocument();
  expect(screen.getByPlaceholderText("Start a refinement task for this completed task")).toBeInTheDocument();
  expect(screen.queryByTestId("task-chat-idle-hint")).not.toBeInTheDocument();
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
    vi.useRealTimers();
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
    if (originalMatchMediaDescriptor) {
      Object.defineProperty(window, "matchMedia", originalMatchMediaDescriptor);
    } else {
      delete (window as Partial<Window>).matchMedia;
    }
  });

  it("subscribes to live agent logs only when active", () => {
    render(<TaskChatTab task={makeTask()} active={false} projectId="project-1" addToast={vi.fn()} />);
    expect(mockedUseAgentLogs).toHaveBeenCalledWith("FN-001", false, "project-1");
  });

  it("renders empty state without timestamp shells when no transcript messages exist", () => {
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByText(/No agent output yet/)).toBeTruthy();
    expect(within(transcript).queryByTestId("task-chat-group-time")).not.toBeInTheDocument();
    expect(within(transcript).queryByTestId("task-chat-user-time")).not.toBeInTheDocument();
    expect(transcript).not.toHaveTextContent(/NaN|Invalid Date/);
  });

  it("renders the collapsed icon-only expand toggle inside the chat view and calls the toggle handler", () => {
    const onToggleExpanded = vi.fn();
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} expanded={false} onToggleExpanded={onToggleExpanded} />);

    const toggle = screen.getByTestId("task-chat-expand-toggle");
    const transcript = screen.getByTestId("task-chat-transcript");
    expect(screen.getByTestId("task-chat-tab")).toContainElement(toggle);
    expect(transcript).not.toContainElement(toggle);
    expect(document.querySelector(".task-chat-toolbar")).toBeNull();
    expect(toggle).toHaveClass("btn-icon");
    expect(toggle).toHaveClass("task-chat-expand-toggle--overlay");
    expect(toggle).toHaveAttribute("aria-label", "Expand chat to full modal");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).not.toHaveTextContent("Expand");
    expect(toggle).not.toHaveTextContent("Collapse");

    fireEvent.click(toggle);
    expect(onToggleExpanded).toHaveBeenCalledTimes(1);
  });

  it("renders the expanded icon-only collapse toggle", () => {
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} expanded onToggleExpanded={vi.fn()} />);

    const toggle = screen.getByTestId("task-chat-expand-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Collapse chat");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).not.toHaveTextContent("Collapse");
    expect(toggle).not.toHaveTextContent("Expand");
  });

  it("renders the icon-only expand toggle while the transcript is loading", () => {
    mockLogs([], true);
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} onToggleExpanded={vi.fn()} />);

    const toggle = screen.getByTestId("task-chat-expand-toggle");
    expect(screen.getByTestId("task-chat-tab")).toContainElement(toggle);
    expect(toggle).not.toHaveTextContent("Expand");
    expect(screen.getByText("Loading agent output…")).toBeInTheDocument();
  });

  it("renders the icon-only expand toggle in the empty transcript state", () => {
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} onToggleExpanded={vi.fn()} />);

    const toggle = screen.getByTestId("task-chat-expand-toggle");
    expect(screen.getByTestId("task-chat-tab")).toContainElement(toggle);
    expect(toggle).not.toHaveTextContent("Expand");
    expect(screen.getByText(/No agent output yet/)).toBeInTheDocument();
  });

  it("renders the icon-only expand toggle in the populated transcript state", () => {
    mockLogs([makeEntry({ agent: "executor", text: "executor output" })]);
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} onToggleExpanded={vi.fn()} />);

    const transcript = screen.getByTestId("task-chat-transcript");
    const toggle = screen.getByTestId("task-chat-expand-toggle");
    expect(screen.getByTestId("task-chat-tab")).toContainElement(toggle);
    expect(transcript).not.toContainElement(toggle);
    expect(toggle).not.toHaveTextContent("Expand");
    expect(within(transcript).getByText("executor output")).toBeInTheDocument();
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
    expect(screen.getAllByLabelText(/model provider unknown/)).toHaveLength(5);
  });

  it("renders provider icons for task chat roles from task model overrides", () => {
    mockLogs([
      makeEntry({ agent: "triage", text: "planning output" }),
      makeEntry({ agent: "executor", text: "executor output" }),
      makeEntry({ agent: "reviewer", text: "reviewer output" }),
      makeEntry({ agent: "merger", text: "merger output" }),
    ]);

    render(
      <TaskChatTab
        task={makeTask({
          planningModelProvider: "google",
          planningModelId: "gemini-pro",
          modelProvider: "openai",
          modelId: "gpt-4o",
          validatorModelProvider: "anthropic",
          validatorModelId: "claude-sonnet-4-5",
        })}
        active
        addToast={vi.fn()}
      />,
    );

    expect(document.querySelector(".task-chat-provider-icon [data-provider='google']")).toBeTruthy();
    expect(document.querySelector(".task-chat-provider-icon [data-provider='openai']")).toBeTruthy();
    expect(document.querySelectorAll(".task-chat-provider-icon [data-provider='anthropic']")).toHaveLength(2);
  });

  it("renders provider icons for task chat roles from runtime model markers", () => {
    mockLogs([
      makeEntry({ agent: "triage", text: "Triage using model: google/gemini-pro" }),
      makeEntry({ agent: "executor", text: "Executor using model: openai/gpt-4o" }),
      makeEntry({ agent: "reviewer", text: "Reviewer using model: anthropic/claude-sonnet-4-5" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(document.querySelector(".task-chat-provider-icon [data-provider='google']")).toBeTruthy();
    expect(document.querySelector(".task-chat-provider-icon [data-provider='openai']")).toBeTruthy();
    expect(document.querySelector(".task-chat-provider-icon [data-provider='anthropic']")).toBeTruthy();
  });

  it("renders provider icons for task chat roles from effective default models", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "executor output without model marker" }),
    ]);

    render(
      <TaskChatTab
        task={makeTask()}
        active
        addToast={vi.fn()}
        effectiveModels={{ executor: { provider: "openai-codex", modelId: "gpt-5.5" } }}
      />,
    );

    expect(document.querySelector(".task-chat-provider-icon [data-provider='openai-codex']")).toBeTruthy();
    expect(screen.queryByLabelText("Executor: model provider unknown")).not.toBeInTheDocument();
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

  it("renders a relative timestamp for a single-entry agent group", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T15:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "executor", text: "single timestamped response", timestamp: "2026-06-17T14:59:30.000Z" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByText("1 entry")).toBeVisible();
    expect(screen.getByTestId("task-chat-group-time")).toHaveTextContent("just now");
  });

  it("renders the latest-entry relative timestamp alongside multi-entry group meta", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T15:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "executor", text: "older group entry", timestamp: "2026-06-17T14:50:00.000Z" }),
      makeEntry({ agent: "executor", text: "latest group entry", timestamp: "2026-06-17T14:58:00.000Z" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const executorGroup = screen.getByLabelText("Executor messages");
    const groupMeta = executorGroup.querySelector(".task-chat-group-meta");
    expect(groupMeta).not.toBeNull();
    expect(within(groupMeta as HTMLElement).getByText("2 entries")).toBeVisible();
    expect(within(groupMeta as HTMLElement).getByTestId("task-chat-group-time")).toHaveTextContent("2m ago");
  });

  it("keeps agent and user timestamp parity in the inline chat surface", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T15:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "executor", text: "inline agent response", timestamp: "2026-06-17T14:58:30.000Z" }),
    ]);

    render(
      <TaskChatTab
        task={makeTask({
          steeringComments: [makeSteeringComment({ id: "inline-user", text: "inline user guidance", createdAt: "2026-06-17T14:57:00.000Z" })],
        })}
        active
        expanded={false}
        addToast={vi.fn()}
      />,
    );

    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByText("inline agent response")).toBeVisible();
    expect(within(transcript).getByText("inline user guidance")).toBeVisible();
    expect(within(transcript).getByTestId("task-chat-group-time")).toHaveTextContent("1m ago");
    expect(within(transcript).getByTestId("task-chat-user-time")).toHaveTextContent("3m ago");
  });

  it("keeps agent and user timestamp parity in the expanded chat surface", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T15:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "executor", text: "expanded single entry", timestamp: "2026-06-17T14:59:30.000Z" }),
      makeEntry({ agent: "reviewer", text: "expanded older reviewer entry", timestamp: "2026-06-17T14:53:00.000Z" }),
      makeEntry({ agent: "reviewer", text: "expanded latest reviewer entry", timestamp: "2026-06-17T14:55:00.000Z" }),
    ]);

    render(
      <TaskChatTab
        task={makeTask({
          steeringComments: [makeSteeringComment({ id: "expanded-user", text: "expanded user guidance", createdAt: "2026-06-17T14:57:00.000Z" })],
        })}
        active
        expanded
        onToggleExpanded={vi.fn()}
        addToast={vi.fn()}
      />,
    );

    const executorMeta = screen.getByLabelText("Executor messages").querySelector(".task-chat-group-meta");
    const reviewerMeta = screen.getByLabelText("Reviewer messages").querySelector(".task-chat-group-meta");
    const userHeader = screen.getByText("You").closest(".task-chat-user-header");
    expect(executorMeta).not.toBeNull();
    expect(reviewerMeta).not.toBeNull();
    expect(userHeader).not.toBeNull();
    expect(within(executorMeta as HTMLElement).getByText("1 entry")).toBeVisible();
    expect(within(executorMeta as HTMLElement).getByTestId("task-chat-group-time")).toHaveTextContent("just now");
    expect(within(reviewerMeta as HTMLElement).getByText("2 entries")).toBeVisible();
    expect(within(reviewerMeta as HTMLElement).getByTestId("task-chat-group-time")).toHaveTextContent("5m ago");
    expect(within(userHeader as HTMLElement).getByTestId("task-chat-user-time")).toHaveTextContent("3m ago");
  });

  it.each([
    ["inline", false],
    ["expanded", true],
  ])("renders the idle no-reply hint in the %s task chat surface", (_label, expanded) => {
    render(
      <TaskChatTab
        task={makeTask({ column: "todo", assignedAgentId: undefined, checkedOutBy: undefined, status: undefined })}
        active
        expanded={expanded}
        onToggleExpanded={expanded ? vi.fn() : undefined}
        addToast={vi.fn()}
        sessionLive={false}
      />,
    );

    expectIdleSessionHint();
  });

  it.each([
    ["inline planning", false, "planning"],
    ["expanded planning", true, "planning"],
    ["inline cleared status", false, null],
    ["expanded cleared status", true, null],
  ] as const)("renders active planning guidance in the %s task chat surface", (_label, expanded, status) => {
    render(
      <TaskChatTab
        task={makeTask({ column: "triage", status, assignedAgentId: undefined, checkedOutBy: undefined })}
        active
        expanded={expanded}
        onToggleExpanded={expanded ? vi.fn() : undefined}
        addToast={vi.fn()}
        sessionLive={false}
      />,
    );

    expectActiveSessionCopy();
  });

  it.each([
    ["empty", [], false, makeTask({ column: "triage", status: "planning", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["populated", [makeEntry({ agent: "triage", text: "Planner is drafting the spec" })], false, makeTask({
      column: "triage",
      status: "planning",
      assignedAgentId: undefined,
      checkedOutBy: undefined,
      steeringComments: [makeSteeringComment({ id: "planning-populated-user", text: "Earlier planning guidance" })],
    })],
    ["loading", [], true, makeTask({ column: "triage", status: null, assignedAgentId: undefined, checkedOutBy: undefined })],
  ] as const)("keeps planning-session guidance active with an %s transcript", (_label, entries, loading, task) => {
    mockLogs([...entries], loading);
    render(<TaskChatTab task={task} active addToast={vi.fn()} sessionLive={false} />);

    expectActiveSessionCopy();
  });

  it.each([
    ["empty", [], makeTask({ column: "todo", assignedAgentId: undefined, checkedOutBy: undefined, status: undefined })],
    ["populated", [makeEntry({ agent: "executor", text: "Earlier agent output" })], makeTask({
      column: "todo",
      assignedAgentId: undefined,
      checkedOutBy: undefined,
      status: undefined,
      steeringComments: [makeSteeringComment({ id: "idle-populated-user", text: "Earlier saved guidance" })],
    })],
  ] as const)("renders the composer-anchored idle hint with an %s transcript", (_label, entries, task) => {
    mockLogs([...entries]);
    render(<TaskChatTab task={task} active addToast={vi.fn()} sessionLive={false} />);

    expectIdleSessionHint();
  });

  it("renders a single text entry as one text bubble", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "single response" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const textBubbles = screen.getAllByTestId("task-chat-entry-text");
    expect(textBubbles).toHaveLength(1);
    expect(within(textBubbles[0]).getByText("single response")).toBeVisible();
  });

  it("combines consecutive text entries into one continuous text bubble", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "first chunk " }),
      makeEntry({ agent: "executor", text: "second chunk" }),
      makeEntry({ agent: "executor", text: " third chunk" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const textBubbles = screen.getAllByTestId("task-chat-entry-text");
    expect(textBubbles).toHaveLength(1);
    expect(textBubbles[0]).toHaveClass("task-chat-entry", "task-chat-entry--text");
    expect(textBubbles[0]).toHaveTextContent("first chunk second chunk third chunk");
    expect(within(textBubbles[0]).queryByRole("separator")).not.toBeInTheDocument();
  });

  it("keeps text entries on different agent-role runs in separate bubbles", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "executor first" }),
      makeEntry({ agent: "executor", text: " executor second" }),
      makeEntry({ agent: "reviewer", text: "reviewer first" }),
      makeEntry({ agent: "reviewer", text: " reviewer second" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const textBubbles = screen.getAllByTestId("task-chat-entry-text");
    expect(textBubbles).toHaveLength(2);
    expect(within(screen.getByLabelText("Executor messages")).getByTestId("task-chat-entry-text"))
      .toHaveTextContent("executor first executor second");
    expect(within(screen.getByLabelText("Reviewer messages")).getByTestId("task-chat-entry-text"))
      .toHaveTextContent("reviewer first reviewer second");
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
    expect(toolGroup).toHaveClass("task-chat-tool-group");
    expect(summary).toHaveClass("task-chat-tool-group-summary");
    expect(toolGroup).not.toHaveAttribute("open");
    expect(within(summary as HTMLElement).getByText("1 tool call")).toBeVisible();
    expect(within(summary as HTMLElement).getByText("bash")).toBeVisible();
    expect(screen.queryByText("2 tool calls")).not.toBeInTheDocument();
    expect(screen.getByText("pnpm test")).not.toBeVisible();
    expect(screen.getByText("ok")).not.toBeVisible();

    await user.click(within(summary as HTMLElement).getByText("1 tool call"));

    expect(toolGroup).toHaveAttribute("open");
    const invocation = screen.getByTestId("task-chat-tool-invocation");
    const kicker = screen.getByText("Tool call → Result");
    expect(invocation).toHaveClass("task-chat-tool-entry", "task-chat-tool-invocation");
    expect(kicker).toHaveClass("task-chat-entry-kicker");
    expect(kicker).toBeVisible();
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

    expect(screen.getByText("Tool call → Error")).toBeVisible();
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

  it("falls back to result entries when a tool completion has no preceding call", async () => {
    const user = userEvent.setup();
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

    await user.click(within(summary as HTMLElement).getByText("1 tool call"));

    const standaloneEntry = screen.getByTestId("task-chat-entry-tool_result");
    const standaloneKicker = screen.getByText("Tool result");
    expect(standaloneEntry).toHaveClass("task-chat-tool-entry");
    expect(standaloneKicker).toHaveClass("task-chat-entry-kicker");
  });

  it("renders thinking in an expanded-by-default collapsible block", async () => {
    const user = userEvent.setup();
    mockLogs([
      makeEntry({ agent: "triage", type: "thinking", text: "I am considering options" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const thinking = screen.getByTestId("task-chat-thinking");
    expect(thinking).toHaveAttribute("open");
    expect(within(thinking).getByText("Thinking")).toBeVisible();
    expect(screen.getByText("I am considering options")).toBeVisible();
    expect(within(thinking).getAllByTestId("task-chat-entry-thinking")).toHaveLength(1);

    await user.click(within(thinking).getByText("Thinking"));

    expect(thinking).not.toHaveAttribute("open");
    expect(screen.getByText("I am considering options")).not.toBeVisible();
  });

  it("renders consecutive thinking entries as one continuous section", () => {
    mockLogs([
      makeEntry({ agent: "triage", type: "thinking", text: "First" }),
      makeEntry({ agent: "triage", type: "thinking", text: "Second", timestamp: "2026-06-12T00:00:01.000Z" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    const thinking = screen.getByTestId("task-chat-thinking");
    const summary = thinking.querySelector("summary");
    expect(summary).toBeTruthy();
    expect(within(summary as HTMLElement).getByText("Thinking")).toBeVisible();
    expect(screen.queryByText("2 thinking entries")).not.toBeInTheDocument();
    const thinkingBlocks = within(thinking).getAllByTestId("task-chat-entry-thinking");
    expect(thinkingBlocks).toHaveLength(1);
    expect(thinkingBlocks[0]).toHaveTextContent("FirstSecond");
    expect(thinkingBlocks[0].nextElementSibling).toBeNull();
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
    expect(screen.getAllByTestId("task-chat-entry-text")).toHaveLength(1);
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
    expect(screen.getAllByTestId("task-chat-entry-text")).toHaveLength(2);
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

  it("loads previous messages on scroll-to-top and via the expanded-mode button", async () => {
    const user = userEvent.setup();
    const metrics = mockTranscriptMetrics({ scrollHeight: 1000, clientHeight: 240, initialScrollTop: 1000 });
    const loadMore = vi.fn(async () => {});
    mockLogs([makeEntry({ agent: "executor", text: "current output" })], false, { hasMore: true, loadMore });

    render(<TaskChatTab task={makeTask()} active expanded onToggleExpanded={vi.fn()} addToast={vi.fn()} />);

    metrics.scrollTop = 0;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    await waitFor(() => expect(loadMore).toHaveBeenCalledTimes(1));

    await user.click(screen.getByTestId("task-chat-load-previous"));
    expect(loadMore).toHaveBeenCalledTimes(2);
  });

  it("renders load-previous affordances only for available older history", () => {
    const loadMore = vi.fn(async () => {});
    mockLogs([makeEntry({ agent: "executor", text: "current output" })], false, { hasMore: true, loadMore });
    const { unmount } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    const button = screen.getByTestId("task-chat-load-previous");
    expect(button).toBeVisible();
    expect(button).toHaveAccessibleName("Load previous messages");
    unmount();

    mockLogs([makeEntry({ agent: "executor", text: "current output" })], false, { hasMore: true, loadingMore: true, loadMore });
    const loading = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByTestId("task-chat-load-previous-loading")).toHaveTextContent("Loading earlier messages…");
    expect(screen.queryByTestId("task-chat-load-previous")).not.toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    expect(loadMore).not.toHaveBeenCalled();
    loading.unmount();

    mockLogs([makeEntry({ agent: "executor", text: "current output" })], false, { hasMore: false, loadMore });
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.queryByTestId("task-chat-load-previous")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-chat-load-previous-loading")).not.toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    expect(loadMore).not.toHaveBeenCalled();
  });

  it("preserves scroll position when older entries are prepended", async () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1000, clientHeight: 240, initialScrollTop: 0 });
    const loadMoreDeferred = deferred<void>();
    const loadMore = vi.fn(() => loadMoreDeferred.promise);
    const currentEntries = [
      makeEntry({ agent: "executor", text: "current first", timestamp: "2026-06-12T00:00:02.000Z" }),
      makeEntry({ agent: "executor", text: "current latest", timestamp: "2026-06-12T00:00:03.000Z" }),
    ];
    mockLogs(currentEntries, false, { hasMore: true, loadMore });

    const { rerender } = render(<TaskChatTab task={makeTask()} active expanded onToggleExpanded={vi.fn()} addToast={vi.fn()} />);
    metrics.scrollTop = 0;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    expect(loadMore).toHaveBeenCalledTimes(1);

    metrics.scrollHeight = 1400;
    mockLogs([
      makeEntry({ agent: "executor", text: "older history", timestamp: "2026-06-12T00:00:01.000Z" }),
      ...currentEntries,
    ], false, { hasMore: false, loadMore });
    await act(async () => {
      loadMoreDeferred.resolve();
      await loadMoreDeferred.promise;
    });
    rerender(<TaskChatTab task={makeTask()} active expanded onToggleExpanded={vi.fn()} addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(400);
    expect(metrics.scrollTop).not.toBe(metrics.scrollHeight);
    expect(screen.getByTestId("task-chat-jump-to-bottom")).toBeVisible();
  });

  it("keeps live appends following the bottom while load-previous is in flight", async () => {
    const user = userEvent.setup();
    const metrics = mockTranscriptMetrics({ scrollHeight: 1000, clientHeight: 240, initialScrollTop: 0 });
    const loadMoreDeferred = deferred<void>();
    const loadMore = vi.fn(() => loadMoreDeferred.promise);
    const currentEntries = [makeEntry({ agent: "executor", text: "current output", timestamp: "2026-06-12T00:00:02.000Z" })];
    mockLogs(currentEntries, false, { hasMore: true, loadMore });

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(1000);
    await user.click(screen.getByTestId("task-chat-load-previous"));
    expect(loadMore).toHaveBeenCalledTimes(1);

    metrics.scrollHeight = 1300;
    mockLogs([
      ...currentEntries,
      makeEntry({ agent: "executor", text: "live tail", timestamp: "2026-06-12T00:00:03.000Z" }),
    ], false, { hasMore: true, loadMore });
    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(1300);

    metrics.scrollHeight = 1700;
    mockLogs([
      makeEntry({ agent: "executor", text: "older history", timestamp: "2026-06-12T00:00:01.000Z" }),
      ...currentEntries,
      makeEntry({ agent: "executor", text: "live tail", timestamp: "2026-06-12T00:00:03.000Z" }),
    ], false, { hasMore: false, loadMore });
    await act(async () => {
      loadMoreDeferred.resolve();
      await loadMoreDeferred.promise;
    });
    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(metrics.scrollTop).toBe(1700);
    expect(screen.queryByTestId("task-chat-jump-to-bottom")).not.toBeInTheDocument();
  });

  it("preserves steering-comment ordering after older entries are prepended", async () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1000, clientHeight: 240, initialScrollTop: 0 });
    const loadMoreDeferred = deferred<void>();
    const loadMore = vi.fn(() => loadMoreDeferred.promise);
    const currentEntries = [makeEntry({ agent: "executor", text: "newer agent output", timestamp: "2026-06-12T00:00:03.000Z" })];
    const task = makeTask({
      steeringComments: [makeSteeringComment({ text: "middle user guidance", createdAt: "2026-06-12T00:00:02.000Z" })],
    });
    mockLogs(currentEntries, false, { hasMore: true, loadMore });

    const { rerender } = render(<TaskChatTab task={task} active addToast={vi.fn()} />);
    metrics.scrollTop = 0;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));

    metrics.scrollHeight = 1400;
    mockLogs([
      makeEntry({ agent: "executor", text: "older agent output", timestamp: "2026-06-12T00:00:01.000Z" }),
      ...currentEntries,
    ], false, { hasMore: false, loadMore });
    await act(async () => {
      loadMoreDeferred.resolve();
      await loadMoreDeferred.promise;
    });
    rerender(<TaskChatTab task={task} active addToast={vi.fn()} />);

    const transcriptText = screen.getByTestId("task-chat-transcript").textContent ?? "";
    expect(transcriptText.indexOf("older agent output")).toBeLessThan(transcriptText.indexOf("middle user guidance"));
    expect(transcriptText.indexOf("middle user guidance")).toBeLessThan(transcriptText.indexOf("newer agent output"));
  });

  it("does not render the jump-to-bottom button for loading or empty transcripts", () => {
    mockLogs([], true);
    const loading = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByText(/Loading agent output/)).toBeVisible();
    expect(screen.queryByTestId("task-chat-jump-to-bottom")).not.toBeInTheDocument();
    loading.unmount();

    mockLogs([]);
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByText(/No agent output yet/)).toBeVisible();
    expect(screen.queryByTestId("task-chat-jump-to-bottom")).not.toBeInTheDocument();
  });

  it("renders the jump-to-bottom button only after a populated transcript is scrolled up", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([makeEntry({ agent: "executor", text: "latest output" })]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(metrics.scrollTop).toBe(1200);
    expect(screen.queryByTestId("task-chat-jump-to-bottom")).not.toBeInTheDocument();

    metrics.scrollTop = 920;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    expect(screen.queryByTestId("task-chat-jump-to-bottom")).not.toBeInTheDocument();

    metrics.scrollTop = 600;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));
    const jumpButton = screen.getByTestId("task-chat-jump-to-bottom");
    expect(jumpButton).toBeVisible();
    expect(jumpButton).toHaveAccessibleName("Jump to latest message");
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBe(jumpButton);
  });

  it("keeps the icon-only expand toggle accessible after transcript scrolling", () => {
    const metrics = mockTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([makeEntry({ agent: "executor", text: "scrollable output" })]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} expanded={false} onToggleExpanded={vi.fn()} />);
    const transcript = screen.getByTestId("task-chat-transcript");

    metrics.scrollTop = 600;
    fireEvent.scroll(transcript);

    const toggle = screen.getByTestId("task-chat-expand-toggle");
    expect(toggle).toBeInTheDocument();
    expect(toggle).toBeVisible();
    expect(toggle).toHaveAccessibleName("Expand chat to full modal");
    expect(toggle).not.toHaveTextContent("Expand");
    expect(transcript).not.toContainElement(toggle);
  });

  it("clicking the jump-to-bottom button snaps to the latest message and removes the control", async () => {
    const user = userEvent.setup();
    const metrics = mockTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([makeEntry({ agent: "executor", text: "latest output" })]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    metrics.scrollTop = 120;
    fireEvent.scroll(screen.getByTestId("task-chat-transcript"));

    await user.click(screen.getByTestId("task-chat-jump-to-bottom"));

    expect(metrics.scrollTop).toBe(1200);
    expect(screen.queryByTestId("task-chat-jump-to-bottom")).not.toBeInTheDocument();
  });

  it("keeps the jump-to-bottom affordance available at the mobile breakpoint", () => {
    mockMatchMedia(true);
    mockTranscriptMetrics({ scrollHeight: 1200, clientHeight: 240, initialScrollTop: 0 });
    mockLogs([makeEntry({ agent: "executor", text: "mobile output" })]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    const transcript = screen.getByTestId("task-chat-transcript");
    transcript.scrollTop = 120;
    fireEvent.scroll(transcript);

    expect(screen.getByTestId("task-chat-jump-to-bottom")).toBeVisible();
    expect(screen.getByRole("button", { name: "Jump to latest message" })).toHaveClass("task-chat-jump-to-bottom");
  });

  it("renders an icon-only send button with preserved accessible name and new placeholder", () => {
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByPlaceholderText("Steer the currently executing agent")).toBeInTheDocument();
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toHaveClass("task-chat-send");
    expect(sendButton).toHaveTextContent("");
  });

  it("posts composer text through addSteeringComment and clears on success", async () => {
    const user = userEvent.setup();
    const onTaskUpdated = vi.fn();
    const updatedTask = makeTask();
    mockedAddSteeringComment.mockResolvedValue(updatedTask);
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);

    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    await user.type(input, "Please inspect the failing test");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Please inspect the failing test", "project-1");
    });
    expect(mockedRefineTask).not.toHaveBeenCalled();
    expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
    expect(input).toHaveValue("");
  });

  it("routes done-task composer sends to refineTask without replacing the current task", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const refinementTask = makeTask({ id: "FN-222", column: "todo" });
    mockedRefineTask.mockResolvedValue(refinementTask);
    render(
      <TaskChatTab
        task={makeTask({ column: "done", status: undefined })}
        projectId="project-1"
        active
        addToast={addToast}
        onTaskUpdated={onTaskUpdated}
      />,
    );

    expectDoneRefinementCopy();
    const input = screen.getByLabelText("Message active agent session");
    await user.type(input, "Please add a follow-up report");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mockedRefineTask).toHaveBeenCalledWith("FN-001", "Please add a follow-up report", "project-1");
    });
    expect(mockedAddSteeringComment).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("task-chat-transcript")).getByText("You")).toBeVisible();
    expect(within(screen.getByTestId("task-chat-transcript")).getByText("Please add a follow-up report")).toBeVisible();
    expect(input).toHaveValue("");
    expect(addToast).toHaveBeenCalledWith("Refinement task created: FN-222", "success");
    expect(onTaskUpdated).not.toHaveBeenCalledWith(refinementTask);
    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it("sends an in-progress task steering message on plain Enter", async () => {
    const onTaskUpdated = vi.fn();
    const updatedTask = makeTask();
    mockedAddSteeringComment.mockResolvedValue(updatedTask);
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} onTaskUpdated={onTaskUpdated} />);

    const input = screen.getByLabelText("Message active agent session");
    fireEvent.change(input, { target: { value: "Plain Enter guidance" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Plain Enter guidance", "project-1");
    });
    expect(mockedAddSteeringComment).toHaveBeenCalledTimes(1);
    expect(mockedRefineTask).not.toHaveBeenCalled();
    expect(onTaskUpdated).toHaveBeenCalledWith(updatedTask);
  });

  it("sends a done-task refinement on plain Enter", async () => {
    const refinementTask = makeTask({ id: "FN-224", column: "todo" });
    mockedRefineTask.mockResolvedValue(refinementTask);
    render(<TaskChatTab task={makeTask({ column: "done" })} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    fireEvent.change(input, { target: { value: "Plain Enter refinement" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockedRefineTask).toHaveBeenCalledWith("FN-001", "Plain Enter refinement", "project-1");
    });
    expect(mockedRefineTask).toHaveBeenCalledTimes(1);
    expect(mockedAddSteeringComment).not.toHaveBeenCalled();
  });

  it("keeps Shift+Enter as textarea newline input without sending", async () => {
    const user = userEvent.setup();
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    await user.click(input);
    await user.keyboard("Line one");
    await user.keyboard("{Shift>}{Enter}{/Shift}Line two");

    expect(input).toHaveValue("Line one\nLine two");
    expect(mockedAddSteeringComment).not.toHaveBeenCalled();
    expect(mockedRefineTask).not.toHaveBeenCalled();
  });

  it.each(["", "   \n  "])("does not send a %s draft on Enter", async (draft) => {
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    fireEvent.change(input, { target: { value: draft } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(mockedAddSteeringComment).not.toHaveBeenCalled();
      expect(mockedRefineTask).not.toHaveBeenCalled();
    });
  });

  it("does not submit another Enter while a send is already in flight", async () => {
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    fireEvent.change(input, { target: { value: "Only send once" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("button", { name: "Sending" })).toBeDisabled();

    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(mockedAddSteeringComment).toHaveBeenCalledTimes(1);

    await act(async () => {
      send.resolve(makeTask());
      await send.promise;
    });
  });

  it.each([
    ["isComposing", { isComposing: true }],
    ["keyCode 229", { keyCode: 229 }],
  ])("does not send Enter during IME composition signaled by %s", async (_label, eventPatch) => {
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    fireEvent.change(input, { target: { value: "Composing text" } });
    const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries(eventPatch)) {
      Object.defineProperty(event, key, { value });
    }
    fireEvent(input, event);

    await waitFor(() => {
      expect(mockedAddSteeringComment).not.toHaveBeenCalled();
      expect(mockedRefineTask).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["Cmd+Enter", { metaKey: true }],
    ["Ctrl+Enter", { ctrlKey: true }],
  ])("keeps %s sending for backward compatibility", async (_label, modifier) => {
    mockedAddSteeringComment.mockResolvedValue(makeTask());
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    fireEvent.change(input, { target: { value: "Shortcut guidance" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ...modifier });

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Shortcut guidance", "project-1");
    });
    expect(mockedAddSteeringComment).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, "failed", "done"])("routes done-task sends to refineTask regardless of %s status", async (status) => {
    const user = userEvent.setup();
    mockedRefineTask.mockResolvedValue(makeTask({ id: "FN-333", column: "todo" }));
    render(<TaskChatTab task={makeTask({ column: "done", status })} projectId="project-1" active addToast={vi.fn()} />);

    await user.type(screen.getByLabelText("Message active agent session"), `Refine from ${String(status)}`);
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mockedRefineTask).toHaveBeenCalledWith("FN-001", `Refine from ${String(status)}`, "project-1");
    });
    expect(mockedAddSteeringComment).not.toHaveBeenCalled();
  });

  it.each([
    ["in-progress", makeTask({ column: "in-progress", assignedAgentId: "agent-1", status: "queued" })],
    ["in-review", makeTask({ column: "in-review", assignedAgentId: "agent-1", status: "reviewing" })],
    ["todo", makeTask({ column: "todo", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["triage", makeTask({ column: "triage", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["archived", makeTask({ column: "archived", assignedAgentId: undefined, checkedOutBy: undefined })],
  ])("keeps %s sends routed to addSteeringComment", async (_label, task) => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(task);
    render(<TaskChatTab task={task} projectId="project-1" active addToast={vi.fn()} sessionLive={false} />);

    await user.type(screen.getByLabelText("Message active agent session"), "Keep steering");
    await user.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Keep steering", "project-1");
    });
    expect(mockedRefineTask).not.toHaveBeenCalled();
  });

  it("renders a sent user message in the chat transcript", async () => {
    const user = userEvent.setup();
    mockLogs([
      makeEntry({ agent: "executor", text: "I am checking the failure", timestamp: "2026-06-12T00:00:00.000Z" }),
    ]);
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1" })} projectId="project-1" active addToast={vi.fn()} />);

    const input = screen.getByLabelText("Message active agent session");
    await user.type(input, "Please inspect the failing test");
    await user.click(screen.getByRole("button", { name: "Send" }));

    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByText("You")).toBeVisible();
    expect(within(transcript).getByText("Please inspect the failing test")).toBeVisible();
    expect(within(transcript).getByTestId("task-chat-entry-user")).toBeVisible();
    expect(within(transcript).getByTestId("task-chat-user-time")).toBeVisible();
    expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Please inspect the failing test", "project-1");

    await act(async () => {
      send.resolve(makeTask({ steeringComments: [makeSteeringComment({ id: "steer-sent", text: "Please inspect the failing test" })] }));
      await send.promise;
    });

    expect(within(transcript).getByText("Please inspect the failing test")).toBeVisible();
    expect(input).toHaveValue("");
  });

  it("renders a just-now timestamp for an optimistic user message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T15:00:00.000Z"));
    mockedAddSteeringComment.mockReturnValue(deferred<Task>().promise);
    render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message active agent session"), { target: { value: "Optimistic timestamp" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByText("Optimistic timestamp")).toBeVisible();
    expect(within(transcript).getByTestId("task-chat-user-time")).toHaveTextContent("just now");
  });

  it("renders a sent user message after pre-existing agent output under client-behind-server clock skew", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "executor", text: "agent output with server timestamp", timestamp: "2026-06-12T00:00:05.000Z" }),
    ]);
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1" })} projectId="project-1" active addToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message active agent session"), { target: { value: "Please stay below the agent output" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expectTranscriptTextOrder("agent output with server timestamp", "Please stay below the agent output");
  });

  it.each([
    ["in-review client-ahead mobile", makeTask({ column: "in-review", assignedAgentId: "agent-1", status: "reviewing" }), "2026-06-12T00:00:10.000Z", true],
    ["in-progress clock-sync desktop", makeTask({ column: "in-progress", assignedAgentId: "agent-1", status: "queued" }), "2026-06-12T00:00:05.000Z", false],
  ])("keeps sent user messages at the transcript tail for %s", (_label, task, now, mobile) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    mockMatchMedia(mobile);
    mockLogs([
      makeEntry({ agent: "executor", text: "pre-existing agent output", timestamp: "2026-06-12T00:00:05.000Z" }),
    ]);
    mockedAddSteeringComment.mockReturnValue(deferred<Task>().promise);
    render(<TaskChatTab task={task} projectId="project-1" active addToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message active agent session"), { target: { value: "Tail guidance" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expectTranscriptTextOrder("pre-existing agent output", "Tail guidance");
  });

  it("renders agent follow-up below the newly-sent user message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    const task = makeTask({ steeringComments: [makeSteeringComment({ id: "old-user", text: "historical guidance", createdAt: "2026-06-12T00:00:02.000Z" })] });
    mockLogs([
      makeEntry({ agent: "executor", text: "pre-existing output", timestamp: "2026-06-12T00:00:05.000Z" }),
    ]);
    mockedAddSteeringComment.mockReturnValue(deferred<Task>().promise);
    const { rerender } = render(<TaskChatTab task={task} projectId="project-1" active addToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message active agent session"), { target: { value: "New steering" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expectTranscriptTextOrder("historical guidance", "pre-existing output", "New steering");

    mockLogs([
      makeEntry({ agent: "executor", text: "pre-existing output", timestamp: "2026-06-12T00:00:05.000Z" }),
      makeEntry({ agent: "executor", text: "agent follow-up after steering", timestamp: "2026-06-12T00:00:06.000Z" }),
    ]);
    rerender(<TaskChatTab task={task} projectId="project-1" active addToast={vi.fn()} />);

    expectTranscriptTextOrder("pre-existing output", "New steering", "agent follow-up after steering");
  });

  it("keeps a reconciled persisted steering comment at the clamped tail without duplication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "executor", text: "agent output before send", timestamp: "2026-06-12T00:00:05.000Z" }),
    ]);
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    const persistedComment = makeSteeringComment({ id: "steer-reconciled", text: "Reconciled guidance", createdAt: "2026-06-12T00:00:01.000Z" });
    const { rerender } = render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message active agent session"), { target: { value: "Reconciled guidance" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expectTranscriptTextOrder("agent output before send", "Reconciled guidance");

    await act(async () => {
      send.resolve(makeTask({ steeringComments: [persistedComment] }));
      await send.promise;
    });
    rerender(<TaskChatTab task={makeTask({ steeringComments: [persistedComment] })} projectId="project-1" active addToast={vi.fn()} />);

    expectTranscriptTextOrder("agent output before send", "Reconciled guidance");
    expect(within(screen.getByTestId("task-chat-transcript")).getAllByText("Reconciled guidance")).toHaveLength(1);
  });

  it("inserts done-task refinement messages immediately at the transcript tail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
    mockLogs([
      makeEntry({ agent: "reviewer", text: "final agent summary", timestamp: "2026-06-12T00:00:05.000Z" }),
    ]);
    mockedRefineTask.mockReturnValue(deferred<Task>().promise);
    render(<TaskChatTab task={makeTask({ column: "done", status: "done", assignedAgentId: undefined })} projectId="project-1" active addToast={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("Message active agent session"), { target: { value: "Please refine this task" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expectTranscriptTextOrder("final agent summary", "Please refine this task");
    expect(mockedRefineTask).toHaveBeenCalledWith("FN-001", "Please refine this task", "project-1");
  });

  it("renders persisted user steering comments with a relative timestamp but not agent-authored steering comments", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T15:00:00.000Z"));
    render(
      <TaskChatTab
        task={makeTask({
          steeringComments: [
            makeSteeringComment({ id: "user-steer", text: "Persisted user guidance", author: "user", createdAt: "2026-06-17T14:00:00.000Z" }),
            makeSteeringComment({ id: "agent-steer", text: "Internal agent note", author: "agent" }),
          ],
        })}
        active
        addToast={vi.fn()}
      />,
    );

    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByText("You")).toBeVisible();
    expect(within(transcript).getByText("Persisted user guidance")).toBeVisible();
    expect(within(transcript).getByTestId("task-chat-user-time")).toHaveTextContent("1h ago");
    expect(within(transcript).queryByText("Internal agent note")).not.toBeInTheDocument();
  });

  it("omits invalid relative timestamps without crashing or rendering invalid-date text", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "invalid agent timestamp", timestamp: "not-a-date" }),
    ]);

    render(
      <TaskChatTab
        task={makeTask({
          steeringComments: [makeSteeringComment({ id: "invalid-user-time", text: "invalid user timestamp", createdAt: "not-a-date" })],
        })}
        active
        addToast={vi.fn()}
      />,
    );

    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByText("invalid agent timestamp")).toBeVisible();
    expect(within(transcript).getByText("invalid user timestamp")).toBeVisible();
    expect(within(transcript).queryByTestId("task-chat-group-time")).not.toBeInTheDocument();
    expect(within(transcript).queryByTestId("task-chat-user-time")).not.toBeInTheDocument();
    expect(transcript).not.toHaveTextContent(/NaN|Invalid Date/);
  });

  it("deduplicates optimistic messages when matching persisted comments arrive", async () => {
    const user = userEvent.setup();
    const persistedComment = makeSteeringComment({ id: "steer-dedup", text: "Do not duplicate me" });
    mockedAddSteeringComment.mockResolvedValue(makeTask({ steeringComments: [persistedComment] }));
    const { rerender } = render(<TaskChatTab task={makeTask()} projectId="project-1" active addToast={vi.fn()} />);

    await user.type(screen.getByLabelText("Message active agent session"), "Do not duplicate me");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Do not duplicate me", "project-1");
    });

    rerender(<TaskChatTab task={makeTask({ steeringComments: [persistedComment] })} projectId="project-1" active addToast={vi.fn()} />);

    expect(within(screen.getByTestId("task-chat-transcript")).getAllByText("Do not duplicate me")).toHaveLength(1);
  });

  it("deduplicates persisted user comments by fallback text and timestamp", () => {
    render(
      <TaskChatTab
        task={makeTask({
          steeringComments: [
            makeSteeringComment({ id: "", text: "Fallback duplicate", createdAt: "2026-06-12T00:00:04.000Z" }),
            makeSteeringComment({ id: "", text: "Fallback duplicate", createdAt: "2026-06-12T00:00:04.000Z" }),
          ],
        })}
        active
        addToast={vi.fn()}
      />,
    );

    expect(within(screen.getByTestId("task-chat-transcript")).getAllByText("Fallback duplicate")).toHaveLength(1);
  });

  it("interleaves user messages chronologically with agent output", () => {
    mockLogs([
      makeEntry({ agent: "executor", text: "first agent output", timestamp: "2026-06-12T00:00:00.000Z" }),
      makeEntry({ agent: "executor", text: "second agent output", timestamp: "2026-06-12T00:00:02.000Z" }),
    ]);

    render(
      <TaskChatTab
        task={makeTask({ steeringComments: [makeSteeringComment({ text: "middle user guidance", createdAt: "2026-06-12T00:00:01.000Z" })] })}
        active
        addToast={vi.fn()}
      />,
    );

    const transcriptText = screen.getByTestId("task-chat-transcript").textContent ?? "";
    expect(transcriptText.indexOf("first agent output")).toBeLessThan(transcriptText.indexOf("middle user guidance"));
    expect(transcriptText.indexOf("middle user guidance")).toBeLessThan(transcriptText.indexOf("second agent output"));
  });

  it.each([undefined, []])("does not render a phantom user bubble for %s steering comments", (steeringComments) => {
    render(<TaskChatTab task={makeTask({ steeringComments })} active addToast={vi.fn()} />);

    expect(screen.queryByTestId("task-chat-entry-user")).not.toBeInTheDocument();
    expect(screen.getByText(/No agent output yet/)).toBeVisible();
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

  it.each([
    ["idle todo task without an attached agent", makeTask({ column: "todo", assignedAgentId: undefined, checkedOutBy: undefined, status: undefined })],
    ["paused task", makeTask({ status: "paused" })],
  ])("FN-6354 keeps the composer sendable for %s", async (_label, task) => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(makeTask({
      ...task,
      steeringComments: [makeSteeringComment({ id: "steer-new", text: "Queue this for later" })],
    }));
    render(
      <TaskChatTab
        task={task}
        projectId="project-1"
        active
        addToast={vi.fn()}
        sessionLive={false}
      />,
    );

    expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
    expectIdleSessionHint();
    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).toBeDisabled();

    await user.type(input, "Queue this for later");
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Queue this for later", "project-1");
    });
    expectIdleSessionHint();
    expect(within(screen.getByTestId("task-chat-transcript")).getByText("Queue this for later")).toBeVisible();
  });

  it.each([
    ["todo task with no agent", makeTask({ column: "todo", assignedAgentId: undefined, checkedOutBy: undefined, status: undefined })],
    ["user-paused in-progress task", makeTask({ column: "in-progress", status: "queued", userPaused: true })],
  ])("makes the no-reply send path non-silent for a %s", async (_label, task) => {
    const user = userEvent.setup();
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    const message = `Will anyone answer ${_label}?`;
    render(<TaskChatTab task={task} projectId="project-1" active addToast={vi.fn()} sessionLive={false} />);

    expectIdleSessionHint();
    await user.type(screen.getByLabelText("Message active agent session"), message);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", message, "project-1");
    expectIdleSessionHint();
    expect(within(screen.getByTestId("task-chat-transcript")).getByText(message)).toBeVisible();

    await act(async () => {
      send.resolve(makeTask({ ...task, steeringComments: [makeSteeringComment({ id: `persisted-${task.column}`, text: message })] }));
      await send.promise;
    });

    expectIdleSessionHint();
    expect(within(screen.getByTestId("task-chat-transcript")).getByText(message)).toBeVisible();
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
      expectActiveSessionCopy();
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
    expectActiveSessionCopy();
    expect(screen.getByLabelText("Message active agent session")).not.toBeDisabled();
  });

  it.each(["done", "dead", "needsAttention", null] as const)("shows idle guidance but stays sendable when the CLI session is not live: %s", (agentState) => {
    const sessionLive = agentState === null ? isCliSessionLive(null) : isCliSessionLive(makeCliSession(agentState));
    render(
      <TaskChatTab
        task={makeTask({ column: "in-progress", status: "queued", assignedAgentId: undefined, checkedOutBy: undefined })}
        active
        addToast={vi.fn()}
        sessionLive={sessionLive}
      />,
    );

    expectIdleSessionHint();
    expectComposerSendableAfterDraft();
  });

  it.each([undefined, "planning", "merging", "merging-fix"])(
    "treats an actively-executing in-progress task as an active session even without an assignment (ephemeral mode): %s status",
    (status) => {
      // In the default ephemeral-agents mode the scheduler never writes
      // assignedAgentId/checkedOutBy, so a running in-progress task has no
      // assignment field yet IS being worked. It must NOT show the idle
      // "no agent is working" hint.
      render(
        <TaskChatTab
          task={makeTask({ column: "in-progress", status, assignedAgentId: undefined, checkedOutBy: undefined })}
          active
          addToast={vi.fn()}
          sessionLive={false}
        />,
      );

      expectActiveSessionCopy();
      expect(screen.getByLabelText("Message active agent session")).not.toBeDisabled();
    },
  );

  it("keeps a queued (waiting) unassigned in-progress task idle in ephemeral mode", () => {
    render(
      <TaskChatTab
        task={makeTask({ column: "in-progress", status: "queued", assignedAgentId: undefined, checkedOutBy: undefined })}
        active
        addToast={vi.fn()}
        sessionLive={false}
      />,
    );

    expectIdleSessionHint();
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
      render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1", status })} active addToast={vi.fn()} sessionLive={false} />);

      expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("Message active agent session")).not.toBeDisabled();
    },
  );

  it("enables a non-CLI engine agent when the forwarded task carries full-detail agent fields", async () => {
    const user = userEvent.setup();
    mockedAddSteeringComment.mockResolvedValue(makeTask({ column: "in-progress", assignedAgentId: "agent-full", checkedOutBy: "agent-full", status: "queued" }));
    render(
      <TaskChatTab
        task={makeTask({ column: "in-progress", assignedAgentId: "agent-full", checkedOutBy: "agent-full", status: "queued" })}
        projectId="project-1"
        active
        addToast={vi.fn()}
        sessionLive={false}
      />,
    );

    expect(screen.queryByText(/No active steerable agent session/)).not.toBeInTheDocument();
    const input = screen.getByLabelText("Message active agent session");
    expect(input).not.toBeDisabled();
    await user.type(input, "Continue from the worktree");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    await waitFor(() => {
      expect(mockedAddSteeringComment).toHaveBeenCalledWith("FN-001", "Continue from the worktree", "project-1");
    });
  });

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
    ["in-progress task", makeTask({ column: "in-progress", assignedAgentId: "agent-1", status: undefined }), true],
    ["queued in-progress task", makeTask({ column: "in-progress", assignedAgentId: "agent-1", status: "queued" }), false],
    ["in-review task", makeTask({ column: "in-review", assignedAgentId: "agent-1", status: "reviewing" }), true],
    ["todo task", makeTask({ column: "todo", assignedAgentId: "agent-1", status: undefined }), false],
    ["triage task", makeTask({ column: "triage", assignedAgentId: "agent-1", status: undefined }), true],
    ["done task", makeTask({ column: "done", assignedAgentId: "agent-1", status: undefined }), false],
    ["archived task", makeTask({ column: "archived", assignedAgentId: "agent-1", status: undefined }), false],
  ])("keeps the composer sendable for %s column", (_label, task, showsActiveCopy) => {
    render(<TaskChatTab task={task} active addToast={vi.fn()} sessionLive={false} />);

    if (task.column === "done") {
      expectDoneRefinementCopy();
    } else if (showsActiveCopy) {
      expectActiveSessionCopy();
    } else {
      expectIdleSessionHint();
    }
    expectComposerSendableAfterDraft();
  });

  it.each([
    ["in-progress task without an assigned or checked-out agent", makeTask({ column: "in-progress", status: "queued", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["triage task waiting in the queue", makeTask({ column: "triage", status: "queued", assignedAgentId: undefined, checkedOutBy: undefined })],
    ["paused triage task", makeTask({ column: "triage", status: "planning", paused: true, assignedAgentId: undefined, checkedOutBy: undefined })],
    ["user-paused triage task", makeTask({ column: "triage", status: "planning", userPaused: true, assignedAgentId: undefined, checkedOutBy: undefined })],
    ["paused in-progress task", makeTask({ column: "in-progress", status: "queued", paused: true })],
    ["user-paused in-progress task", makeTask({ column: "in-progress", status: "queued", userPaused: true })],
    // Paused early-return must win over the ephemeral executionImpliesActiveAgent path:
    // a paused/unassigned in-progress task in an otherwise-active status stays idle.
    ["paused unassigned in-progress task in an active status", makeTask({ column: "in-progress", status: "planning", paused: true, assignedAgentId: undefined, checkedOutBy: undefined })],
    ["paused in-review task", makeTask({ column: "in-review", status: "reviewing", paused: true })],
    ["user-paused in-review task", makeTask({ column: "in-review", status: "reviewing", userPaused: true })],
  ])("keeps the composer sendable with idle guidance for %s", (_label, task) => {
    render(<TaskChatTab task={task} active addToast={vi.fn()} />);

    expectIdleSessionHint();
    expectComposerSendableAfterDraft();
  });

  it.each(["reviewing", "merging", "merging-fix", "fixing"])(
    "treats an actively-reviewing in-review task as an active session even without an assignment (ephemeral mode): %s status",
    (status) => {
      // A reviewer/merger runs ephemerally with no assignedAgentId/checkedOutBy,
      // so an in-review task in an active review/merge status must NOT show the
      // idle "no agent is working" hint.
      render(
        <TaskChatTab
          task={makeTask({ column: "in-review", status, assignedAgentId: undefined, checkedOutBy: undefined })}
          active
          addToast={vi.fn()}
          sessionLive={false}
        />,
      );

      expectActiveSessionCopy();
      expect(screen.getByLabelText("Message active agent session")).not.toBeDisabled();
    },
  );

  it("keeps a null-status in-review task (awaiting human review) idle without an assignment", () => {
    render(
      <TaskChatTab
        task={makeTask({ column: "in-review", status: undefined, assignedAgentId: undefined, checkedOutBy: undefined })}
        active
        addToast={vi.fn()}
        sessionLive={false}
      />,
    );

    expectIdleSessionHint();
  });

  it.each([
    ["paused in-progress task with a live session", makeTask({ column: "in-progress", status: "queued", paused: true })],
    ["user-paused in-progress task with a live session", makeTask({ column: "in-progress", status: "queued", userPaused: true })],
    ["paused in-review task with a live session", makeTask({ column: "in-review", status: "reviewing", paused: true })],
    ["user-paused in-review task with a live session", makeTask({ column: "in-review", status: "reviewing", userPaused: true })],
  ])("keeps the composer sendable with idle guidance for %s", (_label, task) => {
    render(<TaskChatTab task={task} active addToast={vi.fn()} sessionLive={true} />);

    expectIdleSessionHint();
    expectComposerSendableAfterDraft();
  });

  it.each(["paused", "awaiting-user-input", "awaiting-cli-approval", "awaiting-user-review", "awaiting-approval", "awaiting-integration", "failed", "needs-replan"])(
    "keeps active-column steering sendable with idle guidance for %s status",
    (status) => {
      render(<TaskChatTab task={makeTask({ column: "triage", assignedAgentId: "agent-1", status })} active addToast={vi.fn()} />);

      expectIdleSessionHint();
      expectComposerSendableAfterDraft();
    },
  );

  it("disables the composer only while a send is in flight", async () => {
    const user = userEvent.setup();
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask({ column: "todo", assignedAgentId: undefined, checkedOutBy: undefined })} active addToast={vi.fn()} sessionLive={false} />);

    const input = screen.getByLabelText("Message active agent session");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(input).not.toBeDisabled();
    expect(sendButton).toBeDisabled();

    await user.type(input, "Please queue this while idle");
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    const sendingButton = screen.getByRole("button", { name: "Sending" });
    expect(sendingButton).toBeDisabled();
    expect(sendingButton).toHaveTextContent("");
    expect(input).toBeDisabled();

    await act(async () => {
      send.resolve(makeTask({ steeringComments: [makeSteeringComment({ text: "Please queue this while idle" })] }));
      await send.promise;
    });

    expect(input).not.toBeDisabled();
    expect(input).toHaveValue("");
  });

  it("uses the same send lifecycle while creating a done-task refinement", async () => {
    const user = userEvent.setup();
    const send = deferred<Task>();
    mockedRefineTask.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask({ column: "done" })} active addToast={vi.fn()} sessionLive={false} />);

    const input = screen.getByLabelText("Message active agent session");
    const sendButton = screen.getByRole("button", { name: "Send" });
    expect(input).not.toBeDisabled();
    expect(sendButton).toBeDisabled();

    await user.type(input, "   ");
    expect(sendButton).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Create follow-up");
    expect(sendButton).not.toBeDisabled();
    await user.click(sendButton);

    const sendingButton = screen.getByRole("button", { name: "Sending" });
    expect(sendingButton).toBeDisabled();
    expect(sendingButton).toHaveTextContent("");
    expect(input).toBeDisabled();

    await act(async () => {
      send.resolve(makeTask({ id: "FN-444", column: "todo" }));
      await send.promise;
    });

    expect(input).not.toBeDisabled();
    expect(input).toHaveValue("");
  });

  it("rolls back optimistic messages and surfaces send failures through addToast", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const send = deferred<Task>();
    mockedAddSteeringComment.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask()} active addToast={addToast} />);

    await user.type(screen.getByLabelText("Message active agent session"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByTestId("task-chat-entry-user")).toBeVisible();
    expect(within(transcript).getByText("hello")).toBeVisible();

    await act(async () => {
      send.reject(new Error("network down"));
      try {
        await send.promise;
      } catch {
        // Expected rejection drives the component rollback path.
      }
    });

    await waitFor(() => {
      expect(screen.queryByTestId("task-chat-entry-user")).not.toBeInTheDocument();
      expect(addToast).toHaveBeenCalledWith("Unable to send message: network down", "error");
    });
  });

  it("rolls back done-task optimistic messages when refinement creation fails", async () => {
    const user = userEvent.setup();
    const addToast = vi.fn();
    const onTaskUpdated = vi.fn();
    const send = deferred<Task>();
    mockedRefineTask.mockReturnValue(send.promise);
    render(<TaskChatTab task={makeTask({ column: "done" })} active addToast={addToast} onTaskUpdated={onTaskUpdated} />);

    const input = screen.getByLabelText("Message active agent session");
    await user.type(input, "make a follow-up");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const transcript = screen.getByTestId("task-chat-transcript");
    expect(within(transcript).getByTestId("task-chat-entry-user")).toBeVisible();
    expect(within(transcript).getByText("make a follow-up")).toBeVisible();

    await act(async () => {
      send.reject(new Error("refine failed"));
      try {
        await send.promise;
      } catch {
        // Expected rejection drives the component rollback path.
      }
    });

    await waitFor(() => {
      expect(screen.queryByTestId("task-chat-entry-user")).not.toBeInTheDocument();
      expect(addToast).toHaveBeenCalledWith("Unable to send message: refine failed", "error");
    });
    expect(input).toHaveValue("make a follow-up");
    expect(onTaskUpdated).not.toHaveBeenCalled();
  });

  it("renders the same composer affordance shell on desktop and mobile breakpoints", () => {
    mockMatchMedia(false);
    const desktop = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByTestId("task-chat-tab")).toBeInTheDocument();
    expect(screen.getByTestId("task-chat-transcript")).toBeInTheDocument();
    expect(screen.getByLabelText("Message active agent session")).toHaveClass("task-chat-input");
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass("task-chat-send");
    desktop.unmount();

    mockMatchMedia(true);
    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByTestId("task-chat-tab")).toBeInTheDocument();
    expect(screen.getByTestId("task-chat-transcript")).toBeInTheDocument();
    expect(screen.getByLabelText("Message active agent session")).toHaveClass("task-chat-input");
    expect(screen.getByRole("button", { name: "Send" })).toHaveClass("task-chat-send");
  });

  it("FN-6347 pins the composer while the transcript flex-fills without fixed viewport caps", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const tabRule = getCssRuleBlock(css, ".task-chat-tab");
    const transcriptRule = getCssRuleBlock(css, ".task-chat-transcript");
    const composerRule = getCssRuleBlock(css, ".task-chat-composer");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileTranscriptRule = getCssRuleBlock(mobileCss, ".task-chat-transcript");

    expect(tabRule).toContain("display: flex");
    expect(tabRule).toContain("flex: 1");
    expect(tabRule).toContain("min-height: 0");
    expect(transcriptRule).toContain("flex: 1 1 auto");
    expect(transcriptRule).toContain("min-height: 0");
    expect(transcriptRule).toContain("overflow-y: auto");
    expect(transcriptRule).not.toContain("max-height");
    expect(composerRule).toContain("flex: 0 0 auto");
    expect(mobileTranscriptRule).toContain("flex: 1 1 auto");
    expect(mobileTranscriptRule).toContain("min-height: 0");
    expect(mobileTranscriptRule).not.toContain("max-height");
    expect(css).not.toContain("70vh");
    expect(css).not.toContain("62vh");
  });

  it("positions the icon-only expand toggle as a tokenized chat-view overlay with no toolbar shell", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const tabRule = getCssRuleBlock(css, ".task-chat-tab");
    const transcriptRule = getCssRuleBlock(css, ".task-chat-transcript");
    const toggleRule = getCssRuleBlock(css, ".task-chat-expand-toggle");
    const overlayRule = getCssRuleBlock(css, ".task-chat-expand-toggle--overlay");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileOverlayRule = getCssRuleBlock(mobileCss, ".task-chat-expand-toggle--overlay");

    expect(css).not.toContain(".task-chat-toolbar");
    expect(tabRule).toContain("position: relative");
    expect(transcriptRule).toContain("position: relative");
    expect(toggleRule).toContain("justify-content: center");
    expect(toggleRule).toContain("min-inline-size: var(--space-2xl)");
    expect(toggleRule).toContain("min-block-size: var(--space-2xl)");
    expect(toggleRule).not.toContain("gap");
    expect(overlayRule).toContain("position: absolute");
    expect(overlayRule).toContain("top: var(--space-md)");
    expect(overlayRule).toContain("right: var(--space-md)");
    expect(overlayRule).toContain("background: var(--surface)");
    expect(overlayRule).toContain("border-color: var(--border)");
    expect(overlayRule).toContain("box-shadow: var(--shadow-sm)");
    expect(mobileOverlayRule).toContain("top: var(--space-sm)");
    expect(mobileOverlayRule).toContain("right: var(--space-sm)");
    expect(mobileOverlayRule).toContain("min-inline-size");
    expect(mobileOverlayRule).toContain("min-block-size");
  });

  it("keeps tokenized sticky styling for the jump-to-bottom control on desktop and mobile", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const jumpRule = getCssRuleBlock(css, ".task-chat-jump-to-bottom");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileJumpRule = getCssRuleBlock(mobileCss, ".task-chat-jump-to-bottom");

    expect(jumpRule).toContain("position: sticky");
    expect(jumpRule).toContain("bottom: var(--space-md)");
    expect(jumpRule).toContain("right: var(--space-md)");
    expect(jumpRule).toContain("background: var(--surface)");
    expect(jumpRule).toContain("border: var(--btn-border-width) solid var(--border)");
    expect(jumpRule).toContain("box-shadow: var(--shadow-md)");
    expect(jumpRule).toContain("border-radius: var(--radius-md)");
    expect(mobileJumpRule).toContain("bottom: var(--space-sm)");
    expect(mobileJumpRule).toContain("right: var(--space-sm)");
    expect(mobileJumpRule).toContain("min-inline-size");
    expect(mobileJumpRule).toContain("min-block-size");
  });

  it("keeps tokenized mobile touch targets for the load-previous affordance", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const rowRule = getCssRuleBlock(css, ".task-chat-load-previous-row");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileRowRule = getCssRuleBlock(mobileCss, ".task-chat-load-previous-row");
    const mobileButtonRule = getCssRuleBlock(mobileCss, ".task-chat-load-previous,");

    expect(rowRule).toContain("justify-content: center");
    expect(rowRule).toContain("min-block-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(css).toContain("gap: var(--space-xs)");
    expect(css).toContain("color: var(--text-muted)");
    expect(rowRule).not.toContain("px");
    expect(css).not.toContain("#");
    expect(mobileRowRule).toContain("min-block-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(mobileButtonRule).toContain("min-block-size: calc(var(--space-2xl) + var(--space-sm))");
  });

  it("scales the task chat send glyph without shrinking the desktop or mobile touch target", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const sharedStyles = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
    const sendRule = getCssRuleBlock(css, ".task-chat-send");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileSendRule = getCssRuleBlock(mobileCss, ".task-chat-send");
    const mobileInputRule = getCssRuleBlock(mobileCss, ".task-chat-input");
    const tokenValues = getRootTokenPxValues(sharedStyles);
    const defaultIconSizePx = tokenValues["--icon-size-md"];
    const desktopIconSizePx = resolveCssPxToken(getCssDeclaration(sendRule, "--btn-icon-size"), tokenValues);
    const mobileIconSizePx = resolveCssCalcSumPx(getCssDeclaration(mobileSendRule, "--btn-icon-size"), tokenValues);
    const desktopBoxSizePx = resolveCssCalcSumPx(getCssDeclaration(sendRule, "inline-size"), tokenValues);
    const mobileBoxSizePx = resolveCssCalcSumPx(getCssDeclaration(mobileSendRule, "inline-size"), tokenValues);
    const mobileInputMinHeightPx = resolveCssCalcSumPx(getCssDeclaration(mobileInputRule, "min-height"), tokenValues);

    expect(defaultIconSizePx).toBe(16);
    expect(desktopIconSizePx).toBeGreaterThan(defaultIconSizePx);
    expect(mobileIconSizePx).toBeGreaterThan(defaultIconSizePx);
    expect(mobileBoxSizePx).toBeGreaterThan(desktopBoxSizePx);
    expect(mobileIconSizePx).toBeGreaterThan(desktopIconSizePx);
    expect(desktopIconSizePx / desktopBoxSizePx).toBeGreaterThanOrEqual(0.75);
    expect(mobileIconSizePx / mobileBoxSizePx).toBeGreaterThanOrEqual(0.8);
    expect(mobileInputMinHeightPx).toBe(mobileBoxSizePx);
    expect(sendRule).toContain("inline-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(sendRule).toContain("min-inline-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(sendRule).toContain("block-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(sendRule).toContain("min-block-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(mobileSendRule).toContain("inline-size: calc(var(--space-2xl) + var(--space-lg))");
    expect(mobileSendRule).toContain("min-inline-size: calc(var(--space-2xl) + var(--space-lg))");
    expect(mobileSendRule).toContain("block-size: calc(var(--space-2xl) + var(--space-lg))");
    expect(mobileSendRule).toContain("min-block-size: calc(var(--space-2xl) + var(--space-lg))");
    expect(mobileInputRule).toContain("min-height: calc(var(--space-2xl) + var(--space-lg))");
  });

  it("keeps TaskDetailModal inline and expanded chat on the canonical TaskChatTab renderer", () => {
    const source = readFileSync(resolve(__dirname, "../TaskDetailModal.tsx"), "utf8");
    const taskChatMounts = source.match(/<TaskChatTab\b/g) ?? [];

    expect(source).toContain('import { TaskChatTab } from "./TaskChatTab"');
    expect(taskChatMounts).toHaveLength(1);
    expect(source).toContain("const isChatExpanded = chatExpanded && activeTab === \"chat\" && !isEditing");
    expect(source).toContain("task-detail-content--chat-expanded");
    expect(source).toContain("expanded={chatExpanded}");
  });

  it("keeps task chat timestamp styling tokenized and mobile-safe", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const groupMetaRule = getCssRuleBlock(css, ".task-chat-group-meta");
    const userHeaderRule = getCssRuleBlock(css, ".task-chat-user-header");
    const timestampRule = getCssRuleBlock(css, ".task-chat-timestamp");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileUserHeaderRule = getCssRuleBlock(mobileCss, ".task-chat-user-header");
    const mobileTimestampRule = getCssRuleBlock(mobileCss, ".task-chat-timestamp");

    expect(groupMetaRule).toContain("display: inline-flex");
    expect(groupMetaRule).toContain("flex-wrap: wrap");
    expect(groupMetaRule).toContain("gap: var(--space-xs)");
    expect(timestampRule).toContain("color: var(--text-muted)");
    expect(timestampRule).toContain("font-size: calc(var(--space-md) - (var(--space-xs) / 2))");
    expect(timestampRule).not.toContain("px");
    expect(timestampRule).not.toContain("#");
    expect(userHeaderRule).toContain("display: inline-flex");
    expect(userHeaderRule).toContain("flex-wrap: wrap");
    expect(mobileUserHeaderRule).toContain("justify-content: flex-end");
    expect(mobileTimestampRule).toContain("white-space: normal");
  });

  it("keeps mobile breakpoint scaffolding for the transcript, composer, and collapsible groups", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    const sendRule = getCssRuleBlock(css, ".task-chat-send");
    const mobileCss = getCssAfter(css, "@media (max-width: 768px)");
    const mobileComposerRule = getCssRuleBlock(mobileCss, ".task-chat-composer-row");
    const mobileSendRule = getCssRuleBlock(mobileCss, ".task-chat-send");

    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".task-chat-transcript");
    expect(css).toContain(".task-chat-jump-to-bottom");
    expect(css).toContain(".task-chat-composer-row");
    expect(sendRule).toContain("--btn-icon-size: var(--space-2xl)");
    expect(sendRule).toContain("inline-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(sendRule).toContain("block-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(sendRule).not.toContain("gap");
    expect(mobileComposerRule).toContain("align-items: flex-end");
    expect(mobileComposerRule).not.toContain("flex-direction: column");
    expect(mobileComposerRule).not.toContain("align-items: stretch");
    expect(mobileSendRule).toContain("--btn-icon-size: calc(var(--space-2xl) + var(--space-sm))");
    expect(mobileSendRule).toContain("inline-size: calc(var(--space-2xl) + var(--space-lg))");
    expect(css).toContain(".task-chat-tool-group-summary");
    expect(css).toContain(".task-chat-tool-group-names");
    expect(css).toContain(".task-chat-tool-group-error-count");
    expect(css).toContain(".task-chat-thinking-summary");
    expect(css).not.toContain(".task-chat-thinking-markdown + .task-chat-thinking-markdown");
    expect(css).toContain(".task-chat-user-group");
    expect(css).toContain(".task-chat-entry--user");
  });
});
