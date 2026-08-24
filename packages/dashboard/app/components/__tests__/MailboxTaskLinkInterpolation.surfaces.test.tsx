import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import type { Message } from "@fusion/core";
import realEnApp from "../../../../i18n/locales/en/app.json";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useViewportMode as useHeaderViewportMode } from "../Header";

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
  Target: () => null, CircleAlert: () => null, Archive: () => null,
}));

import * as api from "../../api";

const agents = [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z", metadata: {} }];

function message(id: string, metadata: Message["metadata"]): Message {
  return {
    id,
    fromId: "agent-1",
    fromType: "agent",
    toId: "dashboard",
    toType: "user",
    type: "agent-to-user",
    read: true,
    archived: false,
    content: `Mailbox message ${id}`,
    metadata,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  };
}

async function createRealCatalogInstance() {
  const instance = createInstance();
  await instance.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: ["app"],
    defaultNS: "app",
    returnNull: false,
    returnEmptyString: false,
    react: { useSuspense: false },
    interpolation: { escapeValue: false },
    resources: { en: { app: realEnApp } },
  });
  return instance;
}

function Host({ kind, ...props }: { kind: "view" | "modal" } & Record<string, unknown>) {
  return kind === "view"
    ? <MailboxView {...props as any} />
    : <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props as any} />;
}

function renderHost(kind: "view" | "modal", instance: Awaited<ReturnType<typeof createRealCatalogInstance>>, onOpenTask = vi.fn(), onOpenPlanningSession = vi.fn()) {
  return render(
    <I18nextProvider i18n={instance}>
      <Host kind={kind} addToast={vi.fn()} onOpenTask={onOpenTask} onOpenPlanningSession={onOpenPlanningSession} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />
    </I18nextProvider>,
  );
}

/*
 * FNXC:MailboxRelatedWork 2026-08-23-07:58:
 * FN-9194 requires production mailbox hosts to resolve task-link copy through the shipping
 * English catalog. The matrix preserves the visible and accessible task ID across viewport and
 * conversation layouts, where a catalog placeholder mismatch would otherwise reach users.
 */
describe("mailbox task-link interpolation production surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    vi.mocked(api.fetchOutbox).mockResolvedValue({ messages: [], total: 0 });
    vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 0 });
    vi.mocked(api.fetchAgents).mockResolvedValue(agents as any);
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it.each([
    ["view", "desktop", "single"], ["view", "desktop", "threaded"], ["view", "mobile", "single"], ["view", "mobile", "threaded"],
    ["modal", "desktop", "single"], ["modal", "desktop", "threaded"], ["modal", "mobile", "single"], ["modal", "mobile", "threaded"],
  ] as const)("renders the concrete task ID in %s %s %s detail", async (kind, viewport, layout) => {
    vi.mocked(useViewportMode).mockReturnValue(viewport);
    vi.mocked(useHeaderViewportMode).mockReturnValue(viewport);
    const selected = message("task-link", { taskId: "FN-1234" });
    const thread = layout === "threaded"
      ? [message("task-link-parent", {}), { ...selected, metadata: { ...selected.metadata, replyTo: { messageId: "task-link-parent" } } }]
      : [];
    vi.mocked(api.fetchInbox).mockResolvedValue({ messages: [selected], total: 1, unreadCount: 1 });
    vi.mocked(api.fetchConversation).mockResolvedValue(thread as any);
    const instance = await createRealCatalogInstance();
    const onOpenTask = vi.fn();
    const { container } = renderHost(kind, instance, onOpenTask);

    fireEvent.click(await screen.findByTestId("mailbox-item-task-link"));
    const taskLink = await screen.findByTestId("mailbox-view-task");
    expect(taskLink).toHaveTextContent("View task FN-1234");
    expect(taskLink).toHaveAccessibleName("View task: FN-1234");
    expect(container.textContent).not.toContain("{{");
  });

});
