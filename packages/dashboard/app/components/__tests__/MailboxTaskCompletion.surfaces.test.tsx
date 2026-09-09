import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Message, TaskRecommendation } from "@fusion/core";
import { MailboxView } from "../MailboxView";
import { MailboxModal } from "../MailboxModal";
import { useViewportMode } from "../../hooks/useViewportMode";
import { useViewportMode as useHeaderViewportMode } from "../Header";

vi.mock("../../api", () => ({
  fetchInbox: vi.fn(), fetchOutbox: vi.fn(), fetchUnreadCount: vi.fn(), fetchAgentMailbox: vi.fn(), fetchAllAgentMailbox: vi.fn(),
  markMessageRead: vi.fn(), markAllMessagesRead: vi.fn(), deleteMessage: vi.fn(), fetchConversation: vi.fn(), fetchMessage: vi.fn(),
  sendMessage: vi.fn(), fetchAgents: vi.fn(), fetchApprovals: vi.fn(), fetchApprovalDetail: vi.fn(), decideApproval: vi.fn(),
  fetchTaskDetail: vi.fn(), createTaskFromRecommendation: vi.fn(), fetchNativeStructurePreview: vi.fn(),
  artifactMediaUrlWithToken: vi.fn((id: string, projectId?: string) => `/api/artifacts/${id}/media?projectId=${projectId ?? ""}`),
}));
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: vi.fn(() => "desktop"), isMobileViewport: () => false, isFullScreenSheetViewport: () => false,
  isShortViewport: () => false, getViewportMode: () => "desktop", isTabletTouchViewport: () => false,
}));
vi.mock("../../hooks/useMobileKeyboard", () => ({ useMobileKeyboard: vi.fn(() => ({ keyboardOverlap: 0, viewportHeight: null, viewportOffsetTop: 0, keyboardOpen: false })) }));
vi.mock("../../sse-bus", () => ({ subscribeSse: vi.fn(() => () => {}) }));
vi.mock("../Header", () => ({ useViewportMode: vi.fn(() => "desktop") }));
vi.mock("../ComposeChatPanel", () => ({ ComposeChatPanel: () => null }));
vi.mock("../ArtifactImageViewer", () => ({
  ArtifactImage: ({ artifactId, title, onError }: { artifactId: string; title: string; onError?: () => void }) => (
    <img alt={title} data-artifact-id={artifactId} src={`blob:${artifactId}`} onError={onError} />
  ),
  ArtifactImageViewer: () => null,
}));
vi.mock("lucide-react", () => ({
  Mail: () => null, Send: () => null, Inbox: () => null, Bot: () => null, Trash2: () => null, Archive: () => null,
  CheckCheck: () => null, Loader2: () => null, RefreshCw: () => null, MessageSquare: () => null, User: () => null,
  X: () => null, Check: () => null, ChevronRight: () => null, ChevronDown: () => null, AlertCircle: () => null,
  Map: () => null, Flag: () => null, Lightbulb: () => null, BarChart3: () => null, Target: () => null, CircleAlert: () => null,
}));

import * as api from "../../api";

