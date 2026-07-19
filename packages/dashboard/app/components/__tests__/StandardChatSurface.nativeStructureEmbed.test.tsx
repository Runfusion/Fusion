import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeStructurePreviewResult } from "@fusion/core";
import type { ChatMessageInfo } from "../../hooks/chatTypes";
import { attachChatStream, ensureTaskPlannerChatSession, fetchChatMessages, fetchChatSession, fetchNativeStructurePreview, fetchTaskPlannerChatSession } from "../../api";
import { StandardChatMessageItem, StandardStreamingMessage } from "../StandardChatSurface";
import { ChatView } from "../ChatView";
import { TaskPlannerChatTab } from "../TaskPlannerChatTab";
import { activeSessionFixture, installChatViewEnv, renderWithAct, setupMockChat, setupMockRooms } from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }) };
});

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return { ...actual, useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }) };
});
vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchNativeStructurePreview: vi.fn(),
    fetchSettings: vi.fn().mockResolvedValue({}),
    fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: null, defaultModelId: null }),
    fetchAgents: vi.fn().mockResolvedValue([]),
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
    ensureTaskPlannerChatSession: vi.fn(),
    fetchTaskPlannerChatSession: vi.fn(),
    fetchChatSession: vi.fn(),
    fetchChatMessages: vi.fn(),
    attachChatStream: vi.fn(),
  };
});

installChatViewEnv();

const fetchPreview = vi.mocked(fetchNativeStructurePreview);
const ensurePlannerSession = vi.mocked(ensureTaskPlannerChatSession);
const fetchPlannerSession = vi.mocked(fetchTaskPlannerChatSession);
const fetchSession = vi.mocked(fetchChatSession);
const fetchMessages = vi.mocked(fetchChatMessages);
const attachStream = vi.mocked(attachChatStream);
const available: NativeStructurePreviewResult = {
  available: true,
  kind: "mission",
  kindLabel: "Mission",
  title: "Inline mission",
  excerpt: "A preview rendered in chat.",
  openTarget: { view: "missions", id: "M-001" },
};

function message(overrides: Partial<ChatMessageInfo>): ChatMessageInfo {
  return {
    id: "message-1",
    sessionId: "session-1",
    role: "assistant",
    content: "",
    createdAt: "2026-07-19T00:00:00.000Z",
    ...overrides,
  };
}

function renderMessage(overrides: Partial<ChatMessageInfo>, forcePlain = false) {
  return render(
    <StandardChatMessageItem
      message={message(overrides)}
      forcePlain={forcePlain}
      agentName="Assistant"
      hideAssistantIdentity={false}
      showAssistantModelTag={false}
      activeModelTag={null}
      activeModelProvider={null}
      activeSessionId="session-1"
    />,
  );
}

async function expectPreview() {
  await waitFor(() => expect(screen.getByTestId("native-structure-preview")).toHaveAttribute("data-kind", "mission"));
}

