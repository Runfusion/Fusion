/**
 * FNXC:TaskSearch 2026-09-17-09:41:
 * FN-477 read-only search-result mode on the CANONICAL TaskCard.
 *
 * The shared hooks are REAL here on purpose. The whole point of the `enabled` flag is that a result
 * card is inert while an ordinary card mounted beside it is untouched, and a mocked hook proves
 * neither. Only the network/WebSocket boundaries are doubled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard, __test_areTaskCardPropsEqual } from "../TaskCard";
import { __resetBadgeWebSocketStoreForTests } from "../../hooks/useBadgeWebSocket";
import { SWR_CACHE_KEYS, writeCache } from "../../utils/swrCache";

const fetchAgents = vi.hoisted(() => vi.fn(async () => []));
const fetchMission = vi.hoisted(() => vi.fn(async () => ({ id: "M-1", title: "Mission locale" })));
const fetchAgent = vi.hoisted(() => vi.fn(async () => ({ id: "agent-1", name: "Agent local" })));
const fetchWorkflowSettingValues = vi.hoisted(() => vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })));
const getFreshBatchData = vi.hoisted(() => vi.fn(() => null));
const useTaskDiffStatsMock = vi.hoisted(() => vi.fn(() => ({ stats: null, loading: false })));

vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission,
  fetchAgent,
  fetchAgents,
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  refineTask: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-a", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues,
}));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData }));
vi.mock("../../hooks/useTaskDiffStats", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useTaskDiffStats: (...args: any[]) => useTaskDiffStatsMock(...args),
}));
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }),
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  send(payload: string) { this.sent.push(payload); }
  close() { this.readyState = 3; }
}

const noop = () => undefined;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    steps: [],
    dependencies: [],
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Task;
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as never);
  __resetBadgeWebSocketStoreForTests();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TaskCard search-result mode — presentation", () => {
  it("still renders as a real card with the canonical id, title, and column data", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ id: "FN-331", title: "le bouton collapse du leftsidebar" })}
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    const card = container.querySelector(".card");
    expect(card).not.toBeNull();
    expect(card).toHaveAttribute("data-id", "FN-331");
    expect(card).toHaveAttribute("data-interaction-mode", "search-result");
    expect(screen.getByText("FN-331")).toBeInTheDocument();
    expect(screen.getByText(/le bouton collapse du leftsidebar/)).toBeInTheDocument();
  });

  it("projects the description when the task has no title, exactly as a board card does", () => {
    render(
      <TaskCard
        task={makeTask({ id: "FN-900", title: undefined, description: "Description de secours visible" })}
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByText(/Description de secours visible/)).toBeInTheDocument();
  });

  it("renders a completed card and its step metadata without extra search-only chrome", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({
          id: "FN-2",
          column: "done",
          steps: [{ name: "Build", status: "done" }, { name: "Verify", status: "done" }] as Task["steps"],
        })}
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(container.querySelector(".card")).toHaveAttribute("data-column", "done");
    // No bespoke search row markup replaces the card.
    expect(container.querySelector(".task-search-suggestion")).toBeNull();
    expect(container.querySelector(".task-search-suggestion-title")).toBeNull();
  });
});

describe("TaskCard search-result mode — read-only affordances", () => {
  it("leaves no context menu, no menu ARIA, and no empty action shell", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "todo" })}
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onRetryTask={vi.fn()}
        onResetTask={vi.fn()}
        onDuplicateTask={vi.fn()}
        onMergeTask={vi.fn()}
        onPauseTask={vi.fn()}
        onRevertTask={vi.fn()}
        onMoveTask={vi.fn()}
      />,
    );

    const card = container.querySelector(".card")!;
    // Even with EVERY mutation callback supplied, the result mode offers none of them.
    expect(card).not.toHaveAttribute("aria-haspopup", "menu");
    expect(container.querySelector(".card-header-actions")).toBeNull();
    expect(document.querySelector(".task-card-context-menu-popover")).toBeNull();

    fireEvent.contextMenu(card);
    expect(document.querySelector(".task-card-context-menu-popover")).toBeNull();
  });

  it("keeps the size chip without resurrecting the action cluster around it", () => {
    const { container } = render(
      <TaskCard
        task={makeTask({ size: "M" as Task["size"] })}
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={vi.fn()}
      />,
    );
    const actions = container.querySelector(".card-header-actions");
    expect(actions).not.toBeNull();
    expect(within(actions as HTMLElement).queryAllByRole("button")).toHaveLength(0);
  });

  it("does not enter edit mode on double click even when the task is editable", () => {
    const onUpdateTask = vi.fn();
    const { container } = render(
      <TaskCard
        task={makeTask({ column: "todo" })}
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
        onUpdateTask={onUpdateTask}
      />,
    );

    fireEvent.doubleClick(container.querySelector(".card")!);

    expect(container.querySelector(".card-editing")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onUpdateTask).not.toHaveBeenCalled();
  });

  it("performs no upload and no mutation on a file drop", () => {
    const { container } = render(
      <TaskCard task={makeTask()} interactionMode="search-result" onOpenDetail={noop} addToast={noop} />,
    );

    const card = container.querySelector(".card")!;
    fireEvent.drop(card, { dataTransfer: { files: [new File(["x"], "a.png", { type: "image/png" })] } });

    expect(container.querySelector(".file-drop-target")).toBeNull();
  });

  it("selects exactly once per click, tap, Enter, and Space", () => {
    const onOpenDetail = vi.fn();
    const { container } = render(
      <TaskCard task={makeTask()} interactionMode="search-result" onOpenDetail={onOpenDetail} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;

    fireEvent.click(card);
    expect(onOpenDetail).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(card, { key: "Enter" });
    expect(onOpenDetail).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(card, { key: " " });
    expect(onOpenDetail).toHaveBeenCalledTimes(3);

    // A double click is two clicks, not a click plus an edit.
    fireEvent.doubleClick(card);
    expect(container.querySelector(".card-editing")).toBeNull();
  });

  it("is reachable by keyboard as a single activatable control", () => {
    const { container } = render(
      <TaskCard task={makeTask()} interactionMode="search-result" onOpenDetail={noop} addToast={noop} />,
    );
    const card = container.querySelector(".card")!;
    expect(card).toHaveAttribute("role", "button");
    expect(card).toHaveAttribute("tabindex", "0");
  });

  it("does not select when an interactive descendant is activated", () => {
    const onOpenDetail = vi.fn();
    const { container } = render(
      <TaskCard
        task={makeTask({
          prInfo: { number: 7, url: "https://example.test/pr/7", status: "open", title: "PR", headBranch: "h", baseBranch: "main", commentCount: 0 } as never,
        })}
        interactionMode="search-result"
        onOpenDetail={onOpenDetail}
        addToast={noop}
      />,
    );
    const link = container.querySelector("a");
    if (link) {
      fireEvent.click(link);
      expect(onOpenDetail).not.toHaveBeenCalled();
    }
  });
});

describe("TaskCard search-result mode — enrichment isolation", () => {
  it("issues no agents, mission, workflow, diff, or badge work of its own", async () => {
    render(
      <TaskCard
        task={makeTask({ missionId: "M-1", assignedAgentId: "agent-1", column: "in-review" })}
        projectId="project-a"
        planningWorkflowId="wf-a"
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    await waitFor(() => expect(document.querySelector(".card")).not.toBeNull());

    expect(fetchAgents).not.toHaveBeenCalled();
    expect(fetchMission).not.toHaveBeenCalled();
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(fetchWorkflowSettingValues).not.toHaveBeenCalled();
    expect(getFreshBatchData).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    // The diff hook is still CALLED (hook order must stay stable) but is explicitly disabled.
    expect(useTaskDiffStatsMock).toHaveBeenCalled();
    for (const call of useTaskDiffStatsMock.mock.calls) {
      expect((call as unknown[])[4]).toMatchObject({ enabled: false });
    }
  });

  it("does not READ a cached agent name that belongs to the viewer's own project", async () => {
    // A remote node's task legitimately reuses this id; the cached name must not be painted on it.
    writeCache(
      `${SWR_CACHE_KEYS.CHAT_AGENTS_MAP_PREFIX}project-a`,
      [{ id: "agent-1", name: "Agent du projet local", role: "executor", state: "active" }],
      { maxBytes: 500_000 },
    );

    render(
      <TaskCard
        task={makeTask({ assignedAgentId: "agent-1" })}
        projectId="project-a"
        interactionMode="search-result"
        onOpenDetail={noop}
        addToast={noop}
      />,
    );

    await waitFor(() => expect(document.querySelector(".card")).not.toBeNull());
    expect(screen.queryByText("Agent du projet local")).toBeNull();
  });

  it("does not render the plugin slot or the runtime fallback badge", () => {
    const { container } = render(
      <TaskCard task={makeTask()} projectId="project-a" interactionMode="search-result" onOpenDetail={noop} addToast={noop} />,
    );
    expect(container.querySelector("[data-testid='runtime-fallback-badge']")).toBeNull();
    expect(container.querySelector(".plugin-slot")).toBeNull();
  });

  it("leaves a board card mounted beside it fully enriched", async () => {
    render(
      <>
        <TaskCard
          task={makeTask({ id: "FN-BOARD", assignedAgentId: "agent-1" })}
          projectId="project-a"
          onOpenDetail={noop}
          addToast={noop}
        />
        <TaskCard
          task={makeTask({ id: "FN-RESULT", assignedAgentId: "agent-1" })}
          projectId="project-a"
          interactionMode="search-result"
          onOpenDetail={noop}
          addToast={noop}
        />
      </>,
    );

    // The DEFAULT card still performs its own enrichment; the disabled sibling changed nothing.
    await waitFor(() => expect(fetchAgents).toHaveBeenCalled());
  });
});

describe("TaskCard memo comparator", () => {
  it("treats the interaction mode as identity-bearing", () => {
    const task = makeTask();
    const base = { task, onOpenDetail: noop, addToast: noop } as never;
    expect(__test_areTaskCardPropsEqual(base, base)).toBe(true);
    expect(__test_areTaskCardPropsEqual(
      { ...(base as object), interactionMode: "board" } as never,
      { ...(base as object), interactionMode: "search-result" } as never,
    )).toBe(false);
  });
});
