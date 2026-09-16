/*
FNXC:MailboxTwoTabs 2026-09-16-16:53:
FN-464 reduced Mailbox to two tabs (Inbox, Outbox), moved the retired collections behind one header
filter button, relocated the pending-approvals badge onto that trigger and deleted the manual refresh
control. This suite is the residual-shell census for BOTH hosts: it asserts on real code constructs and
rendered behaviour only — never on comments, prose or date stamps.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, act, fireEvent, cleanup } from "@testing-library/react";
import { readAppFile } from "../../test/cssFixture";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import * as apiModule from "../../api";
import * as viewportModule from "../../hooks/useViewportMode";
import * as headerModule from "../Header";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(),
  fetchAllAgentMailbox: vi.fn(), markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(),
  archiveMessage: vi.fn(), unarchiveMessage: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(),
  fetchMessage: vi.fn(), sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(),
  fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(), fetchTaskDetail: vi.fn(),
  createTaskFromRecommendation: vi.fn(), fetchNativeStructurePreview: vi.fn(),
  artifactMediaUrlWithToken: vi.fn((id: string) => `/api/artifacts/${id}/media`),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false,
  isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false,
  MOBILE_MEDIA_QUERY: "(max-width: 768px), (max-height: 480px)",
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));

const MAILBOX_VIEW_SOURCE = "components/MailboxView.tsx";
const MAILBOX_MODAL_SOURCE = "components/MailboxModal.tsx";
const MAILBOX_CSS = "components/MailboxModal.css";

const hostProps = { addToast: vi.fn(), onOpenNativeStructure: vi.fn(), nativeStructureCandidates: [] };

const hosts: Array<[string, (extra?: Record<string, unknown>) => JSX.Element]> = [
  ["MailboxView", (extra = {}) => <MailboxView {...hostProps} {...extra} />],
  ["MailboxModal", (extra = {}) => <MailboxModal isOpen onClose={vi.fn()} agents={[] as never} {...hostProps} {...extra} />],
];

describe("mailbox chrome census (FN-464)", () => {
  beforeEach(() => {
    vi.mocked(apiModule.fetchInbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 } as never);
    vi.mocked(apiModule.fetchOutbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchUnreadCount).mockResolvedValue({ unreadCount: 0, pendingApprovalCount: 0 } as never);
    vi.mocked(apiModule.fetchAgents).mockResolvedValue([] as never);
    vi.mocked(apiModule.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchAgentMailbox).mockResolvedValue({ messages: [], total: 0, inbox: [], outbox: [], unreadCount: 0 } as never);
    vi.mocked(apiModule.fetchApprovals).mockResolvedValue({ requests: [], total: 0, pendingCount: 0 } as never);
    vi.mocked(apiModule.fetchConversation).mockResolvedValue([] as never);
    vi.mocked(viewportModule.useViewportMode).mockReturnValue("desktop");
    vi.mocked(headerModule.useViewportMode).mockReturnValue("desktop");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([MAILBOX_VIEW_SOURCE, MAILBOX_MODAL_SOURCE])("leaves no retired tab, refresh or structural-filter construct in %s", (source) => {
    const code = readAppFile(source);

    for (const retired of [
      "mailbox-refresh",
      "mailbox-tab-archived",
      "mailbox-tab-agents",
      "mailbox-tab-approvals",
      "mailbox-tab-completions",
      "RefreshCw",
      "mailbox.refreshTitle",
      "className=\"mailbox-structural-filter\"",
    ]) {
      expect(code).not.toContain(retired);
    }

    expect(code).toContain("mailbox-inbox-filter");
    /*
    FNXC:MailboxCollectionNavigation 2026-09-16-21:44:
    FN-476 extracted the two-tab presentation into `MailboxCollectionTabs` so both hosts could move it above their
    message list in one place. The census therefore checks that each host still RENDERS that single owner instead of
    re-declaring the markup; the test ids themselves are asserted once, on the component that owns them.
    */
    expect(code).toContain("<MailboxCollectionTabs");
    expect(code).not.toContain("data-testid=\"mailbox-tab-inbox\"");
    expect(code).not.toContain("data-testid=\"mailbox-tab-outbox\"");
  });

  it("garde une unique déclaration partagée des deux onglets de collection", () => {
    const shared = readAppFile("components/MailboxCollectionTabs.tsx");
    expect(shared).toContain("mailbox-tab-inbox");
    expect(shared).toContain("mailbox-tab-outbox");
    expect(shared).toContain("data-testid=\"mailbox-tabs\"");
    // La présentation partagée ne porte aucun contrôleur : les hôtes gardent leur logique métier.
    expect(shared).not.toContain("useState");
    expect(shared).not.toContain("useEffect");
  });

  it("keeps exactly one pending-approvals badge render point, in MailboxView", () => {
    const viewCode = readAppFile(MAILBOX_VIEW_SOURCE);
    const occurrences = viewCode.split("data-testid=\"mailbox-approvals-pending-badge\"").length - 1;
    expect(occurrences).toBe(1);
    // The floating host has no approvals collection and deliberately renders no badge.
    expect(readAppFile(MAILBOX_MODAL_SOURCE)).not.toContain("mailbox-approvals-pending-badge");
  });

  it("keeps the agent sub-tab selectors shared with AgentDetailView and extends the no-shrink rule to the filter", () => {
    const css = readAppFile(MAILBOX_CSS);

    expect(css).toContain(".mailbox-agent-subtabs");
    expect(css).toContain(".mailbox-agent-subtab");

    const noShrinkBlock = css.match(/([^}]*)\{\s*flex-shrink:\s*0;\s*\}/g) ?? [];
    const relevant = noShrinkBlock.find((block) => block.includes(".mailbox-tab .mailbox-tab-badge"));
    expect(relevant).toBeTruthy();
    expect(relevant).toContain(".mailbox-agent-subtab .mailbox-tab-badge");
    expect(relevant).toContain(".mailbox-inbox-filter .mailbox-tab-badge");
    expect(relevant).toContain(".mailbox-inbox-filter .mailbox-inbox-filter-icon");
  });

  it.each(hosts)("renders exactly two tabs and no refresh shell in %s on desktop and mobile", async (_name, Host) => {
    for (const viewport of ["desktop", "mobile"] as const) {
      vi.mocked(viewportModule.useViewportMode).mockReturnValue(viewport);
      vi.mocked(headerModule.useViewportMode).mockReturnValue(viewport);

      await act(async () => {
        render(Host());
      });

      expect(within(screen.getByTestId("mailbox-tabs")).getAllByRole("button")).toHaveLength(2);
      expect(screen.queryByTestId("mailbox-refresh")).toBeNull();

      const header = document.querySelector(".view-header");
      expect(header).toBeTruthy();
      const refreshLabelled = Array.from(header!.querySelectorAll("[title]"))
        .map((node) => node.getAttribute("title") ?? "")
        .filter((title) => /refresh/i.test(title));
      expect(refreshLabelled).toEqual([]);
      // The only remaining btn-icon in the header banner is the modal close control, never a refresh shell.
      for (const iconButton of Array.from(header!.querySelectorAll("button.btn-icon"))) {
        expect(iconButton.getAttribute("data-testid")).toBe("mailbox-close");
      }

      cleanup();
    }
  });

  it("renders the relocated pending-approvals badge inside the MailboxView filter trigger", async () => {
    vi.mocked(apiModule.fetchUnreadCount).mockResolvedValue({ unreadCount: 0, pendingApprovalCount: 7 } as never);

    await act(async () => {
      render(<MailboxView {...hostProps} />);
    });

    const badge = await screen.findByTestId("mailbox-approvals-pending-badge");
    expect(badge).toHaveTextContent("7");
    expect(screen.getByTestId("mailbox-inbox-filter")).toContainElement(badge);
    expect(screen.getAllByTestId("mailbox-approvals-pending-badge")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId("mailbox-inbox-filter"));
    });
    expect(screen.getByTestId("mailbox-inbox-filter-option-approvals-count")).toHaveTextContent("7");
  });
});