describe("StandardChatSurface native structure embeds", () => {
  afterEach(() => {
    cleanup();
    fetchPreview.mockReset();
    ensurePlannerSession.mockReset();
    fetchPlannerSession.mockReset();
    fetchSession.mockReset();
    fetchMessages.mockReset();
    attachStream.mockReset();
  });

  it.each([
    ["settled Markdown link", "[Mission](fusion://mission/M-001)"],
    ["settled bare assistant token", "Open fusion://mission/M-001 now."],
  ])("renders a preview for %s", async (_name, content) => {
    fetchPreview.mockResolvedValue(available);
    renderMessage({ content });
    await expectPreview();
    expect(screen.queryByText("fusion://mission/M-001")).not.toBeInTheDocument();
  });

  it.each([
    ["Markdown link", "[Mission](fusion://mission/M-001)"],
    ["bare token", "fusion://mission/M-001"],
  ])("renders a preview while streaming a %s", async (_name, streamingText) => {
    fetchPreview.mockResolvedValue(available);
    render(
      <StandardStreamingMessage
        streamingText={streamingText}
        forcePlain={false}
        agentName="Assistant"
        hideAssistantIdentity={false}
        showAssistantModelTag={false}
        activeModelTag={null}
        activeModelProvider={null}
      />,
    );
    await expectPreview();
  });

  it("renders a user bare token through the raw message tokenizer", async () => {
    fetchPreview.mockResolvedValue(available);
    renderMessage({ role: "user", content: "Please open fusion://mission/M-001." });
    await expectPreview();
    expect(screen.getByTestId("chat-message-message-1").textContent).toContain("Open.");
  });

  it("lifts a paragraph preview outside phrasing-only content", async () => {
    fetchPreview.mockResolvedValue(available);
    renderMessage({ content: "Before fusion://mission/M-001 after" });
    await expectPreview();
    expect(screen.getByTestId("native-structure-preview").closest("p, h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(screen.getByText("Before").closest("p")).not.toBeNull();
    expect(screen.getByText("after").closest("p")).not.toBeNull();
  });

  it("lifts a heading preview into a sibling block without an empty heading", async () => {
    fetchPreview.mockResolvedValue(available);
    renderMessage({ content: "## fusion://mission/M-001" });
    await expectPreview();
    expect(screen.getByTestId("native-structure-preview").closest("h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(document.querySelector("h2")).toBeNull();
  });

  it.each([
    ["formatted list", "- **fusion://mission/M-001**", "li"],
    ["formatted table cell", "| Structure |\n| --- |\n| **fusion://mission/M-001** |", "td, th, table"],
  ])("lifts a preview from a %s instead of nesting its block root", async (_surface, content, forbiddenAncestor) => {
    fetchPreview.mockResolvedValue(available);
    renderMessage({ content });
    await expectPreview();
    expect(screen.getByTestId("native-structure-preview").closest(forbiddenAncestor)).toBeNull();
  });

  it.each([
    ["bare token", "**Before fusion://mission/M-001 after**"],
    ["Markdown link", "**Before [Mission](fusion://mission/M-001) after**"],
  ])("lifts a formatted %s outside its phrasing wrapper", async (_form, content) => {
    fetchPreview.mockResolvedValue(available);
    renderMessage({ content });
    await expectPreview();
    expect(screen.getByTestId("native-structure-preview").closest("strong, em, p, h1, h2, h3, h4, h5, h6")).toBeNull();
    expect(screen.getByText("Before").closest("strong")).not.toBeNull();
    expect(screen.getByText("after").closest("strong")).not.toBeNull();
  });

  it("uses the shared unavailable placeholder without crashing", async () => {
    fetchPreview.mockResolvedValue({ available: false, kind: "mission", id: "M-404", reason: "soft-deleted" });
    renderMessage({ content: "fusion://mission/M-404" });
    await waitFor(() => expect(screen.getByTestId("native-structure-preview-unavailable")).toHaveAttribute("data-reason", "soft-deleted"));
  });

  it("routes roadmap references to the shared unavailable placeholder", async () => {
    renderMessage({ content: "fusion://roadmap-item/R-001" });
    await waitFor(() => expect(screen.getByTestId("native-structure-preview-unavailable")).toHaveAttribute("data-reason", "missing"));
  });

  it("preserves malformed references as text and blocks unsafe Markdown URLs", () => {
    renderMessage({ content: "fusion://mission/M-001?query [unsafe](javascript:alert(1))" });
    expect(screen.queryByTestId("native-structure-preview")).not.toBeInTheDocument();
    expect(screen.getByText("fusion://mission/M-001?query")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("does not transform native-looking Markdown link labels or inline code", () => {
    renderMessage({ content: "[fusion://mission/M-001](https://example.com) and `fusion://mission/M-002`" });
    expect(screen.queryByTestId("native-structure-preview")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "fusion://mission/M-001" })).toHaveAttribute("href", "https://example.com");
    expect(screen.getByText("fusion://mission/M-002").tagName).toBe("CODE");
  });

  it.each(["[Mission](fusion://mission/M-001)", "fusion://mission/M-001"])("keeps %s raw in forcePlain mode", (content) => {
    renderMessage({ content }, true);
    expect(screen.queryByTestId("native-structure-preview")).not.toBeInTheDocument();
    expect(screen.getByText(content)).toBeInTheDocument();
  });

  function setupPlannerMessages(messages: Array<Record<string, unknown>>, sessionOverrides: Record<string, unknown> = {}) {
    const session = { id: "planner-session", agentId: "task-planner:FN-1", title: null, status: "active", projectId: "project-1", modelProvider: "anthropic", modelId: "claude", createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z", cliSessionFile: null, cliExecutorAdapterId: null, inFlightGeneration: null, ...sessionOverrides };
    fetchPlannerSession.mockResolvedValue({ session });
    ensurePlannerSession.mockResolvedValue({ session });
    fetchSession.mockResolvedValue({ session });
    fetchMessages.mockResolvedValue({ messages: messages as never });
    return session;
  }

  function renderPlannerChat() {
    return render(<TaskPlannerChatTab task={{ id: "FN-1", description: "Task", column: "todo", dependencies: [], steps: [], currentStep: 0, createdAt: "2026-07-19T00:00:00.000Z", updatedAt: "2026-07-19T00:00:00.000Z" } as never} active planningModel={{ provider: "anthropic", modelId: "claude" }} projectId="project-1" addToast={vi.fn()} />);
  }

  it.each([
    ["settled assistant", { id: "planner-message", role: "assistant", content: "fusion://mission/M-001" }],
    ["settled user", { id: "planner-user-message", role: "user", content: "fusion://mission/M-001" }],
  ])("renders the shared preview in task-bound %s chat", async (_surface, plannerMessage) => {
    fetchPreview.mockResolvedValue(available);
    setupPlannerMessages([{ ...plannerMessage, sessionId: "planner-session", createdAt: "2026-07-19T00:00:00.000Z", thinkingOutput: null, metadata: null }]);
    renderPlannerChat();
    await expectPreview();
  });

  it("renders a reattached task-bound streaming preview from the in-flight session snapshot", async () => {
    fetchPreview.mockResolvedValue(available);
    attachStream.mockReturnValue({ close: vi.fn(), isConnected: () => true } as never);
    setupPlannerMessages([], {
      isGenerating: true,
      inFlightGeneration: { status: "generating", streamingText: "**fusion://mission/M-001**", streamingThinking: "", toolCalls: [] },
    });
    renderPlannerChat();
    await expectPreview();
    expect(document.querySelector(".chat-message--streaming")).toBeInTheDocument();
    expect(screen.getByTestId("native-structure-preview").closest("strong")).toBeNull();
  });

  it.each([
    ["desktop assistant room", {}, "assistant"],
    ["floating narrow assistant room", { floating: true, compactLayout: true }, "assistant"],
    ["desktop user room", {}, "user"],
  ])("renders the shared preview in ChatView %s", async (_surface, layout, role) => {
    fetchPreview.mockResolvedValue(available);
    setupMockRooms();
    setupMockChat({
      sessions: [activeSessionFixture],
      filteredSessions: [activeSessionFixture],
      activeSession: activeSessionFixture,
      messages: [{ id: "room-message", sessionId: activeSessionFixture.id, role, content: "fusion://mission/M-001", createdAt: "2026-07-19T00:00:00.000Z" } as never],
    });
    await renderWithAct(<ChatView projectId="project-1" addToast={vi.fn()} {...layout} />);
    await expectPreview();
  });
});
