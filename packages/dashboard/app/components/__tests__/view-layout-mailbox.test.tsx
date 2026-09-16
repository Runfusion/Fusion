import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MailboxView } from "../MailboxView";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import * as apiModule from "../../api";
import * as viewportModule from "../../hooks/useViewportMode";
import type { Agent } from "../../api";
import type { Message } from "@fusion/core";

/*
FNXC:StandardizedViewLayout 2026-09-13-22:40:
FN-379 exercises the real Mailbox destination: every tab keeps the shared rail and one canonical Compose entry,
the phone back control routes to the owner that is actually open (message, approval, or composer), and a stale
project response never replaces the current project's list.
*/

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(),
  fetchOutbox: vi.fn(),
  fetchUnreadCount: vi.fn(),
  fetchAgentMailbox: vi.fn(),
  fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(),
  markAllMessagesRead: vi.fn(),
  deleteMessage: vi.fn(),
  fetchConversation: vi.fn(),
  sendMessage: vi.fn(),
  fetchAgents: vi.fn(),
  fetchApprovals: vi.fn(),
  fetchApprovalDetail: vi.fn(),
  decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(() => "/api/artifacts/x/media"),
  artifactMediaUrl: vi.fn(),
  fetchNativeStructurePreview: vi.fn(),
}));

vi.mock("../../hooks/useViewportMode", () => {
  const useViewportMode = vi.fn(() => "desktop");
  return {
    MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
    isFullScreenSheetViewport: () => false,
    isShortViewport: () => false,
    getViewportMode: () => useViewportMode(),
    isMobileViewport: () => useViewportMode() === "mobile",
    isTabletTouchViewport: (mode?: string) => mode === "tablet",
    useViewportMode,
  };
});

vi.mock("../../hooks/useMobileKeyboard", () => ({
  useMobileKeyboard: () => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false }),
}));

vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => undefined) }));

const mockUseViewportMode = vi.mocked(viewportModule.useViewportMode);

const agents: Agent[] = [
  { id: "agent-001", name: "Alpha", role: "executor", state: "idle", createdAt: "2026-01-01", updatedAt: "2026-01-01", metadata: {} } as Agent,
];

