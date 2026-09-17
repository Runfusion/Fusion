/*
FN-502 symptom verification (second reported symptom). On a phone the Mailbox header actions still rendered their
text label: "Filter" and "Mark all read" kept their wording, were truncated to an ellipsis by
`.mailbox-view--mobile .view-header__actions .btn span`, and crowded the title.

Both hosts now use the shared `ViewActionButton` canon, so the phone presentation is icon-only while the accessible
name is preserved and the pending-approvals badge survives the collapse. Tabs, icon-less collection filters and the
agent `<select>` are deliberately EXEMPT: the canon hides a redundant ACTION label, never a label belonging to a tab,
a list choice or a form control.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { loadAllAppCss } from "../../test/cssFixture";
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

const hostProps = { addToast: vi.fn(), onOpenNativeStructure: vi.fn(), nativeStructureCandidates: [] };

const hosts: Array<[string, () => JSX.Element]> = [
  ["MailboxView", () => <MailboxView {...hostProps} />],
  ["MailboxModal", () => <MailboxModal isOpen onClose={vi.fn()} agents={[] as never} {...hostProps} />],
];

/*
 * jsdom resolves NO `@media` rule through `getComputedStyle` (measured: a `@media (max-width: 768px)` declaration
 * stays at its initial value even with `window.innerWidth = 390`). The phone presentation is therefore proven the
 * same way the canon's own suite proves it: the rendered control carries the collapse class and keeps its accessible
 * name, and the stylesheet is asserted to hide exactly that label in both phone hosts.
 */
function labelIsHiddenOnPhone(css: string): boolean {
  return ["html\\[data-viewport-mode=\"mobile\"\\]", "html:not\\(\\[data-viewport-mode\\]\\)"].every((host) =>
    new RegExp(`${host} \\.view-action-button--mobile-icon-only \\.view-action-button__label\\s*\\{[^}]*clip-path:\\s*inset\\(50%\\)`, "s").test(css));
}

/** The three header ACTIONS covered by the canon, with their accessible names per host. */
const ACTION_NAMES: Record<string, { filter: RegExp; markAllRead: RegExp }> = {
  MailboxView: { filter: /Filter inbox/i, markAllRead: /Mark all read/i },
  MailboxModal: { filter: /Filter inbox/i, markAllRead: /Mark all read/i },
};

function setViewport(mode: "desktop" | "mobile") {
  if (mode === "mobile") document.documentElement.dataset.viewportMode = "mobile";
  else delete document.documentElement.dataset.viewportMode;
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: mode === "mobile" ? 390 : 1280 });
  vi.mocked(viewportModule.useViewportMode).mockReturnValue(mode);
  vi.mocked(headerModule.useViewportMode).mockReturnValue(mode);
}

