/*
FNXC:DashboardTests 2026-07-08-00:00:
Sibling ChatView test file (kept separate from ChatView.core-interactions.test.tsx per the
suite's split convention) covering the generalized "/" command registry: the /steer entry
appears in the chat-skill-menu alongside skills, dispatch-on-submit calls addSteeringComment
instead of a normal chat send, and the no-running-agent guard shows a hint instead of silently
falling back to plain chat. vi.mock("../../api", ...) stays inline here (not in the shared
harness) per the harness's TDZ note.
*/
import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import {
  renderWithAct,
  setupMockChat,
  activeSessionFixture,
  createMockSkill,
  mockFetchDiscoveredSkills,
  installChatViewEnv,
} from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({
    models: [],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  addSteeringComment: vi.fn(),
}));

import { addSteeringComment } from "../../api";

const mockAddSteeringComment = vi.mocked(addSteeringComment);

installChatViewEnv();

const commandContext = { taskId: "TASK-1", projectId: "proj-123", agentRunning: true };

describe("ChatView slash-command dispatch (/steer)", () => {
  it("does not show the command menu entry when no chatCommandContext is provided", async () => {
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/");

    expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();
    expect(screen.queryByText("/steer")).not.toBeInTheDocument();
  });

  it("shows the /steer command in the menu alongside skills when a task context is bound", async () => {
    mockFetchDiscoveredSkills.mockResolvedValueOnce([
      createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
    ]);
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/");

    expect(await screen.findByText("/steer")).toBeInTheDocument();
    expect(screen.getByText("review/pr")).toBeInTheDocument();
  });

  it("filters to just /steer when typing '/ste'", async () => {
    mockFetchDiscoveredSkills.mockResolvedValueOnce([
      createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
    ]);
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/ste");

    expect(await screen.findByText("/steer")).toBeInTheDocument();
    expect(screen.queryByText("review/pr")).not.toBeInTheDocument();
  });

  it("selecting /steer from the menu inserts the trigger as text, not a /skill: token", async () => {
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/");
    await userEvent.click(await screen.findByRole("option", { name: /steer/i }));

    expect(textarea).toHaveValue("/steer ");
    expect(textarea).not.toHaveValue(expect.stringContaining("/skill:"));
    expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
  });

  it("selecting a skill still inserts its /skill: token unchanged when commands are also present", async () => {
    mockFetchDiscoveredSkills.mockResolvedValueOnce([
      createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
    ]);
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/re");
    await userEvent.click(await screen.findByRole("option", { name: /review\/pr/i }));

    expect(textarea).toHaveValue("/skill:review/pr ");
  });

  it("submitting '/steer do X' dispatches addSteeringComment and does not send a normal message", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    mockAddSteeringComment.mockResolvedValueOnce({ id: "TASK-1" } as any);
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={addToast} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    fireEvent.change(textarea, { target: { value: "/steer do X" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockAddSteeringComment).toHaveBeenCalledWith("TASK-1", "do X", "proj-123"));
    expect(sendMessage).not.toHaveBeenCalled();
    await waitFor(() => expect(textarea).toHaveValue(""));
  });

  it("submitting a normal message still sends normally when a command context is bound", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={addToast} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    fireEvent.change(textarea, { target: { value: "hello there" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("hello there", []));
    expect(mockAddSteeringComment).not.toHaveBeenCalled();
  });

  it("does not dispatch when the trigger appears mid-message", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={addToast} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    fireEvent.change(textarea, { target: { value: "please /steer this" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("please /steer this", []));
    expect(mockAddSteeringComment).not.toHaveBeenCalled();
  });

  it("submitting '/steer ...' with no running agent shows a hint and does not dispatch or send", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView
        projectId="proj-123"
        addToast={addToast}
        chatCommandContext={{ ...commandContext, agentRunning: false }}
      />,
    );

    const textarea = screen.getByTestId("chat-input");
    fireEvent.change(textarea, { target: { value: "/steer do X" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.stringContaining("No running agent"), "warning"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mockAddSteeringComment).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("/steer do X");
  });

  it("shows a disabled hint in the menu when no running agent is bound", async () => {
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderWithAct(
      <ChatView
        projectId="proj-123"
        addToast={vi.fn()}
        chatCommandContext={{ ...commandContext, agentRunning: false }}
      />,
    );

    const textarea = screen.getByTestId("chat-input");
    await userEvent.type(textarea, "/");

    const steerOption = await screen.findByRole("option", { name: /steer/i });
    expect(steerOption).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/no running agent/i)).toBeInTheDocument();
  });

  // FUX-015 composer-wipe race: the composer is cleared on submit — BEFORE the
  // network round-trip — so text the user types while the command is in flight
  // is never wiped by a late callback. This matches normal chat send (which also
  // clears immediately and does not restore on failure), so the composer stays
  // empty after run() rejects; the error is surfaced via a toast.
  it("clears the composer on submit and shows an error toast when run() fails", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    mockAddSteeringComment.mockRejectedValueOnce(new Error("network down"));
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={addToast} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    fireEvent.change(textarea, { target: { value: "/steer do X" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(addToast).toHaveBeenCalledWith("network down", "error"));
    expect(textarea).toHaveValue("");
  });

  // FUX-015 composer-wipe race: text typed AFTER submit (while the command is
  // in flight) must survive the success callback — success no longer clears.
  it("preserves text typed while the command is in flight (no late wipe on success)", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    let resolveRun: () => void = () => {};
    const runPromise = new Promise<void>((resolve) => { resolveRun = resolve; });
    mockAddSteeringComment.mockReturnValueOnce(runPromise as unknown as ReturnType<typeof addSteeringComment>);
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={addToast} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    fireEvent.change(textarea, { target: { value: "/steer do X" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Composer cleared immediately on submit, before the command resolves.
    await waitFor(() => expect(textarea).toHaveValue(""));
    // User starts typing a new message while the command is still in flight.
    fireEvent.change(textarea, { target: { value: "next message" } });

    resolveRun();
    await waitFor(() => expect(addToast).toHaveBeenCalledWith(expect.any(String), "success"));
    // The in-flight text must not be wiped by the success callback.
    expect(textarea).toHaveValue("next message");
  });

  it("blocks command dispatch and warns when attachments are staged", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    const addToast = vi.fn();

    await renderWithAct(
      <ChatView projectId="proj-123" addToast={addToast} chatCommandContext={commandContext} />,
    );

    const textarea = screen.getByTestId("chat-input");
    const file = new File(["hi"], "note.txt", { type: "text/plain" });
    const fileInput = screen.getByTestId("chat-file-input");
    await userEvent.upload(fileInput, file);

    fireEvent.change(textarea, { target: { value: "/steer do X" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() =>
      expect(addToast).toHaveBeenCalledWith(expect.stringMatching(/attachment/i), "warning"),
    );
    expect(mockAddSteeringComment).not.toHaveBeenCalled();
    // Command was blocked, not sent — the composed text is preserved for the user to fix.
    expect(textarea).toHaveValue("/steer do X");
  });
});
