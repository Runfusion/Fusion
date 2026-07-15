/*
FNXC:DashboardTests 2026-06-25-17:44:
ChatView suite split 4/5 (core interactions) extracts the attachments, mentions, slash-skill, and streaming-state blocks from ChatView.core.test.tsx so each focused sibling stays under the line-count guard without dropping coverage. Shares ChatView.test-harness; vi.mock factories stay inline and self-contained per the harness TDZ warning.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { ChatView } from "../ChatView";
import type { DiscoveredSkill } from "@fusion/dashboard";
import type { UseChatReturn, ChatSessionInfo } from "../../hooks/useChat";
import { loadAllAppCss } from "../../test/cssFixture";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { SWR_CACHE_KEYS, writeCache } from "../../utils/swrCache";
import {
  renderWithAct,
  setupMockChat,
  setupMockRooms,
  mockViewportMode,
  activeSessionFixture,
  createMockSkill,
  defaultChatState,
  defaultModelsResponse,
  mockUseChat,
  mockFetchModels,
  mockFetchDiscoveredSkills,
  mockCreateObjectURL,
  mockRevokeObjectURL,
  mockClipboardWriteText,
  installChatViewEnv,
} from "./ChatView.test-harness";

// Mock the hooks
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return {
    ...actual,
    useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
  };
});

// Mock lucide-react icons - spread actual module and override specific icons
vi.mock("lucide-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("lucide-react")>();
  return {
    ...actual,
    MessageSquare: ({ "data-testid": testId, ...props }: any) => (
      <svg data-testid={testId || "icon-message-square"} {...props} />
    ),
    Send: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-send"} {...props} />,
    Plus: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-plus"} {...props} />,
    Search: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-search"} {...props} />,
    Trash2: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-trash"} {...props} />,
    Archive: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-archive"} {...props} />,
    Pencil: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-pencil"} {...props} />,
    ChevronLeft: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-chevron-left"} {...props} />,
    Bot: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-bot"} {...props} />,
    Square: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-square"} {...props} />,
    Eye: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-eye"} {...props} />,
    EyeOff: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-eye-off"} {...props} />,
    Paperclip: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-paperclip"} {...props} />,
    File: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-file"} {...props} />,
    Copy: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-copy"} {...props} />,
    Check: ({ "data-testid": testId, ...props }: any) => <svg data-testid={testId || "icon-check"} {...props} />,
  };
});

// Mock CustomModelDropdown - no longer used but kept for other tests
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({
    value,
    onChange,
    label,
    showThinkingLevel,
    thinkingLevel,
    onThinkingLevelChange,
    defaultThinkingLevel,
  }: {
    value: string;
    onChange: (value: string) => void;
    label: string;
    showThinkingLevel?: boolean;
    thinkingLevel?: string;
    onThinkingLevelChange?: (value: string) => void;
    defaultThinkingLevel?: string;
  }) => (
    <div>
      <select
        data-testid="mock-model-dropdown"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Use default</option>
        <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
        <option value="openai/gpt-4o">GPT-4o</option>
      </select>
      {showThinkingLevel && (
        <select
          data-testid="mock-thinking-level"
          aria-label="Thinking Level"
          value={thinkingLevel || ""}
          onChange={(event) => onThinkingLevelChange?.(event.target.value)}
        >
          <option value="">Default ({defaultThinkingLevel ?? "off"})</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      )}
    </div>
  ),
}));

// Mock fetchAgents for new chat dialog
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({
    models: [
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000 },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
    ],
    favoriteProviders: [],
    favoriteModels: [],
    defaultProvider: "anthropic",
    defaultModelId: "claude-sonnet-4-5",
  }),
  fetchAgents: vi.fn().mockResolvedValue([
    { id: "agent-001", name: "Alpha", role: "executor", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
    { id: "agent-002", name: "Beta", role: "reviewer", state: "idle", icon: undefined, createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z", metadata: {} },
  ]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();


describe("ChatView core interactions", () => {
  describe("attachments", () => {
    it("clicking paperclip triggers hidden file input", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const clickSpy = vi.spyOn(fileInput, "click");

      await userEvent.click(screen.getByTestId("chat-attach-btn"));
      expect(clickSpy).toHaveBeenCalled();
    });

    it("allows attaching an image and sends with attachments only", async () => {
      const sendMessage = vi.fn();
      setupMockChat({ activeSession: activeSessionFixture, messages: [], sendMessage });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const attachButton = screen.getByTestId("chat-attach-btn");
      expect(attachButton).toBeInTheDocument();

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(["image"], "shot.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [imageFile] } });

      expect(await screen.findByTestId("chat-attachment-previews")).toBeInTheDocument();
      const sendButton = screen.getByTestId("chat-send-btn");
      expect(sendButton).not.toBeDisabled();

      await userEvent.click(sendButton);
      expect(sendMessage).toHaveBeenCalledWith("", [imageFile]);
      expect(screen.queryByTestId("chat-attachment-previews")).not.toBeInTheDocument();
    });

    it("accepts non-image files and renders filename preview", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const textFile = new File(["hello"], "note.txt", { type: "text/plain" });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      expect(await screen.findByText("note.txt")).toBeInTheDocument();
      expect(mockCreateObjectURL).not.toHaveBeenCalled();
    });

    it("adds image attachments from paste events", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      const imageFile = new File(["image"], "paste.png", { type: "image/png" });
      fireEvent.paste(textarea, { clipboardData: { files: [imageFile] } });

      expect(await screen.findByTestId("chat-attachment-previews")).toBeInTheDocument();
    });

    it("adds attachments from drag-and-drop", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const wrapper = document.querySelector(".chat-input-wrapper") as HTMLElement;
      const textFile = new File(["log"], "drop.log", { type: "text/x-log" });
      fireEvent.drop(wrapper, { dataTransfer: { files: [textFile] } });

      expect(await screen.findByText("drop.log")).toBeInTheDocument();
    });

    it("removes pending attachments and revokes preview urls", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      const imageFile = new File(["image"], "shot.png", { type: "image/png" });
      fireEvent.change(fileInput, { target: { files: [imageFile] } });

      const removeButton = await screen.findByTestId("chat-attachment-remove-0");
      await userEvent.click(removeButton);

      expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:shot.png");
      expect(screen.queryByTestId("chat-attachment-previews")).not.toBeInTheDocument();
    });

    it("renders message attachments inline as actionable links", async () => {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          {
            id: "msg-attach",
            sessionId: "session-001",
            role: "assistant",
            content: "Attached files",
            createdAt: "2026-04-08T00:00:00.000Z",
            attachments: [
              {
                id: "att-1",
                filename: "img-1.png",
                originalName: "capture.png",
                mimeType: "image/png",
                size: 10,
                createdAt: "2026-04-08T00:00:00.000Z",
              },
              {
                id: "att-2",
                filename: "note.txt",
                originalName: "note.txt",
                mimeType: "text/plain",
                size: 20,
                createdAt: "2026-04-08T00:00:00.000Z",
              },
            ],
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const links = screen.getAllByTestId("chat-message-attachment");
      expect(links).toHaveLength(2);
      expect(links[0]).toHaveAttribute("href", "/api/chat/sessions/session-001/attachments/img-1.png");
      expect(links[0]).toHaveAttribute("target", "_blank");
      expect(links[1]).toHaveAttribute("href", "/api/chat/sessions/session-001/attachments/note.txt");
      expect(screen.getByText("note.txt")).toBeInTheDocument();
    });
  });

  describe("agent mentions", () => {
    it("shows mention popup when @ is typed", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");

      expect(await screen.findByTestId("agent-mention-popup")).toBeInTheDocument();
    });

    it("filters mention popup by text after @", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@be");

      expect(await screen.findByTestId("agent-mention-item-agent-002")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-mention-item-agent-001")).not.toBeInTheDocument();
    });

    it("hides mention popup on Escape", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "@");
      expect(await screen.findByTestId("agent-mention-popup")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("agent-mention-popup")).not.toBeInTheDocument();
    });

    it("inserts mention text when selecting an agent", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
      await userEvent.type(textarea, "@al");

      const mentionItem = await screen.findByTestId("agent-mention-item-agent-001");
      await userEvent.click(mentionItem);

      expect(textarea.value).toBe("@Alpha ");
      expect(screen.queryByTestId("agent-mention-popup")).not.toBeInTheDocument();
    });

    it("uses room member ordering in popup and marks non-member mention chips in room messages", async () => {
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      setupMockRooms({
        activeRoom: {
          id: "room-001",
          slug: "engineering",
          name: "engineering",
          createdBy: "agent-001",
          status: "active",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        activeRoomMembers: [
          { roomId: "room-001", agentId: "agent-001", role: "member", addedAt: "2026-04-08T00:00:00.000Z" },
        ],
        messages: [
          {
            id: "room-msg-1",
            roomId: "room-001",
            role: "user",
            content: "Ping @Alpha and @Beta",
            senderAgentId: "agent-001",
            metadata: null,
            attachments: [],
            mentions: ["agent-001", "agent-002"],
            createdAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      });

      const allCss = await loadAllAppCss();
      const style = document.createElement("style");
      style.textContent = allCss;
      document.head.appendChild(style);

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);

      const user = userEvent.setup({ delay: null });
      await user.click(screen.getByTestId("chat-sidebar-scope-rooms"));
      const textarea = screen.getByTestId("chat-input");
      await user.type(textarea, "@");

      expect(screen.getByTestId("agent-mention-members-header")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-mention-others-header")).not.toBeInTheDocument();

      const bubble = screen.getByText("Ping", { exact: false }).closest(".chat-message--user");
      expect(bubble).toBeTruthy();

      const memberChip = screen.getByText("@Alpha", { selector: ".chat-mention-chip" });
      const nonMemberChip = screen.getByText("@Beta", { selector: ".chat-mention-chip--non-member" });
      expect(nonMemberChip).toHaveAttribute("title", "Not a member of engineering");

      // FN-4520: member mention chip text must not visually collapse into sent-bubble background.
      expect(getComputedStyle(memberChip).color).not.toBe(getComputedStyle(bubble as Element).backgroundColor);
      // FN-4520: non-member mention chip text must remain legible inside sent bubbles.
      expect(getComputedStyle(nonMemberChip).color).not.toBe(getComputedStyle(bubble as Element).backgroundColor);
    });

    it("renders assistant mentions as plain text in markdown mode", async () => {
      setupMockChat({
        activeSession: activeSessionFixture,
        messages: [
          {
            id: "msg-001",
            sessionId: "session-001",
            role: "assistant",
            content: "Talk to @Alpha and @Unknown next.",
            createdAt: "2026-04-08T00:00:00.000Z",
          },
        ],
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/Talk to @Alpha and @Unknown next\./)).toBeInTheDocument();
      });
      expect(screen.queryByText("@Alpha", { selector: ".chat-mention-chip" })).toBeNull();
      expect(screen.queryByText("@Unknown", { selector: ".chat-mention-chip" })).toBeNull();
    });
  });

  describe("slash skill autocomplete", () => {
    it("shows the skill menu when typing slash in the chat input", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-refactor", name: "refactor/code", relativePath: "skills/refactor/code.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();
      expect(screen.getByText("refactor/code")).toBeInTheDocument();
    });

    it("filters discovered skills from slash input", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
        createMockSkill({ id: "skill-deploy", name: "deploy/app", relativePath: "skills/deploy/app.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/re");

      expect(await screen.findByText("review/pr")).toBeInTheDocument();
      expect(screen.queryByText("deploy/app")).not.toBeInTheDocument();
    });

    it("inserts /skill command when clicking a menu item", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/re");

      await userEvent.click(await screen.findByRole("option", { name: /review\/pr/i }));

      expect(textarea).toHaveValue("/skill:review/pr ");
      expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
    });

    it("supports arrow navigation with wrapping and Enter selection", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
        createMockSkill({ id: "skill-gamma", name: "gamma", relativePath: "skills/gamma.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      fireEvent.change(textarea, { target: { value: "/" } });
      await screen.findByRole("option", { name: /alpha/i });

      // Wrap to bottom from the first item.
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
          "chat-skill-menu-item--highlighted",
        ),
      );

      fireEvent.keyDown(textarea, { key: "Enter" });
      await waitFor(() => expect(textarea).toHaveValue("/skill:gamma "));
    });

    it("keeps the keyboard highlight when revalidation re-delivers an identical skill list", async () => {
      // Regression: the SWR skills cache re-delivers content-identical lists
      // with fresh array identities (cache reads re-parse; revalidation
      // notifies a new array). The highlight reset must key on skill ids, not
      // array identity, or a revalidation landing mid-navigation wipes the
      // user's keyboard position (the source of this test family's CI flakes).
      const skillsList = [
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
        createMockSkill({ id: "skill-gamma", name: "gamma", relativePath: "skills/gamma.md" }),
      ];
      // Seed the cache so the menu renders before the (deferred) revalidation fetch.
      writeCache(`${SWR_CACHE_KEYS.DISCOVERED_SKILLS_PREFIX}proj-123`, skillsList);
      let resolveFetch!: (skills: DiscoveredSkill[]) => void;
      mockFetchDiscoveredSkills.mockImplementationOnce(
        () => new Promise<DiscoveredSkill[]>((resolve) => { resolveFetch = resolve; }),
      );
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      fireEvent.change(textarea, { target: { value: "/" } });
      await screen.findByRole("option", { name: /alpha/i });

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() =>
        expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
          "chat-skill-menu-item--highlighted",
        ),
      );

      // Revalidation lands mid-navigation: identical content, new identity.
      await act(async () => {
        resolveFetch(JSON.parse(JSON.stringify(skillsList)) as DiscoveredSkill[]);
      });

      expect(screen.getByRole("option", { name: /gamma/i })).toHaveClass(
        "chat-skill-menu-item--highlighted",
      );
    });

    it("supports selecting highlighted skill with Tab", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-alpha", name: "alpha", relativePath: "skills/alpha.md" }),
        createMockSkill({ id: "skill-beta", name: "beta", relativePath: "skills/beta.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");
      await screen.findByRole("option", { name: /alpha/i });

      await userEvent.keyboard("{ArrowDown}");
      expect(screen.getByRole("option", { name: /beta/i })).toHaveClass(
        "chat-skill-menu-item--highlighted",
      );

      await userEvent.keyboard("{Tab}");
      expect(textarea).toHaveValue("/skill:beta ");
    });

    it("closes the menu when pressing Escape", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");
      expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
    });

    it("closes the menu when slash trigger pattern no longer matches", async () => {
      mockFetchDiscoveredSkills.mockResolvedValueOnce([
        createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" }),
      ]);
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/re");
      expect(await screen.findByTestId("chat-skill-menu")).toBeInTheDocument();

      await userEvent.type(textarea, " ");
      expect(screen.queryByTestId("chat-skill-menu")).not.toBeInTheDocument();
    });

    it("shows loading indicator while discovered skills are still loading", async () => {
      let resolveSkills: ((skills: DiscoveredSkill[]) => void) | undefined;
      mockFetchDiscoveredSkills.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSkills = resolve;
          }),
      );
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByText("Loading skills…")).toBeInTheDocument();

      resolveSkills?.([createMockSkill({ id: "skill-review", name: "review/pr", relativePath: "skills/review/pr.md" })]);
      await waitFor(() => {
        expect(screen.getByText("review/pr")).toBeInTheDocument();
      });
    });

    it("does not crash when discovered skills fail to load", async () => {
      mockFetchDiscoveredSkills.mockRejectedValueOnce(new Error("skills endpoint unavailable"));
      setupMockChat({ activeSession: activeSessionFixture, messages: [] });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const textarea = screen.getByTestId("chat-input");
      await userEvent.type(textarea, "/");

      expect(await screen.findByText("No skills available")).toBeInTheDocument();
    });
  });

  it("disables send button when input is empty", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sendButton = screen.getByTestId("chat-send-btn");
    expect(sendButton).toBeDisabled();
  });

  it("renders stop button when streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-stop-btn")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-send-btn")).not.toBeInTheDocument();
  });

  it("clicking stop button calls stopStreaming", async () => {
    const stopStreaming = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
      stopStreaming,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-stop-btn"));
    expect(stopStreaming).toHaveBeenCalledTimes(1);
  });

  it("FN-6576 does not let a send gesture trailing click press the swapped stop button", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const sendMessage = vi.fn();
    const stopStreaming = vi.fn();
    mockUseChat.mockImplementation(() => {
      const [isStreaming, setIsStreaming] = useState(false);
      return {
        ...defaultChatState,
        activeSession: activeSessionFixture,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        messages: [],
        isStreaming,
        sendMessage: (message, files) => {
          sendMessage(message, files);
          setIsStreaming(true);
        },
        stopStreaming,
      } satisfies UseChatReturn;
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Start streaming" } });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });
      fireEvent.touchStart(screen.getByTestId("chat-send-btn"));
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("Start streaming", []);

    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-stop-btn"));
    });
    expect(stopStreaming).not.toHaveBeenCalled();
    viewportSpy.mockRestore();
  });

  it("FN-6576 allows a standalone mobile stop tap exactly once", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const stopStreaming = vi.fn();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: true,
      stopStreaming,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-stop-btn"), { pointerType: "touch" });
      fireEvent.touchStart(screen.getByTestId("chat-stop-btn"));
      fireEvent.click(screen.getByTestId("chat-stop-btn"));
    });
    expect(stopStreaming).toHaveBeenCalledTimes(1);
    viewportSpy.mockRestore();
  });

  it("FN-6576 allows a genuine stop tap within the send click-latch window", async () => {
    const viewportSpy = mockViewportMode("mobile");
    const sendMessage = vi.fn();
    const stopStreaming = vi.fn();
    mockUseChat.mockImplementation(() => {
      const [isStreaming, setIsStreaming] = useState(false);
      return {
        ...defaultChatState,
        activeSession: activeSessionFixture,
        sessions: [activeSessionFixture],
        filteredSessions: [activeSessionFixture],
        messages: [],
        isStreaming,
        sendMessage: (message, files) => {
          sendMessage(message, files);
          setIsStreaming(true);
        },
        stopStreaming,
      } satisfies UseChatReturn;
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    fireEvent.change(screen.getByTestId("chat-input"), { target: { value: "Start then stop" } });
    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-send-btn"), { pointerType: "touch" });
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("chat-stop-btn"), { pointerType: "touch" });
      fireEvent.touchStart(screen.getByTestId("chat-stop-btn"));
      fireEvent.click(screen.getByTestId("chat-stop-btn"));
    });
    expect(stopStreaming).toHaveBeenCalledTimes(1);
    viewportSpy.mockRestore();
  });

  it("renders send button when not streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [],
      isStreaming: false,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByTestId("chat-send-btn")).toBeInTheDocument();
  });

  it("renders stacked pending message indicators above the input row and dismisses one entry", async () => {
    const clearPendingMessage = vi.fn();
    const activeSession = activeSessionFixture;
    setupMockChat({
      activeSession,
      messages: [],
      pendingMessages: ["Queued A", "Queued B", "Queued C with a very long body that should truncate in the preview"],
      clearPendingMessage,
    });

    const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const indicators = screen.getAllByTestId("chat-pending-indicator");
    expect(indicators).toHaveLength(3);
    expect(indicators[0]).toHaveTextContent("Queued: Queued A");
    expect(indicators[1]).toHaveTextContent("Queued: Queued B");
    expect(indicators[2]).toHaveTextContent("Queued: Queued C with a very long body that should truncat…");

    const input = screen.getByTestId("chat-input");
    const inputArea = input.closest(".chat-input-area");
    const inputRow = input.closest(".chat-input-row");
    const inputWrapper = input.closest(".chat-input-wrapper");
    expect(inputArea).not.toBeNull();
    expect(inputRow).not.toBeNull();
    expect(inputWrapper).not.toBeNull();
    indicators.forEach((indicator) => {
      expect(inputArea).toContainElement(indicator);
      expect(inputWrapper).not.toContainElement(indicator);
      expect(indicator.compareDocumentPosition(inputRow!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(inputArea!.querySelectorAll(".chat-pending-divider")).toHaveLength(1);

    await userEvent.click(screen.getByTestId("chat-pending-dismiss-1"));
    expect(clearPendingMessage).toHaveBeenCalledWith(1);

    setupMockChat({
      activeSession,
      messages: [],
      pendingMessages: [],
      clearPendingMessage,
    });
    rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.queryByTestId("chat-pending-indicator")).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-input").closest(".chat-input-area")!.querySelector(".chat-pending-divider")).not.toBeInTheDocument();
  });

  it("textarea is enabled during streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");
    expect(textarea).not.toBeDisabled();
  });

  it("user can type while streaming", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Thinking...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const textarea = screen.getByTestId("chat-input");

    // User should be able to type in the textarea while streaming
    fireEvent.change(textarea, { target: { value: "Second message" } });
    expect((textarea as HTMLTextAreaElement).value).toBe("Second message");
  });

  it("shows streaming indicator when isStreaming is true", async () => {
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
      isStreaming: true,
      streamingText: "Typing...",
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    // Streaming message should show
    const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
    expect(streamingMessage).toBeInTheDocument();
    expect(streamingMessage?.textContent).toContain("Typing");
  });

  it("keeps persisted thinking blocks collapsed until expanded", async () => {
    const user = userEvent.setup();
    setupMockChat({
      activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Here's my response", thinkingOutput: "I need to think about this...", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const message = screen.getByTestId("chat-message-msg-001");
    const details = message.querySelector("details") as HTMLDetailsElement;
    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(within(message).getByText("I need to think about this...")).not.toBeVisible();

    await user.click(within(details).getByText("Thinking"));

    expect(details).toHaveAttribute("open");
    expect(within(message).getByText("I need to think about this...")).toBeVisible();
  });

  describe("streaming states", () => {
    it("keeps mobile thread visible when active session metadata refreshes during streaming", async () => {
      const mediaQuerySpy = mockViewportMode("mobile");
      const streamingState: UseChatReturn = {
        ...defaultChatState,
        sessions: [{ ...activeSessionFixture }],
        filteredSessions: [{ ...activeSessionFixture }],
        activeSession: { ...activeSessionFixture },
        messages: [],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      };
      const refreshedStreamingState: UseChatReturn = {
        ...streamingState,
        sessions: [{ ...activeSessionFixture, updatedAt: "2026-04-08T00:05:00.000Z" }],
        filteredSessions: [{ ...activeSessionFixture, updatedAt: "2026-04-08T00:05:00.000Z" }],
        activeSession: null,
      };

      mockUseChat
        .mockReturnValueOnce(streamingState)
        .mockReturnValue(refreshedStreamingState);

      const { rerender } = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Working");
      rerender(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Working");
      expect(screen.queryByText("Start a new conversation")).not.toBeInTheDocument();
      expect(screen.queryByText("No messages yet. Start the conversation!")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

      void mediaQuerySpy;
    });

    it("keeps the streaming indicator visible while message history is still loading", async () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [],
        messagesLoading: true,
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Working");
      expect(screen.queryByText("Loading messages...")).not.toBeInTheDocument();
    });

    it("keeps desktop accepted silent requests as waiting instead of failure", async () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Slow prompt", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(screen.queryByText("Response failed")).not.toBeInTheDocument();
      expect(screen.queryByText("Timed out waiting for first response event")).not.toBeInTheDocument();
      expect(document.querySelector(".chat-message-content--failure")).not.toBeInTheDocument();
      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Working");
    });

    it("keeps mobile accepted silent requests in the visible thread", async () => {
      const mediaQuerySpy = mockViewportMode("mobile");
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Slow mobile prompt", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(screen.queryByText("Response failed")).not.toBeInTheDocument();
      expect(screen.queryByText("Timed out waiting for first response event")).not.toBeInTheDocument();
      expect(document.querySelector(".chat-message--streaming")?.textContent).toContain("Working");
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();

      void mediaQuerySpy;
    });

    it("shows waiting indicator when streaming starts before text arrives", async () => {
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Working..." text
      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Working");

      // Waiting class should be present
      const waitingContent = streamingMessage?.querySelector(".chat-message-content--waiting");
      expect(waitingContent).toBeInTheDocument();

      // Typing indicator dots should be rendered
      const typingIndicator = streamingMessage?.querySelector(".chat-typing-indicator");
      expect(typingIndicator).toBeInTheDocument();
      expect(typingIndicator?.querySelectorAll("span").length).toBe(3);
    });

    it("keeps streaming thinking collapsed until expanded", async () => {
      const user = userEvent.setup();
      setupMockChat({
        activeSession: { id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        messages: [
          { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        ],
        isStreaming: true,
        streamingText: "",
        streamingThinking: "analyzing the request...",
      });

      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      // Streaming message should show with "Thinking..." text
      const streamingMessage = document.querySelector(".chat-message--streaming") as HTMLElement | null;
      expect(streamingMessage).toBeInTheDocument();
      expect(streamingMessage?.textContent).toContain("Thinking");

      // Thinking details should be rendered
      const thinkingDetails = streamingMessage?.querySelector("details.chat-message-thinking") as HTMLDetailsElement;
      expect(thinkingDetails).toBeInTheDocument();
      expect(thinkingDetails).not.toHaveAttribute("open");
      expect(within(thinkingDetails).getByText("analyzing the request...")).not.toBeVisible();

      await user.click(within(thinkingDetails).getByText("Thinking"));

      expect(thinkingDetails).toHaveAttribute("open");
      expect(within(thinkingDetails).getByText("analyzing the request...")).toBeVisible();

      // Typing indicator dots should be rendered
      const typingIndicator = streamingMessage?.querySelector(".chat-typing-indicator");
      expect(typingIndicator).toBeInTheDocument();
    });
  });

  it("filters sessions by search query", async () => {
    setupMockChat({
      sessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Frontend work", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
        { id: "session-002", agentId: "agent-002", status: "active", title: "Backend API", createdAt: "2026-04-07T00:00:00.000Z", updatedAt: "2026-04-07T00:00:00.000Z" },
      ],
      filteredSessions: [
        { id: "session-001", agentId: "agent-001", status: "active", title: "Frontend work", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" },
      ],
      searchQuery: "frontend",
      setSearchQuery: vi.fn(),
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Frontend work")).toBeInTheDocument();
    expect(screen.queryByText("Backend API")).not.toBeInTheDocument();
  });

  it("shows empty state with Start Chat button (no inline agent selector)", async () => {
    setupMockChat({ sessions: [], filteredSessions: [] });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    expect(screen.getByText("Start a new conversation")).toBeInTheDocument();
    // Find the New Chat button in the empty state section
    const emptyStateText = screen.getByText("Start a new conversation");
    const emptyState = emptyStateText.closest(".chat-empty-state") as HTMLElement | null;
    expect(within(emptyState!).getByRole("button", { name: /new chat/i })).toBeInTheDocument();
    // Should NOT have an agent selector in empty state
    expect(emptyState?.querySelector("select")).toBeNull();
  });

  it("creates a model-mode new chat with the selected thinking level", async () => {
    const createSession = vi.fn().mockResolvedValue({ id: "session-new", agentId: "__fn_agent__", status: "active", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" });
    setupMockChat({ sessions: [], filteredSessions: [], createSession });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));
    await userEvent.click(screen.getByTestId("chat-new-dialog-mode-model"));
    expect(await screen.findByTestId("mock-thinking-level")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByTestId("mock-thinking-level"), "high");
    await userEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(createSession).toHaveBeenCalledWith({
        agentId: "__fn_agent__",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        thinkingLevel: "high",
      });
    });
  });

  it("does not render a thinking-level control in agent-mode new chat", async () => {
    setupMockChat({ sessions: [], filteredSessions: [], createSession: vi.fn() });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    await userEvent.click(screen.getByTestId("chat-new-btn"));

    expect(screen.queryByTestId("mock-thinking-level")).not.toBeInTheDocument();
  });

  it("shows context menu on right-click", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");

    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    expect(screen.getByTestId("chat-context-archive")).toBeInTheDocument();
    expect(screen.getByTestId("chat-context-delete")).toBeInTheDocument();
  });

  it("calls archiveSession when clicking Archive in context menu", async () => {
    const archiveSession = vi.fn();
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      archiveSession,
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    await userEvent.click(screen.getByTestId("chat-context-archive"));

    expect(archiveSession).toHaveBeenCalledWith("session-001");
  });

  it("shows delete confirmation dialog", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "agent-001", status: "active", title: "Test Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    await userEvent.pointer({ target: sessionItem, keys: "[MouseRight]" });

    await userEvent.click(screen.getByTestId("chat-context-delete"));

    // Dialog should be open
    const dialog = document.querySelector(".chat-new-dialog") as HTMLElement | null;
    expect(dialog).toBeInTheDocument();
    expect(within(dialog!).getByText("Delete Conversation?")).toBeInTheDocument();
  });

  it("shows formatted model label for fn agent sessions in sidebar", async () => {
    setupMockChat({
      sessions: [{
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "My Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        updatedAt: "2026-04-08T00:00:00.000Z",
        createdAt: "2026-04-08T00:00:00.000Z",
      }],
      filteredSessions: [{
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "My Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        updatedAt: "2026-04-08T00:00:00.000Z",
        createdAt: "2026-04-08T00:00:00.000Z",
      }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Claude Sonnet 4.5")).toBeInTheDocument();
    expect(within(sessionItem).queryByText("Fusion")).not.toBeInTheDocument();
  });

  it("shows Fusion fallback for fn agent sessions in sidebar without model info", async () => {
    mockFetchModels.mockResolvedValue({
      models: [],
      favoriteProviders: [],
      favoriteModels: [],
      defaultProvider: null,
      defaultModelId: null,
    });
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "__fn_agent__", status: "active", title: "My Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    expect(within(sessionItem).getByText("Fusion")).toBeInTheDocument();
  });

  it("shows agent ID for non-fn agent sessions in sidebar", async () => {
    setupMockChat({
      sessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
      filteredSessions: [{ id: "session-001", agentId: "my-custom-agent", status: "active", title: "Custom Chat", createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z" }],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const sessionItem = screen.getByTestId("chat-session-session-001");
    // Should show the agent ID (truncated to 30 chars)
    expect(within(sessionItem).getByText("my-custom-agent")).toBeInTheDocument();
  });

  it("shows formatted model name in thread header title for fn agent sessions", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(title).toBeInTheDocument();
    expect(title).toHaveTextContent("Claude Sonnet 4.5");
    expect(title).not.toHaveTextContent("Fusion");
  });

  it("shows model tag in thread header when non-fn session has model", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag") as HTMLElement | null;
    expect(headerModelTag).toBeInTheDocument();
    expect(headerModelTag?.textContent).toContain("Claude");
  });

  it("does not show duplicate model tag in thread header for fn agent sessions", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const title = document.querySelector(".chat-thread-header-title") as HTMLElement | null;
    expect(title).toHaveTextContent("Claude Sonnet 4.5");

    const headerModelTag = document.querySelector(".chat-thread-header .chat-model-tag") as HTMLElement | null;
    expect(headerModelTag).toBeNull();
  });

  // FNXC:ChatRenderToggle 2026-07-04-00:00: the render toggle previously
  // asserted here was removed per FN-7541; keep the identity-grouping
  // assertions and add a regression check that no toggle remains.
  it("keeps provider identity text grouped in header with no render toggle present", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "anthropic",
        modelId: "claude-sonnet-4-5",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:00:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const header = document.querySelector(".chat-thread-header") as HTMLElement | null;
    const identity = screen.getByTestId("chat-thread-header-identity");
    const providerIcon = identity.querySelector(".provider-icon");
    const modelTag = identity.querySelector(".chat-model-tag");
    const newChatButton = screen.getByTestId("chat-new-btn");

    expect(header).toBeInTheDocument();
    expect(newChatButton.closest(".view-header")).toBeInTheDocument();
    expect(providerIcon).toBeInTheDocument();
    expect(within(identity).getByText("Agent Chat")).toBeInTheDocument();
    expect(modelTag).toBeInTheDocument();
    expect(modelTag).toHaveTextContent("Claude Sonnet 4.5");
    expect(screen.queryByTestId("chat-thread-render-toggle")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".chat-thread-header .chat-model-tag")).toHaveLength(1);
  });

  it("does not show model tag when session has no model", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "user", content: "Hello", createdAt: "2026-04-08T00:00:00.000Z" },
        { id: "msg-002", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const modelTag = document.querySelector(".chat-model-tag") as HTMLElement | null;
    expect(modelTag).not.toBeInTheDocument();
  });

  it("does not repeat the model tag in per-message avatars for non-fn sessions", async () => {
    // Per-message model tags were intentionally removed — the model is shown
    // once in the thread header. The avatar should still render with the
    // agent name (no agent identity collapse for real agents) but no model
    // tag inside it.
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "agent-001",
        status: "active",
        title: "Agent Chat",
        modelProvider: "openai",
        modelId: "gpt-4o",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    const avatar = messageBubble.querySelector(".chat-message-avatar") as HTMLElement | null;
    expect(avatar).toBeInTheDocument();
    expect(avatar?.querySelector(".chat-model-tag")).toBeNull();
  });

  it("hides per-message identity entirely for fn agent (model-only) sessions even when model is set", async () => {
    setupMockChat({
      activeSession: {
        id: "session-001",
        agentId: "__fn_agent__",
        status: "active",
        title: "Test Chat",
        modelProvider: "openai",
        modelId: "gpt-4o",
        createdAt: "2026-04-08T00:00:00.000Z", updatedAt: "2026-04-08T00:00:00.000Z",
      },
      messages: [
        { id: "msg-001", sessionId: "session-001", role: "assistant", content: "Hi!", createdAt: "2026-04-08T00:01:00.000Z" },
      ],
    });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const messageBubble = screen.getByTestId("chat-message-msg-001");
    expect(messageBubble.querySelector(".chat-message-avatar")).toBeNull();
  });

  describe("conversation rename affordances", () => {
    it("renames the clicked sidebar session without selecting it", async () => {
      const selectSession = vi.fn();
      const renameSession = vi.fn().mockResolvedValue(undefined);
      const sessions: ChatSessionInfo[] = [
        {
          id: "session-001",
          agentId: "agent-001",
          status: "active",
          title: "Alpha Chat",
          lastMessagePreview: "Alpha preview",
          createdAt: "2026-04-08T00:00:00.000Z",
          updatedAt: "2026-04-08T00:00:00.000Z",
        },
        {
          id: "session-002",
          agentId: "agent-002",
          status: "active",
          title: "Beta Chat",
          lastMessagePreview: "Beta preview",
          createdAt: "2026-04-07T00:00:00.000Z",
          updatedAt: "2026-04-07T00:00:00.000Z",
        },
      ];

      setupMockChat({
        sessions,
        filteredSessions: sessions,
        activeSession: sessions[0],
        selectSession,
        renameSession,
      });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const betaRow = screen.getByTestId("chat-session-session-002");
      await userEvent.click(within(betaRow).getByTestId("chat-session-rename-btn"));

      expect(selectSession).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog", { name: /rename conversation/i });
      const input = within(dialog).getByTestId("chat-rename-input") as HTMLInputElement;
      expect(input).toHaveValue("Beta Chat");

      await userEvent.clear(input);
      await userEvent.type(input, "Renamed Beta");
      await userEvent.click(within(dialog).getByTestId("chat-rename-save"));

      await waitFor(() => {
        expect(renameSession).toHaveBeenCalledWith("session-002", "Renamed Beta");
      });
      expect(selectSession).not.toHaveBeenCalled();

      await userEvent.click(betaRow);
      expect(selectSession).toHaveBeenCalledWith("session-002");
    });

    it("uses Untitled in the sidebar rename button name for empty session titles", async () => {
      const renameSession = vi.fn().mockResolvedValue(undefined);
      const untitledSession: ChatSessionInfo = {
        id: "session-empty-title",
        agentId: "agent-001",
        status: "active",
        title: undefined,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      };

      setupMockChat({
        sessions: [untitledSession],
        filteredSessions: [untitledSession],
        activeSession: null,
        renameSession,
      });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      const row = screen.getByTestId("chat-session-session-empty-title");
      const renameButton = within(row).getByRole("button", { name: /rename conversation untitled/i });
      expect(renameButton).toHaveAttribute("data-testid", "chat-session-rename-btn");

      await userEvent.click(renameButton);
      const dialog = screen.getByRole("dialog", { name: /rename conversation/i });
      const input = within(dialog).getByTestId("chat-rename-input") as HTMLInputElement;
      expect(input).toHaveValue("");
      expect(input).toHaveAttribute("placeholder", "Untitled");
    });

    it("keeps the existing context-menu rename path wired to renameSession", async () => {
      const renameSession = vi.fn().mockResolvedValue(undefined);
      const session: ChatSessionInfo = {
        id: "session-context",
        agentId: "agent-001",
        status: "active",
        title: "Context Rename",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      };

      setupMockChat({
        sessions: [session],
        filteredSessions: [session],
        activeSession: session,
        renameSession,
      });
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      fireEvent.contextMenu(screen.getByTestId("chat-session-session-context"), { clientX: 12, clientY: 24 });
      await userEvent.click(screen.getByTestId("chat-context-rename"));

      const dialog = screen.getByRole("dialog", { name: /rename conversation/i });
      const input = within(dialog).getByTestId("chat-rename-input") as HTMLInputElement;
      expect(input).toHaveValue("Context Rename");

      await userEvent.clear(input);
      await userEvent.type(input, "Context Renamed");
      await userEvent.click(within(dialog).getByTestId("chat-rename-save"));

      await waitFor(() => {
        expect(renameSession).toHaveBeenCalledWith("session-context", "Context Renamed");
      });
    });
  });

});
