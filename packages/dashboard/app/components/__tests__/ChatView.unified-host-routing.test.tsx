import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeTopmostDashboardPopupForShortcut } from "../../App";
import {
  DashboardWindowManagerProvider,
  DashboardWindowManagerScope,
  useDashboardWindowVisibility,
} from "../../context/DashboardWindowManagerContext";
import { DashboardWindowVisibilityToggle } from "../DashboardWindowVisibilityToggle";
import { PoppedOutChatWindows } from "../PoppedOutChatWindows";
import { RightDock } from "../RightDock";
import { usePoppedOutChats } from "../../hooks/usePoppedOutChats";
import type { OverflowViewRenderProps } from "../overflowViewRegistry";
import type { ChatSessionInfo } from "../../hooks/useChat";
import {
  activeSessionFixture,
  installChatViewEnv,
  setupMockChat,
  setupMockRooms,
} from "./ChatView.test-harness";

const markRead = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useChat");
vi.mock("../../hooks/useChatRooms");
vi.mock("../../hooks/useChatUnread", () => ({
  useChatUnread: () => ({ isUnread: () => true, markRead }),
}));
vi.mock("../../hooks/useNavigationHistory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useNavigationHistory")>();
  return { ...actual, useNavigationHistoryContext: () => ({ pushNav: vi.fn(), removeNav: vi.fn() }) };
});
vi.mock("../../api", () => ({
  fetchSettings: vi.fn().mockResolvedValue({}),
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [], defaultProvider: "", defaultModelId: "" }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchDiscoveredSkills: vi.fn().mockResolvedValue([]),
  fetchTasks: vi.fn().mockResolvedValue([]),
  searchFiles: vi.fn().mockResolvedValue({ files: [] }),
  fetchChatSession: vi.fn().mockResolvedValue({ session: { memoryFocus: null } }),
}));

installChatViewEnv();

const secondSessionFixture: ChatSessionInfo = { ...activeSessionFixture, id: "session-002", title: "Deuxième conversation" };

function detachedEntry(session: ChatSessionInfo, cascadeSlot: number) {
  return { projectId: "project-a", session, focusNonce: 1, cascadeSlot };
}

function renderProps(overrides: Partial<OverflowViewRenderProps> = {}): OverflowViewRenderProps {
  return {
    projectId: "project-a",
    addToast: vi.fn(),
    experimentalFeatures: {},
    onOpenSessionInNewWindow: vi.fn(),
    openChatWindows: new Set<string>(),
    ...overrides,
  };
}

/*
FNXC:ChatSurfaceUnification 2026-09-14-17:46:
FN-392: the wide primary Chat host is the right dock's compact conversation LIST, and every conversation lives in its
own detached window. These regressions mount the production dock, the production window owner, the detached windows,
and the shared visibility control together, because the invariant is about their interaction: the list stays in the
panel, a click or creation opens exactly one dedicated window, an external prefill reaches only that window, closing
the primary host leaves detached conversations mounted, and a global hide suspends reads without unmounting anything.
*/
function DockChatHost({
  open,
  onSelectKey = vi.fn(),
  props,
}: {
  open: boolean;
  onSelectKey?: (key: "chat") => void;
  props: OverflowViewRenderProps;
}) {
  return (
    <RightDock
      selectedKey="chat"
      onSelectKey={onSelectKey as never}
      open={open}
      renderProps={props}
      visibilityOptions={{}}
      footerVisible={false}
      pinned={false}
      onTogglePin={vi.fn()}
      onExpand={vi.fn()}
    />
  );
}