const agents = [{ id: "agent-1", name: "Agent", role: "executor", state: "idle", createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", metadata: {} }];
const recommendation: TaskRecommendation = { id: "rec-1", title: "Add regression coverage", description: "Cover the remaining completion path.", category: "testability" };

const completion = (id: string, metadata: Record<string, unknown> = {}): Message => ({
  id,
  fromId: "agent-1",
  fromType: "agent",
  toId: "dashboard",
  toType: "user",
  type: "agent-to-user",
  read: true,
  content: `Summary for ${id}`,
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  metadata: {
    kind: "task-completion-notice",
    taskId: "FN-325",
    imageArtifactIds: ["image-1", "image-1", "image-2"],
    recommendationIds: ["rec-1"],
    ...metadata,
  },
});

const ordinary: Message = {
  ...completion("ordinary"),
  content: "Ordinary mailbox message",
  metadata: undefined,
};

const hosts = [
  ["MailboxView", (props: Record<string, unknown>) => <MailboxView {...props} />],
  ["MailboxModal", (props: Record<string, unknown>) => <MailboxModal isOpen onClose={vi.fn()} agents={agents as any} {...props} />],
] as const;

/*
FNXC:MailboxTaskCompletionSurfaces 2026-09-09-20:58:
Completion summaries are a host contract, not only a leaf-component contract. Exercise both Mailbox hosts, both responsive modes, and both selected/conversation placements so image filtering, recommendation actions, and task navigation cannot be disconnected while isolated component tests remain green.
*/
describe("task completion mail production surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
    const message = completion("completion");
    vi.mocked(api.fetchInbox).mockResolvedValue({ messages: [message, ordinary], total: 2, unreadCount: 0 });
    vi.mocked(api.fetchOutbox).mockResolvedValue({ messages: [], total: 0 });
    vi.mocked(api.fetchUnreadCount).mockResolvedValue({ unreadCount: 0 });
    vi.mocked(api.fetchAgents).mockResolvedValue(agents as any);
    vi.mocked(api.fetchAllAgentMailbox).mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });
    vi.mocked(api.fetchConversation).mockResolvedValue([]);
    vi.mocked(api.fetchTaskDetail).mockResolvedValue({ id: "FN-325", recommendations: [recommendation] } as any);
    vi.mocked(api.markMessageRead).mockImplementation(async (_id: string) => message as any);
    vi.mocked(api.createTaskFromRecommendation).mockResolvedValue({ task: { id: "FN-400" } } as any);
  });

  afterEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it.each(hosts)("keeps ordinary messages shell-free in %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<Host projectId="project-1" addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);
    await user.click(await screen.findByTestId("mailbox-item-ordinary"));
    const detail = await screen.findByTestId("mailbox-message-detail");
    expect(within(detail).getByText("Ordinary mailbox message")).toBeInTheDocument();
    expect(within(detail).queryByTestId("mailbox-task-completion")).not.toBeInTheDocument();
    expect(within(detail).queryByTestId("mailbox-view-task")).not.toBeInTheDocument();
  });

  it.each(hosts)("renders empty and unavailable completion states without breaking the summary in %s", async (_name, Host) => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const empty = completion("empty", { imageArtifactIds: undefined, recommendationIds: undefined, taskId: undefined });
    const unavailable = completion("unavailable", { imageArtifactIds: ["missing-image"], recommendationIds: ["missing-rec"] });
    vi.mocked(api.fetchInbox).mockResolvedValue({ messages: [empty, unavailable], total: 2, unreadCount: 0 });
    vi.mocked(api.fetchTaskDetail).mockRejectedValue(new Error("task missing"));
    render(<Host projectId="project-1" addToast={vi.fn()} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);

    await user.click(await screen.findByTestId("mailbox-item-empty"));
    let detail = await screen.findByTestId("mailbox-message-detail");
    expect(within(detail).getByText("Summary for empty")).toBeInTheDocument();
    expect(within(detail).getByTestId("mailbox-task-completion")).toBeEmptyDOMElement();
    expect(within(detail).queryByTestId("mailbox-view-task")).not.toBeInTheDocument();

    const backToList = screen.queryByTestId("mailbox-back-to-list");
    if (backToList) await user.click(backToList);
    await user.click(screen.getByTestId("mailbox-item-unavailable"));
    detail = await screen.findByTestId("mailbox-message-detail");
    expect(within(detail).getByText("Summary for unavailable")).toBeInTheDocument();
    expect(await within(detail).findByTestId("mailbox-task-recommendations-unavailable")).toBeInTheDocument();
    const failedImage = within(detail).getByRole("img", { name: "Completion image" });
    fireEvent.error(failedImage);
    expect(within(detail).queryByRole("img", { name: "Completion image" })).not.toBeInTheDocument();
  });

  it.each([
    ...hosts.flatMap(([name, Host]) => (["desktop", "mobile"] as const).flatMap((viewport) => (["selected", "conversation"] as const).map((pane) => [name, viewport, pane, Host] as const))),
  ])("renders populated completion content in %s %s %s", async (_name, viewport, pane, Host) => {
    vi.mocked(useViewportMode).mockReturnValue(viewport);
    vi.mocked(useHeaderViewportMode).mockReturnValue(viewport);
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const onOpenTask = vi.fn();
    const message = completion("completion");
    if (pane === "conversation") {
      vi.mocked(api.fetchConversation).mockResolvedValue([
        message,
        completion("reply", { replyTo: { messageId: message.id } }),
      ] as any);
    }
    render(<Host projectId="project-1" addToast={vi.fn()} onOpenTask={onOpenTask} onOpenNativeStructure={vi.fn()} nativeStructureCandidates={[]} />);

    await user.click(await screen.findByTestId("mailbox-item-completion"));
    const surface = pane === "conversation"
      ? await screen.findByTestId("mailbox-conversation")
      : await screen.findByTestId("mailbox-message-detail");
    expect(within(surface).getByText("Summary for completion")).toBeInTheDocument();
    const completionCount = pane === "conversation" ? 2 : 1;
    expect(within(surface).getAllByTestId("mailbox-task-completion")).toHaveLength(completionCount);
    expect(within(surface).getAllByRole("img", { name: "Completion image" })).toHaveLength(completionCount * 2);
    expect(within(surface).queryByText("document")).not.toBeInTheDocument();
    expect(await within(surface).findAllByText("Add regression coverage")).toHaveLength(completionCount);
    expect(within(surface).getAllByRole("button", { name: "Create task" })).toHaveLength(completionCount);

    await user.click(within(surface).getAllByRole("button", { name: "View task: FN-325" })[0]);
    expect(onOpenTask).toHaveBeenCalledWith("FN-325");
  });
});