function message(id: string, content: string): Message {
  return {
    id,
    fromId: "agent-001",
    fromType: "agent",
    toId: "dashboard",
    toType: "user",
    content,
    type: "agent-to-user",
    read: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as Message;
}

function renderMailbox(projectId = "proj-mail-a") {
  return render(
    <ViewLayoutProvider projectId={projectId}>
      <MailboxView
        projectId={projectId}
        addToast={vi.fn()}
        onOpenNativeStructure={vi.fn()}
        nativeStructureCandidates={[]}
      />
    </ViewLayoutProvider>,
  );
}

describe("FN-379 standardized Mailbox layout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    Element.prototype.scrollIntoView = vi.fn();
    mockUseViewportMode.mockReturnValue("desktop");
    vi.mocked(apiModule.fetchAgents).mockResolvedValue(agents);
    vi.mocked(apiModule.fetchUnreadCount).mockResolvedValue({ unreadCount: 0 } as never);
    vi.mocked(apiModule.fetchApprovals).mockResolvedValue({ requests: [], total: 0, pendingCount: 0 } as never);
    vi.mocked(apiModule.fetchInbox).mockResolvedValue({ messages: [message("msg-1", "First message body")], unreadCount: 0, total: 1 } as never);
    vi.mocked(apiModule.fetchOutbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchAgentMailbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchConversation).mockResolvedValue([] as never);
  });

  /*
  FNXC:MailboxTwoTabs 2026-09-16-16:53:
  Two tabs only, and Compose is the Outbox tab's single header action: the shared rail stays in place for
  every inbox scope, but no scope paints its own Compose control.
  */
  it("keeps the shared rail on every inbox scope and one header Compose on the outbox tab", async () => {
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    expect(within(screen.getByTestId("mailbox-tabs")).getAllByRole("button")).toHaveLength(2);

    for (const scope of ["all", "structural", "archived", "agents", "approvals"]) {
      fireEvent.click(screen.getByTestId("mailbox-inbox-filter"));
      fireEvent.click(screen.getByTestId(`mailbox-inbox-filter-option-${scope}`));
      await waitFor(() => expect(screen.getByTestId("mailbox-split-list-pane")).toBeInTheDocument());
      expect(screen.queryByTestId("mailbox-header-compose")).toBeNull();
    }

    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    await waitFor(() => expect(screen.getByTestId("mailbox-split-list-pane")).toBeInTheDocument());
    const compose = screen.getAllByTestId("mailbox-header-compose");
    expect(compose).toHaveLength(1);
    expect(compose[0]).toHaveClass("view-action-button--create");
    expect(within(screen.getByRole("banner")).getByTestId("mailbox-header-compose")).toBe(compose[0]);
  });

  it("mounts without sending, deleting, or deciding anything", async () => {
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    expect(apiModule.sendMessage).not.toHaveBeenCalled();
    expect(apiModule.deleteMessage).not.toHaveBeenCalled();
    expect(apiModule.decideApproval).not.toHaveBeenCalled();
    expect(apiModule.markAllMessagesRead).not.toHaveBeenCalled();
  });

  it("routes the phone back control to the message owner that is open", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    renderMailbox();
    await waitFor(() => expect(screen.getByText(/First message body/)).toBeInTheDocument());
    expect(screen.queryByTestId("mailbox-back-to-list")).toBeNull();

    fireEvent.click(screen.getByText(/First message body/));
    await waitFor(() => expect(screen.getByTestId("mailbox-message-detail")).toBeInTheDocument());

    const back = screen.getByTestId("mailbox-back-to-list");
    expect(back).toHaveClass("view-back-button");
    expect(within(screen.getByRole("banner")).getByTestId("mailbox-back-to-list")).toBe(back);
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByTestId("mailbox-message-detail")).toBeNull());
  });

  it("routes the phone back control to the composer when composition is open", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    fireEvent.click(await screen.findByTestId("mailbox-header-compose"));
    await waitFor(() => expect(screen.getByTestId("mailbox-back-to-list")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("mailbox-back-to-list"));

    await waitFor(() => expect(screen.queryByTestId("mailbox-back-to-list")).toBeNull());
    expect(apiModule.sendMessage).not.toHaveBeenCalled();
  });

  /*
  FNXC:StandardizedMailboxLayout 2026-09-14-10:24:
  FN-379 remediation: an open composer is hosted content. On both desktop and phone the destination keeps exactly one
  header, that header carries the composer's dynamic identity, and the composer contributes no second header row and no
  second window-style exit.
  */
  it.each(["desktop", "mobile"] as const)("gives the %s composer one header and one abandon control", async (viewport) => {
    mockUseViewportMode.mockReturnValue(viewport);
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    fireEvent.click(await screen.findByTestId("mailbox-header-compose"));
    await waitFor(() => expect(screen.getByTestId("message-composer")).toBeInTheDocument());

    const banners = screen.getAllByRole("banner");
    expect(banners).toHaveLength(1);
    expect(within(banners[0]).getByText("New Message")).toBeInTheDocument();
    expect(document.querySelector(".message-composer-header")).toBeNull();
    expect(screen.queryByTestId("message-composer-cancel")).toBeNull();

    const back = screen.getByTestId("mailbox-back-to-list");
    expect(within(banners[0]).getByTestId("mailbox-back-to-list")).toBe(back);
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByTestId("message-composer")).toBeNull());
    expect(apiModule.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps an empty inbox on the shared rail without a duplicate creation entry", async () => {
    vi.mocked(apiModule.fetchInbox).mockResolvedValue({ messages: [], unreadCount: 0, total: 0 } as never);
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    expect(screen.getByTestId("mailbox-split-list-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("mailbox-header-compose")).toBeNull();
    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    expect(await screen.findAllByTestId("mailbox-header-compose")).toHaveLength(1);
  });

  /*
  FNXC:MailboxCollectionNavigation 2026-09-16-21:44:
  FN-476: Inbox/Outbox select which collection the LIST shows, so they must live in the list rail's own header — not in
  the view header that spans both panes, and not as a full-width row above the whole content. These cases pin the
  physical placement, the single pair, and that switching collections preserves the results and counts.
  */
  it("place l'unique paire d'onglets dans la zone de liste, jamais dans l'en-tête de vue", async () => {
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    const tabs = screen.getByTestId("mailbox-tabs");
    expect(screen.getAllByTestId("mailbox-tabs")).toHaveLength(1);
    expect(within(screen.getByRole("banner")).queryByTestId("mailbox-tabs")).toBeNull();

    const rail = screen.getByTestId("mailbox-split-list-pane");
    expect(rail.contains(tabs)).toBe(true);
    expect(tabs.closest("[data-testid='view-sidebar-header']")).not.toBeNull();
    // Les onglets précèdent la liste qu'ils pilotent.
    const list = within(rail).getByTestId("mailbox-inbox-list");
    expect(tabs.compareDocumentPosition(list)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // Le titre et les actions générales restent dans leur propriétaire.
    expect(within(screen.getByRole("banner")).getByTestId("mailbox-inbox-filter")).toBeTruthy();
  });

  it("conserve résultats, portées et compteurs en passant Outbox puis Inbox", async () => {
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());
    expect(await screen.findByText(/First message body/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("mailbox-tab-outbox"));
    await waitFor(() => expect(screen.getByTestId("mailbox-outbox-list")).toBeInTheDocument());
    expect(screen.getAllByTestId("mailbox-tabs")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("mailbox-tab-inbox"));
    await waitFor(() => expect(screen.getByText(/First message body/)).toBeInTheDocument());
    expect(screen.getAllByTestId("mailbox-tabs")).toHaveLength(1);
    expect(within(screen.getByRole("banner")).queryByTestId("mailbox-tabs")).toBeNull();
  });

  it("sur téléphone, la navigation appartient à la liste et revient avec elle", async () => {
    mockUseViewportMode.mockReturnValue("mobile");
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    expect(screen.getAllByTestId("mailbox-tabs")).toHaveLength(1);
    expect(within(screen.getByRole("banner")).queryByTestId("mailbox-tabs")).toBeNull();

    fireEvent.click(await screen.findByTestId("mailbox-item-msg-1"));
    await waitFor(() => expect(screen.getByTestId("mailbox-message-detail")).toBeInTheDocument());
    // Le détail occupe le panneau unique : aucune barre d'onglets orpheline ne reste affichée.
    expect(screen.queryByTestId("mailbox-tabs")).toBeNull();

    fireEvent.click(screen.getByTestId("mailbox-back-to-list"));
    await waitFor(() => expect(screen.getByTestId("mailbox-tabs")).toBeInTheDocument());
    expect(screen.getAllByTestId("mailbox-tabs")).toHaveLength(1);
  });

  it("expose les onglets au clavier et conserve le focus après le changement", async () => {
    renderMailbox();
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalled());

    const outbox = screen.getByTestId("mailbox-tab-outbox");
    outbox.focus();
    expect(document.activeElement).toBe(outbox);
    fireEvent.click(outbox);
    await waitFor(() => expect(screen.getByTestId("mailbox-outbox-list")).toBeInTheDocument());
    expect(document.activeElement).toBe(screen.getByTestId("mailbox-tab-outbox"));
  });

  it("never lets a slower project-A inbox response replace the project-B list", async () => {
    let resolveA!: (value: unknown) => void;
    vi.mocked(apiModule.fetchInbox).mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }) as never);
    const view = renderMailbox("proj-mail-a");
    await waitFor(() => expect(apiModule.fetchInbox).toHaveBeenCalledTimes(1));

    vi.mocked(apiModule.fetchInbox).mockResolvedValue({ messages: [message("msg-b", "Project B body")], unreadCount: 0, total: 1 } as never);
    view.rerender(
      <ViewLayoutProvider projectId="proj-mail-b">
        <MailboxView
          projectId="proj-mail-b"
          addToast={vi.fn()}
          onOpenNativeStructure={vi.fn()}
          nativeStructureCandidates={[]}
        />
      </ViewLayoutProvider>,
    );
    await waitFor(() => expect(screen.getByText(/Project B body/)).toBeInTheDocument());

    resolveA({ messages: [message("msg-a", "Stale project A body")], unreadCount: 0, total: 1 });
    await Promise.resolve();
    await waitFor(() => expect(screen.getByText(/Project B body/)).toBeInTheDocument());
    expect(screen.queryByText(/Stale project A body/)).toBeNull();
  });
});