function UnifiedHostHarness({
  detached = [],
  onSendAsReport,
  onClosePrimary,
}: {
  detached?: ReturnType<typeof detachedEntry>[];
  onSendAsReport?: (content: string) => void;
  onClosePrimary?: () => void;
}) {
  const [primaryOpen, setPrimaryOpen] = useState(true);
  return (
    <DashboardWindowManagerProvider>
      <DashboardWindowManagerScope scopeKey="project-a" />
      <DockChatHost
        open={primaryOpen}
        props={renderProps({
          onSendAsReport,
          openChatWindows: new Set(detached.map((entry) => entry.session.id)),
        })}
      />
      <button
        type="button"
        data-testid="close-primary-chat-host"
        onClick={() => {
          setPrimaryOpen(false);
          onClosePrimary?.();
        }}
      >
        close dock
      </button>
      <PoppedOutChatWindows
        entries={detached}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
        onSendAsReport={onSendAsReport as never}
      />
      <footer><DashboardWindowVisibilityToggle /></footer>
    </DashboardWindowManagerProvider>
  );
}

/** Production wiring: the dock list delegates conversation identity to the real project-scoped window owner. */
function DockToWindowHarness({ pendingPrefill }: { pendingPrefill?: string }) {
  const chats = usePoppedOutChats();
  const pendingRef = useState(() => ({ current: pendingPrefill }))[0];
  const openSessionInNewWindow = (session: ChatSessionInfo) => {
    const composerPrefill = pendingRef.current;
    pendingRef.current = undefined;
    chats.popOut("project-a", session, composerPrefill ? { composerPrefill } : undefined);
  };
  return (
    <DashboardWindowManagerProvider>
      <DashboardWindowManagerScope scopeKey="project-a" />
      <DockChatHost
        open
        props={renderProps({
          onOpenSessionInNewWindow: openSessionInNewWindow,
          openChatWindows: new Set(chats.entries.map((entry) => entry.session.id)),
        })}
      />
      <PoppedOutChatWindows
        entries={chats.entries}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={chats.close}
        onOpenSessionInNewWindow={openSessionInNewWindow}
      />
      <output data-testid="open-window-count">{chats.entries.length}</output>
    </DashboardWindowManagerProvider>
  );
}

function EscapeOwnershipHarness({ detached }: { detached: ReturnType<typeof detachedEntry>[] }) {
  const visibility = useDashboardWindowVisibility();
  const [closed, setClosed] = useState<string[]>([]);
  return (
    <>
      <PoppedOutChatWindows
        entries={detached}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />
      <footer><DashboardWindowVisibilityToggle /></footer>
      <button
        type="button"
        data-testid="escape-probe"
        onClick={() => {
          closeTopmostDashboardPopupForShortcut(
            {
              poppedOutTaskEntries: [],
              poppedOutChatEntries: detached,
              windowsGloballyHidden: visibility?.hiddenSnapshotActive,
              terminalOpen: false,
              modalClosers: [],
            },
            {
              closePoppedOutTask: vi.fn(),
              closePoppedOutChat: (projectId, sessionId) => setClosed((previous) => [...previous, `${projectId}:${sessionId}`]),
              closeTerminal: vi.fn(),
            },
          );
        }}
      >
        Escape
      </button>
      <output data-testid="escape-closed">{closed.join(",")}</output>
    </>
  );
}

function primaryChatHost() {
  return screen.getByTestId("right-dock-body");
}

function detachedWindow(session: ChatSessionInfo) {
  return screen.getByTestId(`floating-window-chat-window-project-a-${session.id}`);
}

async function clickDockSession(session: ChatSessionInfo = activeSessionFixture) {
  const host = primaryChatHost();
  await waitFor(() => expect(host.querySelectorAll(".chat-view")).toHaveLength(1));
  fireEvent.click(await within(host).findByTestId(`chat-session-${session.id}`));
}

