import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ChatView } from "../ChatView";
import { CHAT_TITLE_SWITCHER_MAX_ITEMS } from "../ChatThreadTitleSwitcher";
import type { ChatSessionInfo } from "../../hooks/useChat";
import { loadAllAppCss, loadStylesCss } from "../../test/cssFixture";
import {
  activeSessionFixture,
  defaultChatState,
  installChatViewEnv,
  mockViewportMode,
  renderWithAct,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

const { markRead } = vi.hoisted(() => ({ markRead: vi.fn() }));

// Factories stay inline: importing the shared harness from a factory creates a TDZ cycle.
vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => false, markRead }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useNavigationHistory")>()),
  useNavigationHistoryContext: () => ({ pushNav: vi.fn(), replaceCurrent: vi.fn() }),
}));
vi.mock("../CustomModelDropdown", () => ({ CustomModelDropdown: () => null }));
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
}));

installChatViewEnv();

function session(id: string, title: string | null = id): ChatSessionInfo {
  return {
    ...activeSessionFixture,
    id,
    title,
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

async function renderDirect(options: {
  sessions?: ChatSessionInfo[];
  activeSession?: ChatSessionInfo;
  floating?: boolean;
  compactLayout?: boolean;
  viewport?: "mobile" | "desktop";
} = {}) {
  const viewportSpy = options.viewport ? mockViewportMode(options.viewport) : undefined;
  const activeSession = options.activeSession ?? session("session-001", "Alpha");
  const sessions = options.sessions ?? [activeSession, session("session-002", "Beta"), session("session-003", "Gamma")];
  const selectSession = vi.fn();
  setupMockChat({
    ...defaultChatState,
    activeSession,
    sessions,
    filteredSessions: sessions,
    messages: [{ id: "message-001", sessionId: activeSession.id, role: "assistant", content: "Hello", createdAt: "2026-08-23T00:00:00.000Z" }],
    selectSession,
  });
  await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} floating={options.floating} compactLayout={options.compactLayout} />);
  await userEvent.click(screen.getByTestId(`chat-session-${activeSession.id}`));
  return { activeSession, sessions, selectSession, restoreViewport: () => viewportSpy?.mockRestore() };
}

async function installAllAppCss() {
  const style = document.createElement("style");
  style.textContent = await loadAllAppCss();
  document.head.append(style);
  return () => style.remove();
}

function nearestPositionedAncestor(element: Element) {
  let ancestor = element.parentElement;
  while (ancestor && getComputedStyle(ancestor).position === "static") ancestor = ancestor.parentElement;
  return ancestor;
}

/*
FNXC:DashboardTests 2026-08-23-16:00:
FN-9198 must measure floating ChatView hosts explicitly because the global ResizeObserver observes
nothing in jsdom. The synchronous width measurement determines floatingNarrow; popped-out windows
share this floating path, so this fixture protects both surfaces without relying on a zero-width rect.
*/
function withFloatingHost(width: number) {
  const originalResizeObserver = globalThis.ResizeObserver;
  const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, width, height: 640, top: 0, right: width, bottom: 640, left: 0, toJSON: () => ({}),
  });

  class MockResizeObserver implements ResizeObserver {
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    readonly disconnect = vi.fn();
    constructor(_callback: ResizeObserverCallback) {}
  }

  globalThis.ResizeObserver = MockResizeObserver;
  return () => {
    globalThis.ResizeObserver = originalResizeObserver;
    rectSpy.mockRestore();
  };
}

async function openTitleSwitcherMenu() {
  await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
  return screen.findByTestId("chat-thread-title-menu");
}

