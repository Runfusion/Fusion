/*
FNXC:DashboardTests 2026-07-12-17:50:
ChatView provider-response copy regressions must recreate secure Clipboard API and non-secure-origin fallback paths so the shared copyTextToClipboard invariant stays covered at the real affordance.
*/
import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { renderWithAct, setupMockChat, installChatViewEnv } from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    Copy: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-copy"} {...props} />,
    Check: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-check"} {...props} />,
  };
});

vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  updateGlobalSettings: vi.fn().mockResolvedValue({}),
}));

installChatViewEnv();

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;
const copiedContent = "Copyable provider response";

function setupProviderResponse() {
  setupMockChat({
    sessions: [
      {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Provider chat",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
    ],
    filteredSessions: [
      {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Provider chat",
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
    ],
    activeSession: {
      id: "session-001",
      agentId: "__fn_agent__",
      status: "active",
      title: "Provider chat",
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    },
    messages: [
      {
        id: "msg-copy",
        sessionId: "session-001",
        role: "assistant",
        content: copiedContent,
        createdAt: "2026-07-12T00:01:00.000Z",
      },
    ],
  });
}

function mockClipboard(value: Clipboard | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

function mockExecCommand(result: boolean) {
  const execCommand = vi.fn().mockReturnValue(result);
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: execCommand,
  });
  return execCommand;
}

async function renderAndClickCopy() {
  setupProviderResponse();
  await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
  const copyButton = await screen.findByTestId("chat-copy-response-msg-copy");
  await userEvent.click(copyButton);
  return copyButton;
}

afterEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: originalExecCommand,
  });
});

describe("ChatView copy response", () => {
  it("uses Clipboard API and shows success feedback in secure contexts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    mockClipboard({ writeText } as unknown as Clipboard);

    const copyButton = await renderAndClickCopy();

    await waitFor(() => expect(copyButton).toHaveClass("chat-message-copy-action--success"));
    expect(copyButton).toHaveAttribute("aria-label", "Response copied");
    expect(writeText).toHaveBeenCalledWith(copiedContent);
  });

  it("uses execCommand fallback and shows success when navigator.clipboard is undefined", async () => {
    mockClipboard(undefined);
    const execCommand = mockExecCommand(true);

    const click = renderAndClickCopy();
    await expect(click).resolves.toBeInstanceOf(HTMLButtonElement);
    const copyButton = await click;

    await waitFor(() => expect(copyButton).toHaveClass("chat-message-copy-action--success"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copyButton).toHaveAttribute("aria-label", "Response copied");
    expect(copyButton).not.toHaveClass("chat-message-copy-action--error");
  });

  it("shows error feedback without throwing when Clipboard API and fallback fail", async () => {
    mockClipboard(undefined);
    const execCommand = mockExecCommand(false);

    const click = renderAndClickCopy();
    await expect(click).resolves.toBeInstanceOf(HTMLButtonElement);
    const copyButton = await click;

    await waitFor(() => expect(copyButton).toHaveClass("chat-message-copy-action--error"));
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copyButton).toHaveAttribute("aria-label", "Copy failed");
    expect(copyButton).not.toHaveClass("chat-message-copy-action--success");
  });
});