describe("Mailbox header actions follow the phone icon-only canon (FN-502)", () => {
  let styleEl: HTMLStyleElement;

  beforeEach(() => {
    vi.mocked(apiModule.fetchInbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 3 } as never);
    vi.mocked(apiModule.fetchOutbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchUnreadCount).mockResolvedValue({ unreadCount: 3, pendingApprovalCount: 7 } as never);
    vi.mocked(apiModule.fetchAgents).mockResolvedValue([] as never);
    vi.mocked(apiModule.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0 } as never);
    vi.mocked(apiModule.fetchAgentMailbox).mockResolvedValue({ messages: [], total: 0, inbox: [], outbox: [], unreadCount: 0 } as never);
    vi.mocked(apiModule.fetchApprovals).mockResolvedValue({ requests: [], total: 0, pendingCount: 0 } as never);
    vi.mocked(apiModule.fetchConversation).mockResolvedValue([] as never);
    setViewport("desktop");
    styleEl = document.createElement("style");
    styleEl.textContent = loadAllAppCss();
    document.head.appendChild(styleEl);
  });

  afterEach(() => {
    cleanup();
    styleEl.remove();
    setViewport("desktop");
    vi.clearAllMocks();
  });

  it.each(hosts)("collapses the header actions of %s to icon-only on a phone", async (name, Host) => {
    setViewport("mobile");
    await act(async () => { render(Host()); });

    const filter = screen.getByTestId("mailbox-inbox-filter");
    const markAllRead = screen.getByTestId("mailbox-mark-all-read");

    for (const action of [filter, markAllRead]) {
      expect(action).toHaveClass("view-action-button", "view-action-button--mobile-icon-only");
      expect(action.querySelector("svg")).not.toBeNull();
      const label = action.querySelector<HTMLElement>(".view-action-button__label")!;
      expect(label).not.toBeNull();
      expect(label.textContent).toMatch(/\w/);
    }
    expect(labelIsHiddenOnPhone(loadAllAppCss())).toBe(true);

    // The accessible name is unchanged, so the collapsed control is still reachable by name.
    expect(screen.getByRole("button", { name: ACTION_NAMES[name].filter })).toBe(filter);
    expect(screen.getByRole("button", { name: ACTION_NAMES[name].markAllRead })).toBe(markAllRead);
  });

  it.each(hosts)("keeps the header action labels visible on desktop in %s", async (_name, Host) => {
    setViewport("desktop");
    await act(async () => { render(Host()); });

    const css = loadAllAppCss();
    for (const testId of ["mailbox-inbox-filter", "mailbox-mark-all-read"]) {
      const action = screen.getByTestId(testId);
      expect(action).toHaveClass("view-action-button--mobile-icon-only");
      const label = action.querySelector<HTMLElement>(".view-action-button__label")!;
      expect(label.textContent).toMatch(/\w/);
      expect(getComputedStyle(label).clipPath).not.toBe("inset(50%)");
    }
    /*
     * The collapse is a PHONE presentation: every rule that hides the label is gated behind a phone host selector
     * inside a phone media block, so a desktop (or a short desktop window) keeps its readable labels.
     */
    for (const declaration of css.split(".view-action-button--mobile-icon-only .view-action-button__label").slice(1)) {
      expect(declaration.slice(0, 200)).toContain("clip-path: inset(50%)");
    }
    for (const line of css.split("\n").filter((entry) => entry.includes(".view-action-button--mobile-icon-only"))) {
      expect(line).toMatch(/html(\[data-viewport-mode="mobile"\]|:not\(\[data-viewport-mode\]\))/);
    }
  });

  it.each(hosts)("collapses the Compose action of %s on a phone as well", async (_name, Host) => {
    setViewport("mobile");
    await act(async () => { render(Host()); });

    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-tab-outbox")); });

    const compose = screen.getByTestId("mailbox-header-compose");
    expect(compose).toHaveClass("view-action-button--mobile-icon-only");
    expect(compose.querySelector(".view-action-button__label")).not.toBeNull();
    expect(labelIsHiddenOnPhone(loadAllAppCss())).toBe(true);
  });

  it("keeps the pending-approvals badge rendered and visible once the filter collapses", async () => {
    setViewport("mobile");
    await act(async () => { render(<MailboxView {...hostProps} />); });

    const badge = await screen.findByTestId("mailbox-approvals-pending-badge");
    expect(badge).toHaveTextContent("7");
    expect(screen.getAllByTestId("mailbox-approvals-pending-badge")).toHaveLength(1);

    const filter = screen.getByTestId("mailbox-inbox-filter");
    expect(filter).toContainElement(badge);
    expect(filter).toHaveClass("view-action-button--mobile-icon-only");
    // The badge is a sibling of the hidden label, never inside it, so it survives the collapse.
    expect(badge.closest(".view-action-button__label")).toBeNull();
    expect(badge.parentElement).toHaveClass("view-action-button__badge");
    expect(badge.parentElement!.previousElementSibling).toHaveClass("view-action-button__label");

    const css = loadAllAppCss();
    for (const host of ["html\\[data-viewport-mode=\"mobile\"\\]", "html:not\\(\\[data-viewport-mode\\]\\)"]) {
      expect(new RegExp(`${host} \\.view-action-button--mobile-icon-only \\.view-action-button__badge\\s*\\{[^}]*position:\\s*absolute`, "s").test(css)).toBe(true);
    }
  });

  /*
  Exempt controls (section F of the task's Surface Enumeration): collection tabs and the icon-less approval filters
  are choices, not actions. Collapsing an icon-less control would leave a visually empty touch target, which
  `ViewActionButton` refuses by construction.
  */
  it("keeps tabs and icon-less collection filters labelled on a phone", async () => {
    setViewport("mobile");
    await act(async () => { render(<MailboxView {...hostProps} />); });

    for (const testId of ["mailbox-tab-inbox", "mailbox-tab-outbox"]) {
      const tab = screen.getByTestId(testId);
      expect(tab).not.toHaveClass("view-action-button--mobile-icon-only");
      expect(tab.textContent).toMatch(/\w/);
    }

    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-inbox-filter")); });
    await act(async () => { fireEvent.click(screen.getByTestId("mailbox-inbox-filter-option-approvals")); });

    for (const testId of ["mailbox-approval-filter-pending", "mailbox-approval-filter-history"]) {
      const filter = screen.getByTestId(testId);
      expect(filter).not.toHaveClass("view-action-button--mobile-icon-only");
      expect(filter.querySelector("svg")).toBeNull();
      expect(filter.textContent).toMatch(/\w/);
    }
  });

  it("no longer truncates a header action label to an ellipsis on a phone", () => {
    const css = loadAllAppCss();
    expect(css).not.toContain(".mailbox-view--mobile .view-header__actions .btn span");
    expect(css).not.toMatch(/\.mailbox-view--mobile \.view-header__actions \.btn\s*\{/);
    // The exempt collection controls keep their compression and truncation.
    expect(css).toContain(".mailbox-view--mobile .view-header__actions .mailbox-agent-subtab");
  });
});
