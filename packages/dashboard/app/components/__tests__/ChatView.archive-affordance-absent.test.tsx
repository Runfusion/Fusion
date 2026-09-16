/*
FNXC:ChatArchived 2026-09-16-15:50:
FN-465 retire l'archivage des conversations de l'interface opérateur. Ce contrôle négatif remplace
ChatView.archived-toggle-row.test.tsx (dont le sujet — la bascule « Archived » — est supprimé) et
reprend son assertion de mise en page de `.chat-sidebar-filter-row`, qui porte désormais uniquement
le filtre par tag. Il vérifie l'absence d'affordance sur desktop et en sidebar étroite, sur liste
vide comme peuplée, y compris lorsqu'une conversation archivée existe encore côté données, et prouve
qu'aucune collection archivée n'est plus demandée au hook.
*/
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { ChatView } from "../ChatView";
import type { ChatSessionInfo } from "../../hooks/useChat";
import { readAppFile } from "../../test/cssFixture";
import {
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
} from "./ChatView.test-harness";

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
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

const chatViewCss = readAppFile("components/ChatView.css");

const activeSession: ChatSessionInfo = {
  id: "session-active",
  agentId: "agent-001",
  status: "active",
  title: "Active conversation",
  createdAt: "2026-09-16T08:00:00.000Z",
  updatedAt: "2026-09-16T09:00:00.000Z",
};

const archivedSession: ChatSessionInfo = {
  id: "session-archived",
  agentId: "agent-002",
  status: "archived",
  title: "Archived conversation",
  createdAt: "2026-09-16T08:00:00.000Z",
  updatedAt: "2026-09-16T08:30:00.000Z",
};

function expectNoArchiveAffordance() {
  expect(screen.queryByTestId("chat-archived-toggle")).toBeNull();
  expect(screen.queryByTestId("chat-context-archive")).toBeNull();
  expect(screen.queryByTestId(`chat-archived-session-${archivedSession.id}`)).toBeNull();
  expect(screen.queryByTestId(`chat-archived-restore-${archivedSession.id}`)).toBeNull();
  for (const button of screen.queryAllByRole("button")) {
    const accessibleName = `${button.getAttribute("aria-label") ?? ""} ${button.getAttribute("title") ?? ""} ${button.textContent ?? ""}`;
    expect(accessibleName).not.toMatch(/archiv|restore/i);
  }
}

function setupChat(overrides: Parameters<typeof setupMockChat>[0] = {}) {
  const refreshArchivedSessions = vi.fn().mockResolvedValue(undefined);
  const unarchiveSession = vi.fn().mockResolvedValue(undefined);
  const archiveSession = vi.fn().mockResolvedValue(undefined);
  const loadMoreSessions = vi.fn();
  setupMockChat({
    sessions: [activeSession],
    filteredSessions: [activeSession],
    archivedSessions: [archivedSession],
    hasMoreArchivedSessions: true,
    refreshArchivedSessions,
    unarchiveSession,
    archiveSession,
    loadMoreSessions,
    ...overrides,
  });
  return { refreshArchivedSessions, unarchiveSession, archiveSession, loadMoreSessions };
}

describe("ChatView archive affordance removal (FN-465)", () => {
  it("renders no archive toggle or archive-named control on desktop", async () => {
    const viewportSpy = mockViewportMode("desktop");
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, width: 1280, height: 800, top: 0, right: 1280, bottom: 800, left: 0, toJSON: () => ({}),
    } as DOMRect);
    try {
      setupChat();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expectNoArchiveAffordance();
      expect(screen.getByTestId(`chat-session-${activeSession.id}`)).toBeInTheDocument();
      // The filter row survives because it still carries the tag filter.
      const filterRow = document.querySelector(".chat-sidebar-filter-row");
      expect(filterRow).not.toBeNull();
      expect(within(filterRow as HTMLElement).getByTestId("chat-tag-filter")).toBeInTheDocument();
      expect(within(filterRow as HTMLElement).queryAllByRole("button")).toHaveLength(0);
    } finally {
      rectSpy.mockRestore();
      viewportSpy.mockRestore();
    }
  });

  it("hides an archived conversation and offers no Restore control, with an empty list or a populated one", async () => {
    const viewportSpy = mockViewportMode("desktop");
    try {
      setupChat({ sessions: [], filteredSessions: [] });
      const empty = await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expectNoArchiveAffordance();
      expect(screen.queryByText("Archived conversation")).toBeNull();
      empty.unmount();

      setupChat();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      expectNoArchiveAffordance();
      expect(screen.queryByText("Archived conversation")).toBeNull();
      expect(screen.getByText("Active conversation")).toBeInTheDocument();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("keeps the remaining conversation menu entries without an Archive item or an empty shell", async () => {
    const viewportSpy = mockViewportMode("desktop");
    try {
      setupChat();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      fireEvent.contextMenu(screen.getByTestId(`chat-session-${activeSession.id}`), { clientX: 20, clientY: 20 });

      expect(await screen.findByTestId("chat-context-pin")).toBeInTheDocument();
      expect(screen.getByTestId("chat-context-rename")).toBeInTheDocument();
      expect(screen.getByTestId("chat-context-delete")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-context-archive")).toBeNull();

      const maintenance = document.querySelector<HTMLElement>(
        "[aria-label=\"Conversation maintenance actions\"]",
      );
      expect(maintenance).not.toBeNull();
      for (const item of Array.from((maintenance as HTMLElement).querySelectorAll("button, [role=menuitem]"))) {
        expect((item.textContent ?? "").trim()).not.toBe("");
      }
      expectNoArchiveAffordance();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("never requests the archived collection from useChat", async () => {
    const viewportSpy = mockViewportMode("desktop");
    try {
      const { refreshArchivedSessions, unarchiveSession, archiveSession, loadMoreSessions } = setupChat();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);
      fireEvent.contextMenu(screen.getByTestId(`chat-session-${activeSession.id}`), { clientX: 20, clientY: 20 });
      await screen.findByTestId("chat-context-rename");

      expect(refreshArchivedSessions).not.toHaveBeenCalled();
      expect(unarchiveSession).not.toHaveBeenCalled();
      expect(archiveSession).not.toHaveBeenCalled();
      for (const call of loadMoreSessions.mock.calls) {
        expect(call[0]).not.toBe("archived");
      }
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("renders no archive affordance on the narrow mobile host", async () => {
    const viewportSpy = mockViewportMode("mobile");
    try {
      setupChat();
      await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} />);

      expect(document.querySelector(".chat-view--narrow")).not.toBeNull();
      expectNoArchiveAffordance();
      expect(screen.queryByText("Archived conversation")).toBeNull();
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it("drops the archived toggle styles while keeping the token-padded filter row", () => {
    expect(chatViewCss).not.toContain("chat-archived-toggle");

    const rowRule = chatViewCss.match(/(?:^|\n)\.chat-sidebar-filter-row\s*\{([^{}]*)\}/)?.[1];
    const tagFilterRule = chatViewCss.match(/(?:^|\n)\.chat-tag-filter\s*\{([^{}]*)\}/)?.[1];

    expect(rowRule).toMatch(/display:\s*flex/);
    expect(rowRule).toMatch(/padding:\s*var\(--space-/);
    expect(tagFilterRule).toContain("flex: 1 1 auto");
    expect(tagFilterRule).not.toMatch(/flex:\s*1\s*;/);
  });
});
