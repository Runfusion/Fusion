import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { __test_resetChatSnippetsCache } from "../../hooks/useChatSnippetsCache";
import {
  activeSessionFixture,
  createMockSkill,
  installChatViewEnv,
  mockFetchDiscoveredSkills,
  renderChatDetailWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

const apiMocks = vi.hoisted(() => ({
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  addSteeringComment: vi.fn(),
}));

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchGlobalSettings: apiMocks.fetchGlobalSettings,
  updateGlobalSettings: apiMocks.updateGlobalSettings,
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  addSteeringComment: apiMocks.addSteeringComment,
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

const prompt = "lance toujours les tests avec chrome devtool mcp";
const commandContext = { taskId: "TASK-1", projectId: "proj-123", agentRunning: true };

beforeEach(() => {
  __test_resetChatSnippetsCache();
  apiMocks.fetchGlobalSettings.mockResolvedValue({ chatSnippets: [{ name: "test", prompt }] });
  apiMocks.updateGlobalSettings.mockResolvedValue({ chatSnippets: [{ name: "test", prompt }] });
});

describe("ChatView chat snippets", () => {
  it("orders commands, snippets, and skills and inserts a selected snippet as editable text", async () => {
    mockFetchDiscoveredSkills.mockResolvedValueOnce([
      createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
    ]);
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderChatDetailWithAct(
      <ChatView projectId="proj-123" addToast={vi.fn()} chatCommandContext={commandContext} />,
    );

    const input = screen.getByTestId("chat-input");
    await userEvent.type(input, "/");
    const slashMenu = await screen.findByRole("listbox", { name: /slash suggestions/i });
    const options = within(slashMenu).getAllByRole("option");
    expect(options.map((option) => option.querySelector(".chat-skill-menu-item-name")?.textContent)).toEqual([
      "/steer",
      "/test",
      "review/pr",
    ]);

    await userEvent.click(screen.getByRole("option", { name: /\/test/i }));
    expect(input).toHaveValue(prompt);
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: `${prompt}\neditable` } });
    expect(input).toHaveValue(`${prompt}\neditable`);
  });

  it("expands the first submit without sending or losing attachments, then sends normally", async () => {
    const sendMessage = vi.fn();
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const input = screen.getByTestId("chat-input");
    const file = new File(["notes"], "notes.txt", { type: "text/plain" });
    await userEvent.upload(screen.getByTestId("chat-file-input"), file);
    fireEvent.change(input, { target: { value: "/test" } });
    await waitFor(() => expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("/test"));
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input).toHaveValue(prompt));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(apiMocks.addSteeringComment).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-attachment-preview-0")).toBeInTheDocument();
    expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBeNull();
    expect(Object.values(localStorage)).not.toContain(prompt);

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(
      prompt,
      [file],
      expect.objectContaining({ onAccepted: expect.any(Function), onDelivered: expect.any(Function) }),
    ));
  });

  it("keeps normally typed drafts persisted", async () => {
    setupMockChat({ activeSession: activeSessionFixture, messages: [] });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const input = screen.getByTestId("chat-input");

    fireEvent.change(input, { target: { value: "ordinary draft" } });
    await waitFor(() => {
      expect(localStorage.getItem("fusion:chat-draft:direct:session-001")).toBe("ordinary draft");
    });
  });

  it.each(["/steer", "/focus", "/skill", "/unknown", "text /test", "/test suffix"])(
    "does not expand non-standalone or reserved syntax %s",
    async (value) => {
      const sendMessage = vi.fn();
      setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
      await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      const input = screen.getByTestId("chat-input");
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(input).not.toHaveValue(prompt));
      expect(sendMessage.mock.calls[0]?.[0]).not.toBe(prompt);
    },
  );

  it.each(["/clear", "/new"])("preserves the native clearing behavior for %s", async (value) => {
    const sendMessage = vi.fn();
    const createSession = vi.fn().mockResolvedValue(activeSessionFixture);
    setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage, createSession });
    await renderChatDetailWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
    const input = screen.getByTestId("chat-input");
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue("");
  });
});
