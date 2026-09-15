import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readAppFile } from "../../test/cssFixture";
import { createLucideMock } from "../../test/mockLucide";
import type { Message } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { useViewportMode } from "../../hooks/useViewportMode";

/*
FNXC:MailboxSubject 2026-09-15-04:40:
Symptom being locked out: a mailbox row used to render the raw head of the body, so a completion
notice displayed literally as "## Task completed: FN-325" and no subject existed at all. Every list
and detail surface of both mailbox hosts must now show an AUTHOR and a SUBJECT, with no Markdown
markers leaking into the row and no empty preview shell left behind.
*/

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), archiveMessage: vi.fn(), unarchiveMessage: vi.fn(), deleteMessage: vi.fn(),
  fetchConversation: vi.fn(), fetchMessage: vi.fn(), sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(),
  fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(), fetchTaskDetail: vi.fn(), createTaskFromRecommendation: vi.fn(),
  fetchNativeStructurePreview: vi.fn(),
  artifactMediaUrlWithToken: vi.fn((id: string) => `/api/artifacts/${id}/media`),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false,
  isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("lucide-react", async (importActual) => createLucideMock(importActual as () => Promise<Record<string, unknown>>));

import * as api from "../../api";

const agents = [
  { id: "agent-1", name: "Agent One", role: "executor", state: "idle", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", metadata: {} },
];

const baseMessage = (id: string, overrides: Partial<Message> = {}): Message => ({
  id,
  fromId: "agent-1",
  fromType: "agent",
  toId: "dashboard",
  toType: "user",
  type: "agent-to-user",
  read: true,
  archived: false,
  content: "Plain body",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  ...overrides,
});

/** The FN-414 reproduction: a task completion notice whose body starts with a Markdown heading. */
const completionNotice = (id = "msg-completion"): Message =>
  baseMessage(id, {
    content: "## Task completed: FN-325\n\nDelivered the unified mail.",
    metadata: { kind: "task-completion-notice", taskId: "FN-325" },
  });

const outboxMessage = (id: string, overrides: Partial<Message> = {}): Message =>
  baseMessage(id, { fromId: "dashboard", fromType: "user", toId: "agent-1", toType: "agent", type: "user-to-agent", ...overrides });

const hosts = [
  ["MailboxView", (props: Record<string, unknown>) => <MailboxView {...props} />],
  ["MailboxModal", (props: Record<string, unknown>) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as never} {...props} />],
] as const;

const renderHost = (Host: (props: Record<string, unknown>) => JSX.Element) =>
  render(<Host projectId="project-1" addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);

/** Assert the shared row contract: author present, subject present, no Markdown leakage. */
function expectAuthoredSubjectRow(row: HTMLElement, id: string, subject: string, author: string) {
  expect(within(row).getByTestId(`mailbox-item-subject-${id}`)).toHaveTextContent(subject);
  expect(row.textContent ?? "").toContain(author);
  expect(row.textContent ?? "").not.toContain("##");
  expect(row.textContent ?? "").not.toContain("**");
}

function setInbox(messages: Message[]) {
  vi.mocked(api.fetchInbox).mockResolvedValue({ messages, total: messages.length, unreadCount: 0 } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  vi.mocked(useViewportMode).mockReturnValue("desktop");
  setInbox([completionNotice()]);
  vi.mocked(api.fetchOutbox).mockResolvedValue({ messages: [], total: 0 } as never);
  vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 0 } as never);
  vi.mocked(api.fetchAgents).mockResolvedValue(agents as never);
  vi.mocked(api.fetchApprovals).mockResolvedValue([] as never);
  vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 } as never);
  vi.mocked(api.fetchAgentMailbox).mockResolvedValue({ ownerId: "agent-1", ownerType: "agent", unreadCount: 0, messages: [], inbox: [], outbox: [] } as never);
  vi.mocked(api.fetchConversation).mockResolvedValue([] as never);
  vi.mocked(api.fetchTaskDetail).mockResolvedValue({ id: "FN-325", recommendations: [] } as never);
  vi.mocked(api.markMessageRead).mockResolvedValue(completionNotice() as never);
});

