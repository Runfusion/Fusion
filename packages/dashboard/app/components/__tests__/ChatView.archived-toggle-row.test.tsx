import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { installChatViewEnv, renderWithAct, setupMockChat } from "./ChatView.test-harness";

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "anthropic", defaultModelId: "claude-sonnet-4-5" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

const chatViewCss = readFileSync(resolve(__dirname, "../ChatView.css"), "utf8");
const archivedSession = {
  id: "session-archived",
  agentId: "agent-002",
  status: "archived" as const,
  title: "Archived conversation",
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

function getFilterRow() {
  const toggle = screen.getByTestId("chat-archived-toggle");
  const row = toggle.closest(".chat-sidebar-filter-row");
  expect(row).toContainElement(screen.getByTestId("chat-tag-filter"));
  expect(row?.parentElement).toHaveClass("chat-sidebar-search-container");
  return row!;
}

describe("ChatView archived toggle filter row", () => {
  it("keeps the Archived label and archive behavior in the shared filter row", async () => {
    const refreshArchivedSessions = vi.fn().mockResolvedValue(undefined);
    setupMockChat({ archivedSessions: [archivedSession], refreshArchivedSessions });
    const user = userEvent.setup();

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const toggle = screen.getByTestId("chat-archived-toggle");
    expect(toggle).toHaveTextContent(/^Archived$/);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Archived conversations")).not.toBeInTheDocument();
    expect(screen.queryByText("Active conversations")).not.toBeInTheDocument();
    getFilterRow();
    expect(document.querySelectorAll("[data-testid=\"chat-archived-toggle\"]")).toHaveLength(1);
    expect(document.querySelector(".chat-sidebar-search-container")?.nextElementSibling).toHaveClass("chat-session-list");

    await user.click(toggle);
    expect(toggle).toHaveTextContent(/^Archived$/);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(refreshArchivedSessions).toHaveBeenCalledOnce();
    expect(screen.getByTestId("chat-archived-session-session-archived")).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveTextContent(/^Archived$/);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(refreshArchivedSessions).toHaveBeenCalledOnce();
  });

  it("keeps populated selected-tag controls beside Archived", async () => {
    const tag = {
      id: "tag-long",
      projectId: "proj-123",
      name: "A very long tag name that must not displace the archive toggle",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    };
    setupMockChat({ tags: [tag], selectedTagId: tag.id, setSelectedTagId: vi.fn() });

    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

    const row = getFilterRow();
    expect(within(row).getByLabelText("Clear tag filter")).toBeInTheDocument();
    expect(within(row).getByTestId("chat-archived-toggle")).toHaveTextContent(/^Archived$/);
  });

  it("declares a token-padded flex filter row without a full-row tag filter", () => {
    const rowRule = chatViewCss.match(/(?:^|\n)\.chat-sidebar-filter-row\s*\{([^{}]*)\}/)?.[1];
    const tagFilterRule = chatViewCss.match(/(?:^|\n)\.chat-tag-filter\s*\{([^{}]*)\}/)?.[1];

    expect(rowRule).toMatch(/display:\s*flex/);
    expect(rowRule).toMatch(/padding:\s*var\(--space-/);
    expect(tagFilterRule).toContain("flex: 1 1 auto");
    expect(tagFilterRule).not.toMatch(/flex:\s*1\s*;/);
  });
});
