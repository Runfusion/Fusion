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
import { RightDockExpandModal } from "../RightDockExpandModal";
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
FNXC:ChatSurfaceUnification 2026-09-14-12:57:
One Chat window is launched from the right dock on every wide shell; detached conversations are independent
windows that the global manager may hide without unmounting them. These regressions mount the production
window host, the detached windows, and the shared visibility control together, because the invariant is about
their interaction: one primary host, retained detached state, suspended reads while hidden, and an Escape
owner that ignores globally hidden surfaces.
*/
function UnifiedHostHarness({
  detached = [],
  prefill,
  onSendAsReport,
  onClosePrimary,
}: {
  detached?: ReturnType<typeof detachedEntry>[];
  prefill?: { text: string; nonce: number };
  onSendAsReport?: (content: string) => void;
  onClosePrimary?: () => void;
}) {
  const [primaryOpen, setPrimaryOpen] = useState(true);
  return (
    <DashboardWindowManagerProvider>
      <DashboardWindowManagerScope scopeKey="project-a" />
      <RightDockExpandModal
        viewKey={primaryOpen ? "chat" : null}
        renderProps={renderProps({
          chatComposerPrefill: prefill ?? null,
          onSendAsReport,
          openChatWindows: new Set(detached.map((entry) => entry.session.id)),
        })}
        onClose={() => {
          setPrimaryOpen(false);
          onClosePrimary?.();
        }}
      />
      <PoppedOutChatWindows
        entries={detached}
        projectId="project-a"
        addToast={vi.fn()}
        onClose={vi.fn()}
        onOpenSessionInNewWindow={vi.fn()}
      />
      <footer><DashboardWindowVisibilityToggle /></footer>
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

function primaryChatWindow() {
  return screen.getByTestId("right-dock-expand-modal");
}

async function openCanonicalThread(session: ChatSessionInfo = activeSessionFixture) {
  const primary = primaryChatWindow();
  await waitFor(() => expect(primary.querySelectorAll(".chat-view")).toHaveLength(1));
  fireEvent.click(await within(primary).findByTestId(`chat-session-${session.id}`));
  return within(primary).findByTestId("chat-input");
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
      return originalGetBoundingClientRect.call(this);
    });
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

  it("renders exactly one canonical Chat host that receives the composer prefill", async () => {
    render(<UnifiedHostHarness prefill={{ text: "Analyse cette issue", nonce: 4 }} />);

    const composer = await openCanonicalThread();
    expect(document.querySelectorAll(".chat-view")).toHaveLength(1);
    expect(composer).toHaveValue("Analyse cette issue");
    expect(screen.queryByTestId("chat-modal-close")).toBeNull();
  });

  it("keeps several detached conversations beside the canonical host without any minimized state", async () => {
    render(<UnifiedHostHarness detached={[detachedEntry(activeSessionFixture, 0), detachedEntry(secondSessionFixture, 1)]} />);

    const first = await screen.findByTestId(`floating-window-chat-window-project-a-${activeSessionFixture.id}`);
    const second = screen.getByTestId(`floating-window-chat-window-project-a-${secondSessionFixture.id}`);
    expect(first.style.left).not.toBe(second.style.left);
    expect(document.querySelectorAll('[data-testid^="floating-window-chat-window-"]')).toHaveLength(2);
    expect(document.querySelector("[data-minimized]")).toBeNull();
    expect(screen.queryByRole("button", { name: /minimi/i })).toBeNull();
    await waitFor(() => expect(primaryChatWindow().querySelectorAll(".chat-view")).toHaveLength(1));
  });

  it("closes only the canonical host when a message is handed off as a report", async () => {
    const onClosePrimary = vi.fn();
    render(<UnifiedHostHarness detached={[detachedEntry(secondSessionFixture, 0)]} onSendAsReport={vi.fn()} onClosePrimary={onClosePrimary} />);

    await waitFor(() => expect(primaryChatWindow().querySelectorAll(".chat-view")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("right-dock-expand-close"));

    await waitFor(() => expect(screen.queryByTestId("right-dock-expand-modal")).toBeNull());
    expect(onClosePrimary).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(`floating-window-chat-window-project-a-${secondSessionFixture.id}`)).toBeInTheDocument();
  });

  it("retains hidden Chat windows while suspending their reads, and resumes on restore", async () => {
    render(<UnifiedHostHarness detached={[detachedEntry(secondSessionFixture, 0)]} />);
    const composer = await openCanonicalThread();
    const primary = primaryChatWindow();
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    fireEvent.change(composer, { target: { value: "Brouillon conservé" } });
    markRead.mockClear();

    fireEvent.click(await screen.findByTestId("dashboard-window-visibility-toggle"));

    await waitFor(() => expect(primary).toHaveAttribute("data-dashboard-window-globally-hidden", "true"));
    expect(primary).toBeInTheDocument();
    expect(primary.querySelectorAll(".chat-view")).toHaveLength(1);
    expect(within(primary).getByTestId("chat-input")).toHaveValue("Brouillon conservé");
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
    await waitFor(() => expect(primaryChatWindow()).not.toHaveAttribute("data-dashboard-window-globally-hidden"));
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

  it("exposes no Quick Chat launcher, window, or minimize affordance in any Chat host", async () => {
    render(<UnifiedHostHarness detached={[detachedEntry(secondSessionFixture, 0)]} />);
    await waitFor(() => expect(primaryChatWindow().querySelectorAll(".chat-view")).toHaveLength(1));

    expect(document.querySelector(".quick-chat, .quick-chat-fab, [data-testid^='quick-chat']")).toBeNull();
    expect(screen.queryByTestId("floating-window-chat")).toBeNull();
    expect(screen.queryByLabelText(/quick chat/i)).toBeNull();
  });
});