describe("unified Chat host routing", () => {
  beforeEach(() => {
    markRead.mockClear();
    localStorage.clear();
    /*
    The footer control publishes its interactive button into a body layer aligned on the reserved placeholder,
    so jsdom needs a measurable placeholder rectangle and a synchronous ResizeObserver to render it at all.
    */
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() { this.callback([], this as unknown as ResizeObserver); }
      unobserve() {}
      disconnect() {}
    });
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === "dashboard-window-visibility-placeholder") {
        return { left: 1200, top: 764, right: 1280, bottom: 800, width: 80, height: 36, x: 1200, y: 764, toJSON() {} };
      }
      /*
      FN-392: the dock is a measured shell landmark, so jsdom's zero rect would collapse the available window area and
      flatten the cascade this suite asserts. Give it a realistic right-edge rectangle.
      */
      if (this.dataset.testid === "right-dock") {
        return { left: 1500, top: 0, right: 1600, bottom: 900, width: 100, height: 900, x: 1500, y: 0, toJSON() {} };
      }
      return originalGetBoundingClientRect.call(this);
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1600 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 900 });
    setupMockRooms();
    setupMockChat({
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture, secondSessionFixture],
      filteredSessions: [activeSessionFixture, secondSessionFixture],
      messages: [{ id: "message-1", role: "assistant", content: "Réponse", createdAt: "2026-09-14T10:00:00.000Z" }] as never,
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.getElementById("dashboard-window-toggle-root")?.remove();
  });

  it("keeps the conversation list in the dock and opens one dedicated window per conversation", async () => {
    render(<DockToWindowHarness />);

    await clickDockSession();
    await waitFor(() => expect(screen.getByTestId("open-window-count")).toHaveTextContent("1"));
    const first = detachedWindow(activeSessionFixture);
    expect(primaryChatHost().querySelectorAll(".chat-view")).toHaveLength(1);
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();

    // Reopening the same conversation focuses the same window instead of duplicating it.
    await clickDockSession();
    expect(screen.getByTestId("open-window-count")).toHaveTextContent("1");
    expect(detachedWindow(activeSessionFixture)).toBe(first);

    await clickDockSession(secondSessionFixture);
    await waitFor(() => expect(screen.getByTestId("open-window-count")).toHaveTextContent("2"));
    expect(detachedWindow(secondSessionFixture)).toBeInTheDocument();
  });

  it("hands an external composer prefill to the conversation that request opened, never to the dock list", async () => {
    render(<DockToWindowHarness pendingPrefill="Analyse cette issue" />);

    // The list-only dock host owns no composer at all, so the prefill can only land in the opened window.
    expect(within(primaryChatHost()).queryByTestId("chat-input")).toBeNull();

    await clickDockSession();
    const firstComposer = await within(detachedWindow(activeSessionFixture)).findByTestId("chat-input");
    await waitFor(() => expect(firstComposer).toHaveValue("Analyse cette issue"));
    expect(within(primaryChatHost()).queryByTestId("chat-input")).toBeNull();
  });

  it("keeps several detached conversations beside the canonical host without any minimized state", async () => {
    render(<UnifiedHostHarness detached={[detachedEntry(activeSessionFixture, 0), detachedEntry(secondSessionFixture, 1)]} />);

    const first = await screen.findByTestId(`floating-window-chat-window-project-a-${activeSessionFixture.id}`);
    const second = screen.getByTestId(`floating-window-chat-window-project-a-${secondSessionFixture.id}`);
    expect(first.style.left).not.toBe(second.style.left);
    expect(document.querySelectorAll('[data-testid^="floating-window-chat-window-"]')).toHaveLength(2);
    expect(document.querySelector("[data-minimized]")).toBeNull();
    expect(screen.queryByRole("button", { name: /minimi/i })).toBeNull();
    await waitFor(() => expect(primaryChatHost().querySelectorAll(".chat-view")).toHaveLength(1));
  });

  it("closes only the canonical host when a message is handed off as a report", async () => {
    const onClosePrimary = vi.fn();
    render(<UnifiedHostHarness detached={[detachedEntry(secondSessionFixture, 0)]} onSendAsReport={vi.fn()} onClosePrimary={onClosePrimary} />);

    await waitFor(() => expect(primaryChatHost().querySelectorAll(".chat-view")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("close-primary-chat-host"));

    await waitFor(() => expect(screen.queryByTestId("right-dock-body")).toBeNull());
    expect(onClosePrimary).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(`floating-window-chat-window-project-a-${secondSessionFixture.id}`)).toBeInTheDocument();
  });

  it("retains hidden Chat windows while suspending their reads, and resumes on restore", async () => {
    render(<UnifiedHostHarness detached={[detachedEntry(activeSessionFixture, 0), detachedEntry(secondSessionFixture, 1)]} />);
    const conversation = await screen.findByTestId(`floating-window-chat-window-project-a-${activeSessionFixture.id}`);
    const composer = await within(conversation).findByTestId("chat-input");
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    fireEvent.change(composer, { target: { value: "Brouillon conservé" } });
    markRead.mockClear();

    fireEvent.click(await screen.findByTestId("dashboard-window-visibility-toggle"));

    const overlay = screen.getByTestId(`floating-window-overlay-chat-window-project-a-${activeSessionFixture.id}`);
    await waitFor(() => expect(overlay).toHaveAttribute("data-dashboard-window-globally-hidden", "true"));
    expect(conversation).toBeInTheDocument();
    expect(conversation.querySelectorAll(".chat-view")).toHaveLength(1);
    expect(within(conversation).getByTestId("chat-input")).toHaveValue("Brouillon conservé");
    expect(screen.getByTestId(`floating-window-overlay-chat-window-project-a-${secondSessionFixture.id}`)).toHaveAttribute("data-dashboard-window-globally-hidden", "true");

    setupMockChat({
      activeSession: activeSessionFixture,
      sessions: [activeSessionFixture, secondSessionFixture],
      filteredSessions: [activeSessionFixture, secondSessionFixture],
      messages: [
        { id: "message-1", role: "assistant", content: "Réponse", createdAt: "2026-09-14T10:00:00.000Z" },
        { id: "message-2", role: "assistant", content: "Arrivée pendant le masquage", createdAt: "2026-09-14T10:05:00.000Z" },
      ] as never,
    });
    fireEvent.change(composer, { target: { value: "Brouillon conservé et intact" } });
    expect(markRead).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("dashboard-window-visibility-toggle"));
    await waitFor(() => expect(overlay).not.toHaveAttribute("data-dashboard-window-globally-hidden"));
    await waitFor(() => expect(markRead).toHaveBeenCalled());
  });

  it("gives Escape ownership back only when the detached windows are visible", async () => {
    const detached = [detachedEntry(activeSessionFixture, 0)];
    render(
      <DashboardWindowManagerProvider>
        <DashboardWindowManagerScope scopeKey="project-a" />
        <EscapeOwnershipHarness detached={detached} />
      </DashboardWindowManagerProvider>,
    );

    await screen.findByTestId(`floating-window-overlay-chat-window-project-a-${activeSessionFixture.id}`);
    fireEvent.click(await screen.findByTestId("dashboard-window-visibility-toggle"));
    await waitFor(() => expect(screen.getByTestId(`floating-window-overlay-chat-window-project-a-${activeSessionFixture.id}`)).toHaveAttribute("data-dashboard-window-globally-hidden", "true"));

    fireEvent.click(screen.getByTestId("escape-probe"));
    expect(screen.getByTestId("escape-closed")).toHaveTextContent("");

    fireEvent.click(screen.getByTestId("dashboard-window-visibility-toggle"));
    await waitFor(() => expect(screen.getByTestId(`floating-window-overlay-chat-window-project-a-${activeSessionFixture.id}`)).not.toHaveAttribute("data-dashboard-window-globally-hidden"));
    fireEvent.click(screen.getByTestId("escape-probe"));
    expect(screen.getByTestId("escape-closed")).toHaveTextContent(`project-a:${activeSessionFixture.id}`);
  });

  it("exposes no Quick Chat launcher, expanded Chat window, or minimize affordance in any Chat host", async () => {
    render(<UnifiedHostHarness detached={[detachedEntry(secondSessionFixture, 0)]} />);
    await waitFor(() => expect(primaryChatHost().querySelectorAll(".chat-view")).toHaveLength(1));

    expect(document.querySelector(".quick-chat, .quick-chat-fab, [data-testid^='quick-chat']")).toBeNull();
    expect(screen.queryByTestId("floating-window-chat")).toBeNull();
    expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull();
    expect(screen.queryByTestId("right-dock-expand")).toBeNull();
    expect(screen.queryByLabelText(/quick chat/i)).toBeNull();
  });
});
