import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentLogEntry, Task } from "@fusion/core";
import { TaskChatTab } from "../TaskChatTab";
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

describe("TaskChatTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogs();
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

  it("renders thinking and tool entries legibly", () => {
    mockLogs([
      makeEntry({ agent: "triage", type: "thinking", text: "I am considering options" }),
      makeEntry({ agent: "executor", type: "tool", text: "bash", detail: "pnpm test" }),
      makeEntry({ agent: "executor", type: "tool_result", text: "done", detail: "ok" }),
      makeEntry({ agent: "executor", type: "tool_error", text: "failed", detail: "stderr" }),
    ]);

    render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);

    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("Tool call")).toBeTruthy();
    expect(screen.getByText("Tool result")).toBeTruthy();
    expect(screen.getByText("Tool error")).toBeTruthy();
    expect(screen.getByText("stderr")).toBeTruthy();
  });

  it("appends newly streamed entries from the hook", () => {
    const firstEntries = [makeEntry({ agent: "executor", text: "first live chunk" })];
    const secondEntries = [...firstEntries, makeEntry({ agent: "executor", text: "second live chunk", timestamp: "2026-06-12T00:00:01.000Z" })];
    mockedUseAgentLogs.mockReturnValueOnce({ entries: firstEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 1, loadingMore: false });
    mockedUseAgentLogs.mockReturnValueOnce({ entries: secondEntries, loading: false, clear: vi.fn(), loadMore: vi.fn(), hasMore: false, total: 2, loadingMore: false });

    const { rerender } = render(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByText("first live chunk")).toBeTruthy();

    rerender(<TaskChatTab task={makeTask()} active addToast={vi.fn()} />);
    expect(screen.getByText("second live chunk")).toBeTruthy();
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

    expect(screen.queryByText(/No active assigned agent session/)).not.toBeInTheDocument();
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

  it.each([undefined, null, "queued", "planning", "merging", "merging-fix"])(
    "enables in-progress steering for assigned agents with %s status",
    (status) => {
      render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1", status })} active addToast={vi.fn()} />);

      expect(screen.queryByText(/No active assigned agent session/)).not.toBeInTheDocument();
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

    expect(screen.getByText(/No active assigned agent session/)).toBeTruthy();
    expect(screen.getByText(/active, assigned, non-paused agent session is required/i)).toBeTruthy();
    expect(screen.getByLabelText("Message active agent session")).toBeDisabled();
    expect(screen.getByPlaceholderText("Active non-paused agent session required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it.each(["paused", "awaiting-user-input", "awaiting-cli-approval", "awaiting-user-review", "failed", "needs-replan"])(
    "disables in-progress steering for non-steerable %s status",
    (status) => {
      render(<TaskChatTab task={makeTask({ column: "in-progress", assignedAgentId: "agent-1", status })} active addToast={vi.fn()} />);

      expect(screen.getByText(/No active assigned agent session/)).toBeTruthy();
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

  it("keeps mobile breakpoint scaffolding for the transcript and composer", () => {
    const css = readFileSync(resolve(__dirname, "../TaskChatTab.css"), "utf8");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".task-chat-transcript");
    expect(css).toContain(".task-chat-composer-row");
  });
});
