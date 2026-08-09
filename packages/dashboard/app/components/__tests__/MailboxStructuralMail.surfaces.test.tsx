import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useViewportMode as useHeaderViewportMode } from "../Header";
import { subscribeSse } from "../../sse-bus";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(), fetchMessage: vi.fn(),
  sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(), fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(),
  artifactMediaUrlWithToken: vi.fn(), fetchNativeStructurePreview: vi.fn(),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false,
  isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("lucide-react", () => ({
  Mail: () => null, Send: () => null, Inbox: () => null, Bot: () => null, Trash2: () => null,
  CheckCheck: () => null, Loader2: () => null, RefreshCw: () => null, MessageSquare: () => null,
  User: () => null, X: () => null, Check: () => null, ChevronRight: () => null, ChevronDown: () => null,
  AlertCircle: () => null, Map: () => null, Flag: () => null, Lightbulb: () => null, BarChart3: () => null,
  Target: () => null, CircleAlert: () => null,
}));

import * as api from "../../api";

const report = (id: string, overrides: Partial<Message> = {}): Message => ({
  id, fromId: "agent-1", fromType: "agent", toId: "dashboard", toType: "user", type: "agent-to-user", read: false,
  content: "Report cover message", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z",
  metadata: { mailKind: "report", report: { title: "Release report", sections: [{ heading: "Summary", body: "| A | B |\n| - | - |\n| 1 | 2 |" }] } }, ...overrides,
});
const ordinary = (id: string, explicit = false): Message => ({
  ...report(id), content: "Ordinary message", metadata: explicit ? { mailKind: "message" } : undefined,
});
const approval = (id: string, overrides: Partial<Message> = {}): Message => ({ ...report(id), content: `Approval ${id}`, metadata: { mailKind: "approval", approvalRequestId: id }, ...overrides });
const agents = [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-08-09T00:00:00.000Z", updatedAt: "2026-08-09T00:00:00.000Z", metadata: {} }];
const allSurfaceMessages = () => [
  ordinary("ordinary"), ordinary("explicit-message", true), report("report"),
  report("zero-report", { metadata: { mailKind: "report", report: { title: "Empty report", sections: [] } } }),
  report("embedded-report", { metadata: { mailKind: "report", report: { title: "Embedded report", sections: [{ heading: "Embed", body: "Attached below" }] }, nativeStructures: [{ kind: "task", id: "task-1", label: "Task" }] } as any }),
  approval("approval-pending"), approval("approval-approved"), approval("approval-denied"), approval("approval-completed"), approval("approval-missing"), approval("approval-blank", { metadata: { mailKind: "approval", approvalRequestId: "" } } as any),
];

/**
 * FNXC:StructuralMail 2026-08-09-11:30:
 * Exercise the real mailbox hosts rather than a structural-item-only fixture: list filtering and
 * both selected and conversation body placements are wiring contracts on each live mail surface.
 */
describe("structural mail production surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const messages = allSurfaceMessages();
    vi.mocked(api.fetchInbox).mockResolvedValue({ messages, total: messages.length, unreadCount: 2 });
    vi.mocked(api.fetchOutbox).mockResolvedValue({ messages: [], total: 0 });
    vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 2 });
    vi.mocked(api.fetchAgents).mockResolvedValue(agents as any);
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    vi.mocked(api.fetchConversation).mockResolvedValue(messages as any);
    vi.mocked(api.markMessageRead).mockImplementation(async (id: string) => ({ ...messages.find((message) => message.id === id)!, read: true }) as any);
    vi.mocked(api.fetchApprovalDetail).mockImplementation(async (id: string) => {
      if (id === "approval-missing") throw new Error("missing");
      const status = id.replace("approval-", "") === "pending" ? "pending" : id.replace("approval-", "");
      return { id, status } as any;
    });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it.each([
    ["MailboxView", (props: any) => <MailboxView {...props} />],
    ["MailboxModal", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
  ])("keeps ordinary rows shell-free and filters real %s inbox data", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
    await screen.findByTestId("mailbox-item-report");
    expect(screen.getAllByTestId("mailbox-kind-badge").length).toBeGreaterThan(0);
    expect(screen.getByTestId("mailbox-item-ordinary").querySelector("[data-testid='mailbox-kind-badge']")).toBeNull();
    expect(screen.getByTestId("mailbox-item-explicit-message").querySelector("[data-testid='mailbox-kind-badge']")).toBeNull();
    await user.click(screen.getByTestId("mailbox-structural-filter-structural"));
    expect(screen.queryByTestId("mailbox-item-ordinary")).not.toBeInTheDocument();
    expect(screen.getByTestId("mailbox-item-report")).toBeInTheDocument();
    expect(screen.getByTestId("mailbox-unread-badge")).toHaveTextContent("2");
    await user.click(screen.getByTestId("mailbox-structural-filter-all"));
    expect(screen.getByTestId("mailbox-item-ordinary")).toBeInTheDocument();
  });

  it.each([
    ["MailboxView", (props: any) => <MailboxView {...props} />],
    ["MailboxModal", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
  ])("resets the structural filter when an ordinary deep link arrives in %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
    await screen.findByTestId("mailbox-item-report");
    await user.click(screen.getByTestId("mailbox-structural-filter-structural"));
    expect(screen.queryByTestId("mailbox-item-ordinary")).not.toBeInTheDocument();

    window.history.replaceState({}, "", "?view=mailbox&mailbox-message=ordinary#message-ordinary");
    const refreshedMessages = allSurfaceMessages();
    vi.mocked(api.fetchInbox).mockResolvedValueOnce({ messages: refreshedMessages, total: refreshedMessages.length, unreadCount: 2 });
    await waitFor(() => expect(subscribeSse).toHaveBeenCalled());
    const subscription = vi.mocked(subscribeSse).mock.calls.at(-1)?.[1];
    subscription?.events?.["message:received"]?.();

    await waitFor(() => expect(screen.getByTestId("mailbox-message-detail")).toHaveAttribute("id", expect.stringContaining("ordinary")));
    const backToList = screen.queryByTestId("mailbox-back-to-list");
    if (backToList) await user.click(backToList);
    expect(await screen.findByTestId("mailbox-structural-filter-all")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("mailbox-item-ordinary")).toBeInTheDocument();
  });

  it.each([
    ["MailboxView", "desktop", "selected pane", (props: any) => <MailboxView {...props} />],
    ["MailboxView", "desktop", "conversation pane", (props: any) => <MailboxView {...props} />],
    ["MailboxView", "mobile", "selected pane", (props: any) => <MailboxView {...props} />],
    ["MailboxView", "mobile", "conversation pane", (props: any) => <MailboxView {...props} />],
    ["MailboxModal", "desktop", "selected pane", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
    ["MailboxModal", "desktop", "conversation pane", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
    ["MailboxModal", "mobile", "selected pane", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
    ["MailboxModal", "mobile", "conversation pane", (props: any) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
  ] as const)("renders every structural data state in %s %s %s", async (_name, viewport, pane, Host) => {
    vi.mocked(useViewportMode).mockReturnValue(viewport);
    vi.mocked(useHeaderViewportMode).mockReturnValue(viewport);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    // Mark this structural matrix read so the body-placement assertions are not coupled to the
    // separate unread acknowledgement path (covered by the filter test above).
    const messages = allSurfaceMessages().map((message) => ({ ...message, read: true }));
    // A selected pane deliberately receives a one-message conversation; the conversation-pane cell
    // receives the complete reply thread. This exercises both independently wired body placements.
    const conversationMessages = messages.map((message, index) => index === 0 ? message : {
      ...message,
      metadata: { ...message.metadata, replyTo: { messageId: messages[index - 1].id } },
    });
    vi.mocked(api.fetchConversation).mockResolvedValue(pane === "conversation pane" ? conversationMessages as any : []);
    let mounted = render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);

    await screen.findByTestId("mailbox-item-report");
    if (pane === "conversation pane") {
      await user.click(screen.getByTestId("mailbox-item-ordinary"));
      await waitFor(() => expect(screen.getByTestId("mailbox-conversation")).toBeInTheDocument());

    } else {
      await user.click(screen.getByTestId("mailbox-item-report"));
      await waitFor(() => expect(screen.getByTestId("mailbox-structural-report")).toBeInTheDocument());
    }

    if (pane === "conversation pane") {
      expect(screen.getByTestId("mailbox-conversation")).toBeInTheDocument();
      expect(screen.getAllByText("Release report").length).toBeGreaterThan(0);
      expect(screen.getAllByTestId("mailbox-report-section-body")[0].querySelector("table")).toBeInTheDocument();
      expect(screen.getByText("Empty report")).toBeInTheDocument();
      expect(screen.getByText("Embedded report")).toBeInTheDocument();
      expect(screen.getByTestId("mailbox-native-structure-embeds")).toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("mailbox-inline-approval-approve")).toBeInTheDocument());
      await waitFor(() => expect(screen.getAllByTestId("mailbox-inline-approval-status")).toHaveLength(3));
      await waitFor(() => expect(screen.getAllByTestId("mailbox-approval-unresolvable")).toHaveLength(2));
      expect(screen.getAllByTestId("mailbox-structural-report").length).toBeGreaterThanOrEqual(3);
      return;
    }

    const selectedCases = [
      { id: "report", structural: "report" },
      { id: "zero-report", structural: "report" },
      { id: "embedded-report", structural: "report" },
      { id: "approval-pending", structural: "pending" },
      { id: "approval-approved", structural: "terminal" },
      { id: "approval-denied", structural: "terminal" },
      { id: "approval-completed", structural: "terminal" },
      { id: "approval-missing", structural: "unresolvable" },
      { id: "approval-blank", structural: "unresolvable" },
      { id: "ordinary", structural: "ordinary" },
      { id: "explicit-message", structural: "ordinary" },
    ] as const;

    for (const selected of selectedCases) {
      if (selected.id !== "report") {
        // Fresh hosts prevent a previous asynchronous approval lookup from obscuring the next
        // selected-message assertion while still selecting each state from the real inbox list.
        mounted.unmount();
        mounted = render(<Host addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
        await user.click(await screen.findByTestId(`mailbox-item-${selected.id}`));
      }
      if (selected.structural === "report") {
        expect(screen.getByTestId("mailbox-structural-report")).toBeInTheDocument();
        expect(within(screen.getByTestId("mailbox-message-detail")).getByTestId("mailbox-kind-badge")).toHaveTextContent("Report");
        if (selected.id === "zero-report") expect(screen.getByText("Empty report")).toBeInTheDocument();
        if (selected.id === "embedded-report") expect(screen.getByTestId("mailbox-native-structure-embeds")).toBeInTheDocument();
      } else if (selected.structural === "pending") {
        expect(await screen.findByTestId("mailbox-inline-approval-approve")).toBeInTheDocument();
        expect(screen.getByTestId("mailbox-inline-approval-deny")).toBeInTheDocument();
        expect(within(screen.getByTestId("mailbox-message-detail")).getByTestId("mailbox-kind-badge")).toHaveTextContent("Approval");
      } else if (selected.structural === "terminal") {
        expect(await screen.findByTestId("mailbox-inline-approval-status")).toBeInTheDocument();
        expect(screen.queryByTestId("mailbox-inline-approval-approve")).not.toBeInTheDocument();
        expect(within(screen.getByTestId("mailbox-message-detail")).getByTestId("mailbox-kind-badge")).toHaveTextContent("Approval");
      } else if (selected.structural === "unresolvable") {
        expect(await screen.findByTestId("mailbox-approval-unresolvable")).toBeInTheDocument();
        expect(screen.queryByTestId("mailbox-inline-approval-approve")).not.toBeInTheDocument();
        expect(within(screen.getByTestId("mailbox-message-detail")).getByTestId("mailbox-kind-badge")).toHaveTextContent("Approval");
      } else {
        const detail = screen.getByTestId("mailbox-message-detail");
        expect(within(detail).queryByTestId("mailbox-structural-report")).not.toBeInTheDocument();
        expect(within(detail).queryByTestId("mailbox-kind-badge")).not.toBeInTheDocument();
      }
    }
  });
});