describe("ChatView title switcher", () => {
  it("opens ordered direct conversations and marks the active session", async () => {
    await renderDirect();
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    const menu = await screen.findByTestId("chat-thread-title-menu");
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveAttribute("aria-expanded", "true");
    expect(within(menu).getByTestId("chat-thread-title-menu-item-session-001")).toHaveAttribute("aria-current", "true");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
  });

  it("switches by session id without leaving detail view", async () => {
    const { selectSession } = await renderDirect();
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    await userEvent.click(screen.getByTestId("chat-thread-title-menu-item-session-002"));

    expect(selectSession).toHaveBeenCalledWith("session-002");
    expect(markRead).toHaveBeenCalledWith("direct", "session-002", expect.any(String));
    expect(screen.getByTestId("chat-thread-header-identity")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-thread-title-menu")).not.toBeInTheDocument();
  });

  it("keeps duplicate titles bound to their distinct session ids", async () => {
    const active = session("session-001", "Duplicate");
    const duplicate = session("session-002", "Duplicate");
    const { selectSession } = await renderDirect({ activeSession: active, sessions: [active, duplicate] });
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
    await userEvent.click(screen.getByTestId("chat-thread-title-menu-item-session-002"));

    expect(selectSession).toHaveBeenCalledWith("session-002");
  });

  it("uses the untitled fallback and shows an empty row for a single session", async () => {
    const active = session("session-001", "");
    await renderDirect({ activeSession: active, sessions: [active] });
    expect(screen.getByTestId("chat-thread-title-trigger")).toHaveTextContent("Untitled conversation");
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));

    expect(screen.getByTestId("chat-thread-title-menu-empty")).toHaveTextContent("No other conversations");
    expect(screen.getByTestId("chat-thread-title-menu-all")).toBeInTheDocument();
  });

  it("caps menu rows and returns to the conversation list from All conversations", async () => {
    const sessions = Array.from({ length: CHAT_TITLE_SWITCHER_MAX_ITEMS + 2 }, (_, index) => session(`session-${index}`, `Chat ${index}`));
    await renderDirect({ activeSession: sessions[0], sessions });
    await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));

    expect(screen.getAllByTestId(/chat-thread-title-menu-item-/)).toHaveLength(CHAT_TITLE_SWITCHER_MAX_ITEMS);
    await userEvent.click(screen.getByTestId("chat-thread-title-menu-all"));
    expect(screen.queryByTestId("chat-thread-header-identity")).not.toBeInTheDocument();
  });

  it.each([{ name: "mobile", floating: false, viewport: "mobile" as const }, { name: "narrow", floating: true, viewport: "desktop" as const }])(
    "switches from the $name host",
    async ({ floating, viewport }) => {
      const viewportSpy = mockViewportMode(viewport);
      const { selectSession } = await renderDirect({ floating });
      await userEvent.click(screen.getByTestId("chat-thread-title-trigger"));
      await userEvent.click(screen.getByTestId("chat-thread-title-menu-item-session-002"));
      expect(selectSession).toHaveBeenCalledWith("session-002");
      viewportSpy.mockRestore();
    },
  );

  it.each([
    { name: "mobile", viewport: "mobile" as const },
    { name: "compact dock", compactLayout: true },
    { name: "floating", floating: true, floatingWidth: 560 },
  ])("anchors the menu to the header in the narrow $name host", async ({ viewport, compactLayout, floating, floatingWidth }) => {
    const restoreFloating = floatingWidth ? withFloatingHost(floatingWidth) : undefined;
    const removeCss = await installAllAppCss();
    let restoreViewport: (() => void) | undefined;
    try {
      ({ restoreViewport } = await renderDirect({ viewport, compactLayout, floating }));
      const narrowHost = document.querySelector(".chat-view--narrow");
      expect(narrowHost).toBeTruthy();
      if (floating) expect(document.querySelector(".chat-view--floating.chat-view--narrow")).toBeTruthy();

      const menu = await openTitleSwitcherMenu();
      const header = document.querySelector(".chat-thread-header");
      const thread = document.querySelector(".chat-thread");
      expect(nearestPositionedAncestor(menu)).toBe(header);
      expect(nearestPositionedAncestor(menu)).not.toBe(thread);
      expect(screen.getByTestId("chat-back-btn")).toBeInTheDocument();
      expect(screen.getByTestId("chat-thread-header-identity")).toBeInTheDocument();
      expect(screen.getByTestId("chat-thread-title-trigger")).toBeInTheDocument();
    } finally {
      restoreViewport?.();
      removeCss();
      restoreFloating?.();
    }
  });

  it("keeps wide floating ChatView non-narrow and anchors its menu to the switcher", async () => {
    const restoreFloating = withFloatingHost(1200);
    const removeCss = await installAllAppCss();
    let restoreViewport: (() => void) | undefined;
    try {
      ({ restoreViewport } = await renderDirect({ viewport: "desktop", floating: true }));
      expect(document.querySelector(".chat-view--narrow")).toBeNull();
      const menu = await openTitleSwitcherMenu();
      expect(nearestPositionedAncestor(menu)).toBe(document.querySelector(".chat-thread-title-switcher"));
    } finally {
      restoreViewport?.();
      removeCss();
      restoreFloating();
    }
  });

  it("preserves the desktop switcher anchor and the thread positioning contract", async () => {
    const removeCss = await installAllAppCss();
    let restoreViewport: (() => void) | undefined;
    try {
      ({ restoreViewport } = await renderDirect({ viewport: "desktop" }));
      const menu = await openTitleSwitcherMenu();
      expect(nearestPositionedAncestor(menu)).toBe(document.querySelector(".chat-thread-title-switcher"));
      expect(getComputedStyle(document.querySelector(".chat-thread")!).position).toBe("relative");
    } finally {
      restoreViewport?.();
      removeCss();
    }
  });

  it("anchors the single-session empty menu to the narrow header", async () => {
    const removeCss = await installAllAppCss();
    let restoreViewport: (() => void) | undefined;
    try {
      const active = session("session-001", "Alpha");
      ({ restoreViewport } = await renderDirect({ viewport: "mobile", activeSession: active, sessions: [active] }));
      expect(document.querySelector(".chat-view--narrow")).toBeTruthy();
      const menu = await openTitleSwitcherMenu();
      expect(screen.getByTestId("chat-thread-title-menu-empty")).toBeInTheDocument();
      expect(nearestPositionedAncestor(menu)).toBe(document.querySelector(".chat-thread-header"));
      expect(getComputedStyle(document.querySelector(".chat-thread")!).position).toBe("relative");
    } finally {
      restoreViewport?.();
      removeCss();
    }
  });

  it("defines the focus-ring spacing token without a component fallback", async () => {
    const styles = await loadStylesCss();
    expect(styles).toMatch(/\/\* Spacing Scale \*\/[\s\S]*--space-3xs:\s*2px;/);
    const css = await loadAllAppCss();
    expect(css).not.toContain("var(--space-3xs,");

    expect(css).toMatch(/\.chat-thread-title-trigger:focus-visible\s*\{[^}]*outline:\s*var\(--space-3xs\) solid var\(--accent\);[^}]*outline-offset:\s*var\(--space-3xs\);/);
  });

  it("closes on outside press and Escape, and keyboard selects the first row", async () => {
    const { selectSession } = await renderDirect();
    const trigger = screen.getByTestId("chat-thread-title-trigger");
    await userEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("chat-thread-title-menu")).not.toBeInTheDocument();

    trigger.focus();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(selectSession).toHaveBeenCalledWith("session-001");
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("chat-thread-title-menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps Rooms titles as plain text without a switcher trigger", async () => {
    const activeRoom = { id: "room-001", projectId: "proj-123", slug: "team", name: "Team", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z" };
    setupMockRooms({ rooms: [activeRoom], activeRoom });
    setupMockChat({ ...defaultChatState, sessions: [], filteredSessions: [] });
    await renderWithAct(<ChatView projectId="proj-123" addToast={vi.fn()} experimentalFeatures={{ chatRooms: true }} />);
    await userEvent.click(screen.getByTestId("chat-sidebar-scope-rooms"));
    await userEvent.click(screen.getByTestId("chat-room-item-team"));

    expect(screen.queryByTestId("chat-thread-title-trigger")).not.toBeInTheDocument();
    expect(document.querySelector(".chat-room-thread-header .chat-thread-header-title")).toHaveTextContent("#Team");
  });

  it("preserves title tooltip and both truncation contracts", async () => {
    const longTitle = "A deliberately long conversation title that must stay truncated";
    await renderDirect({ activeSession: session("session-001", longTitle) });
    const trigger = screen.getByTestId("chat-thread-title-trigger");
    expect(trigger).toHaveClass("chat-thread-header-title");
    expect(trigger).toHaveAttribute("title", longTitle);
    expect(document.querySelectorAll("span.chat-thread-header-title")).toHaveLength(0);
    const css = await loadAllAppCss();
    expect(css).toMatch(/\.chat-thread-header-title\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
    expect(css).toMatch(/\.chat-thread-title-text\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/);
  });
});
