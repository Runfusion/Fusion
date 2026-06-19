import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuickChatFAB, clampQuickChatInputHeight } from "../QuickChatFAB";

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue([]),
    searchFiles: vi.fn().mockResolvedValue({ files: [] }),
    fetchModels: vi.fn().mockResolvedValue({
      models: [],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: "",
      defaultModelId: "",
    }),
  };
});

vi.mock("../../hooks/useQuickChat", () => ({
  FN_AGENT_ID: "__fn_agent__",
  useQuickChat: vi.fn(() => ({
    activeSession: { id: "session-1", agentId: "agent-1", modelProvider: null, modelId: null },
    messages: [],
    isStreaming: false,
    streamingText: "",
    streamingThinking: null,
    streamingToolCalls: [],
    sessions: [],
    sessionsLoading: false,
    messagesLoading: false,
    sendMessage: vi.fn(),
    stopStreaming: vi.fn(),
    pendingMessage: "",
    clearPendingMessage: vi.fn(),
    switchSession: vi.fn(),
    selectSession: vi.fn(),
    startModelChat: vi.fn(),
    startFreshSession: vi.fn(),
    refreshSessions: vi.fn(),
    skipNextSessionInitRef: { current: false },
  })),
}));

vi.mock("../../hooks/useAgents", () => ({
  useAgents: vi.fn(() => ({
    agents: [{ id: "agent-1", name: "Agent One", role: "executor", state: "active" }],
    activeAgents: [{ id: "agent-1", name: "Agent One", role: "executor", state: "active" }],
    stats: null,
    isLoading: false,
    loadAgents: vi.fn(),
    loadStats: vi.fn(),
  })),
}));

vi.mock("../../hooks/useFileMention", () => ({
  useFileMention: vi.fn(() => ({
    mentionActive: false,
    tasks: [],
    files: [],
    combinedItems: [],
    loading: false,
    mentionQuery: "",
    selectedIndex: 0,
    setSelectedIndex: vi.fn(),
    detectMention: vi.fn(),
    dismissMention: vi.fn(),
    handleKeyDown: vi.fn(),
    selectTask: vi.fn((task: { id?: string }, text: string) => `${text}${task.id ?? ""}`),
    selectFile: vi.fn((file: { path?: string }, text: string) => `${text}${file.path ?? ""}`),
  })),
}));

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: vi.fn(() => ({
    keyboardOverlap: 0,
    viewportHeight: null,
    viewportOffsetTop: 0,
    keyboardOpen: false,
  })),
}));

vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn(() => "desktop");
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    useViewportMode,
  };
});

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => children,
}));

const quickChatCss = readFileSync(resolve(__dirname, "../QuickChatFAB.css"), "utf8");

describe("QuickChatFAB autosize", () => {
  it("keeps textarea CSS min/max height aligned with autosize contract", () => {
    const textareaRule = quickChatCss.match(/\.quick-chat-textarea\s*\{[^}]*\}/);

    expect(textareaRule).not.toBeNull();
    expect(textareaRule?.[0]).toContain("max-height: 640px");
    expect(textareaRule?.[0]).toContain("min-height: 40px");
  });

  it("clamps composer heights to the expected floor and cap", () => {
    expect(clampQuickChatInputHeight(600)).toBe(600);
    expect(clampQuickChatInputHeight(800)).toBe(640);
    expect(clampQuickChatInputHeight(80)).toBe(80);
    expect(clampQuickChatInputHeight(20)).toBe(40);
  });

  it("renders quick chat input as textarea and assigns a px height while typing", () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open />);

    const input = screen.getByTestId("quick-chat-input");
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => 96,
    });

    fireEvent.change(input, { target: { value: "line 1\nline 2" } });

    expect(input.tagName).toBe("TEXTAREA");
    expect((input as HTMLTextAreaElement).style.height).toMatch(/^\d+px$/);
  });

  it("keeps quick chat text visible for growth between old and new caps", () => {
    render(<QuickChatFAB addToast={vi.fn()} projectId="proj-1" open />);

    const input = screen.getByTestId("quick-chat-input") as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => 500,
    });

    fireEvent.change(input, { target: { value: "line 1\nline 2\nline 3\nline 4" } });

    expect(input.style.height).toBe("500px");
  });
});