describe("mailbox author + subject surfaces", () => {
  // Cases (b) and (i): inbox list in both hosts, desktop.
  it.each(hosts)("renders author and derived subject in the inbox list of %s", async (_name, Host) => {
    renderHost(Host);
    const row = await screen.findByTestId("mailbox-item-msg-completion");
    expectAuthoredSubjectRow(row, "msg-completion", "FN-325 completed", "Agent One");
    expect(row.textContent).toContain("Delivered the unified mail.");
  });

  // Case (m): the same row on mobile.
  it.each(hosts)("renders author and derived subject on mobile in %s", async (_name, Host) => {
    vi.mocked(useViewportMode).mockReturnValue("mobile");
    renderHost(Host);
    const row = await screen.findByTestId("mailbox-item-msg-completion");
    expectAuthoredSubjectRow(row, "msg-completion", "FN-325 completed", "Agent One");
  });

  // Cases (f) and (k): the message detail of both hosts, plus (r) no Markdown in the subject.
  it.each(hosts)("shows the subject in the message detail of %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(Host);
    await user.click(await screen.findByTestId("mailbox-item-msg-completion"));
    const detail = await screen.findByTestId("mailbox-message-detail");
    expect(within(detail).getByTestId("mailbox-message-detail-subject")).toHaveTextContent("FN-325 completed");
    expect(within(detail).getByText(/From/)).toBeInTheDocument();
  });

  // Cases (a) and (g): archived list in both hosts.
  it.each(hosts)("renders author and subject in the archived list of %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.fetchInbox).mockImplementation((async (filter?: { archived?: boolean }) => {
      const archived = Boolean(filter?.archived);
      const message = archived ? completionNotice("msg-archived") : completionNotice();
      return { messages: [message], total: 1, unreadCount: 0 };
    }) as never);
    renderHost(Host);
    await user.click(await screen.findByTestId("mailbox-tab-archived"));
    const row = await screen.findByTestId("mailbox-item-msg-archived");
    expectAuthoredSubjectRow(row, "msg-archived", "FN-325 completed", "Agent One");
  });

  // Case (c): outbox list in both hosts keeps the recipient label and gains a subject.
  it.each(hosts)("renders recipient and subject in the outbox list of %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.fetchOutbox).mockResolvedValue({
      messages: [outboxMessage("msg-sent", { content: "## Status report\n\nAll green." })],
      total: 1,
    } as never);
    renderHost(Host);
    await user.click(await screen.findByTestId("mailbox-tab-outbox"));
    const row = await screen.findByTestId("mailbox-item-msg-sent");
    expectAuthoredSubjectRow(row, "msg-sent", "Status report", "Agent One");
    expect(row.textContent).toContain("All green.");
  });

  // Cases (d) and (j): the all-agents list in both hosts.
  it.each(hosts)("renders author and subject in the all-agents list of %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({
      messages: [baseMessage("msg-all", { toId: "agent-1", toType: "agent", type: "agent-to-agent", content: "## Handover\n\nPicking it up." })],
      total: 1,
      unreadCount: 0,
    } as never);
    renderHost(Host);
    await user.click(await screen.findByTestId("mailbox-tab-agents"));
    const row = await screen.findByTestId("mailbox-item-msg-all");
    expectAuthoredSubjectRow(row, "msg-all", "Handover", "Agent One");
  });

  // Case (e): the per-agent inbox and outbox lists in both hosts.
  it.each(hosts)("renders author and subject in the per-agent lists of %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.fetchAgentMailbox).mockResolvedValue({
      ownerId: "agent-1",
      ownerType: "agent",
      unreadCount: 0,
      messages: [],
      inbox: [baseMessage("msg-agent-in", { content: "## Please review\n\nDetails inside." })],
      outbox: [outboxMessage("msg-agent-out", { content: "## Review done\n\nShipped." })],
    } as never);
    renderHost(Host);
    await user.click(await screen.findByTestId("mailbox-tab-agents"));
    fireEvent.change(await screen.findByTestId("mailbox-agent-select"), { target: { value: "agent-1" } });

    const inboxRow = await screen.findByTestId("mailbox-item-msg-agent-in");
    expectAuthoredSubjectRow(inboxRow, "msg-agent-in", "Please review", "Agent One");

    await user.click(screen.getByTestId("mailbox-agent-subtab-outbox"));
    const outboxRow = await screen.findByTestId("mailbox-item-msg-agent-out");
    expectAuthoredSubjectRow(outboxRow, "msg-agent-out", "Review done", "Agent One");
  });

  // Case (h): the modal's completions list rendered raw content before FN-414.
  it("renders author and subject in the MailboxModal completions list", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    renderHost(hosts[1][1]);
    await user.click(await screen.findByTestId("mailbox-tab-completions"));
    const row = await within(screen.getByTestId("mailbox-completions-list")).findByTestId("mailbox-item-msg-completion");
    expectAuthoredSubjectRow(row, "msg-completion", "FN-325 completed", "Agent One");
  });

  // Case (n): no metadata at all still yields a Markdown-free subject.
  it.each(hosts)("derives a subject from the body when metadata is absent in %s", async (_name, Host) => {
    setInbox([baseMessage("msg-nometa", { content: "## Task completed: FN-325\n\nDelivered.", metadata: undefined })]);
    renderHost(Host);
    const row = await screen.findByTestId("mailbox-item-msg-nometa");
    expectAuthoredSubjectRow(row, "msg-nometa", "Task completed: FN-325", "Agent One");
  });

  // Case (o): an explicit subject wins; a blank one is ignored.
  it.each(hosts)("prefers an explicit subject and ignores a blank one in %s", async (_name, Host) => {
    setInbox([
      baseMessage("msg-explicit", { content: "Body", metadata: { subject: "Deployment window" } }),
      completionNotice("msg-blank-subject"),
      baseMessage("msg-blank", { content: "Body", metadata: { subject: "   ", kind: "task-completion-notice", taskId: "FN-9" } }),
    ]);
    renderHost(Host);
    expect(await screen.findByTestId("mailbox-item-subject-msg-explicit")).toHaveTextContent("Deployment window");
    expect(screen.getByTestId("mailbox-item-subject-msg-blank")).toHaveTextContent("FN-9 completed");
  });

  // Case (p): an empty or marker-only body falls back to the "(no subject)" label.
  it.each(hosts)("falls back to a no-subject label for an empty body in %s", async (_name, Host) => {
    setInbox([baseMessage("msg-empty", { content: "   \n\n##\n", metadata: undefined })]);
    renderHost(Host);
    expect(await screen.findByTestId("mailbox-item-subject-msg-empty")).toHaveTextContent("(no subject)");
  });

  // Case (q): duplicate subjects still produce two distinct, individually addressable rows.
  it.each(hosts)("keeps duplicate subjects on distinct rows in %s", async (_name, Host) => {
    setInbox([completionNotice("msg-dup-a"), completionNotice("msg-dup-b")]);
    renderHost(Host);
    expect(await screen.findByTestId("mailbox-item-subject-msg-dup-a")).toHaveTextContent("FN-325 completed");
    expect(screen.getByTestId("mailbox-item-subject-msg-dup-b")).toHaveTextContent("FN-325 completed");
    expect(screen.getByTestId("mailbox-item-msg-dup-a")).not.toBe(screen.getByTestId("mailbox-item-msg-dup-b"));
  });

  // Case (t): no empty preview shell is left when the body holds nothing beyond the subject line.
  it.each(hosts)("renders no empty preview element for a single-line body in %s", async (_name, Host) => {
    setInbox([baseMessage("msg-oneline", { content: "Single line body", metadata: undefined })]);
    renderHost(Host);
    const row = await screen.findByTestId("mailbox-item-msg-oneline");
    expect(row.querySelector(".mailbox-item-preview")).toBeNull();
    expect(within(row).getByTestId("mailbox-item-subject-msg-oneline")).toHaveTextContent("Single line body");
  });

  // Case (l): the composer persists an author-written subject, and omits the key when blank.
  it("sends an explicit subject from the composer and omits it when blank", async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.sendMessage).mockResolvedValue({} as never);
    renderHost(hosts[0][1]);
    await user.click(await screen.findByTestId("mailbox-header-compose"));
    fireEvent.change(await screen.findByTestId("message-composer-recipient"), { target: { value: "agent-1" } });
    fireEvent.change(screen.getByTestId("message-composer-subject"), { target: { value: "  Deployment window  " } });
    fireEvent.change(screen.getByTestId("message-composer-content"), { target: { value: "Body text" } });
    await user.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    expect(vi.mocked(api.sendMessage).mock.calls[0][0].metadata).toMatchObject({ subject: "Deployment window" });

    vi.mocked(api.sendMessage).mockClear();
    await user.click(await screen.findByTestId("mailbox-header-compose"));
    fireEvent.change(await screen.findByTestId("message-composer-recipient"), { target: { value: "agent-1" } });
    fireEvent.change(screen.getByTestId("message-composer-content"), { target: { value: "No subject body" } });
    await user.click(screen.getByTestId("message-composer-send"));
    await waitFor(() => expect(api.sendMessage).toHaveBeenCalled());
    expect(vi.mocked(api.sendMessage).mock.calls[0][0].metadata?.subject).toBeUndefined();
  });

  /*
  Case (s): source-structure guard. resolveMailboxMessageSubject is the single source of mailbox
  subjects, so no surface may reintroduce an unresolved body slice.
  */
  it("keeps the raw body-slice preview construct out of every mailbox surface", () => {
    for (const file of ["MailboxView.tsx", "MailboxModal.tsx", "AgentDetailView.tsx"]) {
      const source = readAppFile(`components/${file}`);
      expect(source).not.toContain("content.slice(0, 80)");
      expect(source).toContain("resolveMailboxMessageSubject");
    }
  });
});
