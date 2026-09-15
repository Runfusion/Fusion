import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../../api", () => ({
  fetchModels: vi.fn().mockResolvedValue({ models: [], favoriteProviders: [], favoriteModels: [] }),
  fetchSettings: vi.fn().mockResolvedValue({ autoMerge: true, maxConcurrent: 2, maxWorktrees: 4 }),
  fetchGlobalSettings: vi.fn().mockResolvedValue({}),
  fetchTaskDetail: vi.fn(),
  batchUpdateTaskModels: vi.fn(),
  fetchNodes: vi.fn(() => new Promise(() => {})),
  fetchBoardWorkflows: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  rebuildTaskSpec: vi.fn().mockResolvedValue({}),
  refreshPrStatus: vi.fn().mockResolvedValue({}),
  updateTask: vi.fn(),
  api: vi.fn().mockResolvedValue({ sessions: [] }),
}));
vi.mock("../../sse-bus", () => ({ subscribeSse: () => () => {} }));
vi.mock("../QuickEntryBox", () => ({ QuickEntryBox: () => <div data-testid="quick-entry-box" /> }));
vi.mock("../TaskDetailModal", () => ({ TaskDetailContent: () => <div data-testid="task-detail-content" /> }));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn(), confirmWithSelect: vi.fn() }) }));

import { ListView } from "../ListView";
import { ViewLayoutProvider } from "../../context/ViewLayoutContext";
import { writeBoardWorkflowsCache } from "../../utils/boardWorkflowsCache";
import { fetchBoardWorkflows } from "../../api";

const productSources = {
  TaskCard: readAppFile("components/TaskCard.tsx"),
  ListView: readAppFile("components/ListView.tsx"),
  TaskForm: readAppFile("components/TaskForm.tsx"),
  QuickEntryBox: readAppFile("components/QuickEntryBox.tsx"),
  NewTaskModal: readAppFile("components/NewTaskModal.tsx"),
};

describe("retired plan approval UI census", () => {
  it("has zero badge, toggle, task-field, or shield sites in every product component", () => {
    for (const [name, source] of Object.entries(productSources)) {
      /*
      FNXC:HumanPlanApproval 2026-09-15-06:24:
      FN-408 adds a DIFFERENT per-card control (`*-human-plan-approval-*`). The retired FN-234 terms
      are therefore pinned to their exact former ids rather than the loose `plan-approval-toggle`
      substring, which would have matched the new control and turned this census into a false
      positive. Everything FN-234 removed — including the `requirePlanApproval` task field and its
      shield iconography — is still asserted absent.
      */
      for (const retiredTerm of [
        "card-plan-approval-badge",
        "list-plan-approval-badge",
        "plan-approval-badge-",
        "quick-entry-plan-approval-toggle",
        "task-form-plan-approval-toggle",
        "task-form-inline-plan-approval",
        "requirePlanApproval",
        "ShieldCheck",
      ]) {
        expect(source, `${name} still contains ${retiredTerm}`).not.toContain(retiredTerm);
      }
    }
  });

  it("retains the neighboring fast-mode badges and create toggles", () => {
    expect(productSources.TaskCard).toContain("card-execution-mode-badge");
    expect(productSources.ListView).toContain("list-execution-mode-badge");
    expect(productSources.TaskForm).toContain("task-form-inline-fast");
    expect(productSources.QuickEntryBox).toContain("quick-entry-fast-toggle");
    expect(productSources.NewTaskModal).toContain("executionMode={executionMode}");
  });

  /*
  FNXC:HumanPlanApproval 2026-09-15-06:24:
  FN-408 — the per-card human decision affordance must exist on every surface the operator uses:
  both creation hosts and all three board renders. A census that only proves the FN-234 controls are
  gone would happily pass with the new ones missing too.
  */
  it("renders the FN-408 per-card human plan approval affordances on every surface", () => {
    expect(productSources.QuickEntryBox).toContain("quick-entry-human-plan-approval-toggle");
    expect(productSources.TaskForm).toContain("task-form-inline-human-plan-approval");
    expect(productSources.NewTaskModal).toContain("onHumanPlanApprovalChange={setRequiresHumanPlanApproval}");
    expect(productSources.TaskCard).toContain("HumanPlanApprovalBadge");
    // Both ListView renders (mobile cards and the desktop table) must carry the badge.
    expect(productSources.ListView.match(/<HumanPlanApprovalBadge/g) ?? []).toHaveLength(2);
  });
});

/*
FNXC:HumanPlanApproval 2026-09-15-23:08:
FN-443 — the census above only reads component SOURCE. It is a useful structural ratchet, but it could
never have caught FN-443's real defect: on the board card the badge was present in source and still
never reached the screen, because its wrapper's guard did not know about it. These cases therefore
MOUNT the real list at both breakpoints — the mobile compact cards and the desktop table — and assert
the badge for an armed task carrying no other badge, and its absence for an unarmed one.
*/
const TEST_PROJECT_ID = "proj-plan-approval";

const LANE_PAYLOAD = {
  flagEnabled: true,
  defaultWorkflowId: "builtin:coding",
  workflows: [
    {
      id: "builtin:coding",
      name: "Coding",
      columns: [
        { id: "triage", name: "Planning", flags: { intake: true } },
        { id: "todo", name: "Todo", flags: { hold: true } },
        { id: "in-progress", name: "In progress", flags: { countsTowardWip: true } },
        { id: "in-review", name: "In review", flags: { mergeBlocker: true } },
        { id: "done", name: "Done", flags: { complete: true } },
      ],
    },
  ],
  taskWorkflowIds: {},
};

function listTask(id: string, armed: boolean): Task {
  return {
    id,
    title: "Waits for my decision",
    description: "Requires human plan approval",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    paused: false,
    log: [],
    createdAt: "2026-09-15T09:00:00.000Z",
    updatedAt: "2026-09-15T09:00:00.000Z",
    ...(armed ? { humanPlanApproval: { enabled: true } } : {}),
  } as unknown as Task;
}

function mockViewport(kind: "mobile" | "desktop") {
  if (!window.matchMedia) {
    Object.defineProperty(window, "matchMedia", { writable: true, configurable: true, value: vi.fn() });
  }
  Object.defineProperty(window, "innerWidth", { value: kind === "mobile" ? 375 : 1280, configurable: true });
  return vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: kind === "mobile"
      && (query === "(max-width: 768px)" || query === "(max-width: 768px), (max-height: 480px)"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList));
}

function renderList(tasks: Task[]) {
  return render(
    <ViewLayoutProvider projectId={TEST_PROJECT_ID}>
      <ListView
        tasks={tasks}
        onMoveTask={vi.fn()}
        onRetryTask={vi.fn()}
        onDeleteTask={vi.fn()}
        onMergeTask={vi.fn(async () => ({ merged: false }))}
        onResetTask={vi.fn()}
        onDuplicateTask={vi.fn()}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        globalPaused={false}
        onNewTask={vi.fn()}
        projectId={TEST_PROJECT_ID}
      />
    </ViewLayoutProvider>,
  );
}

describe("ListView human plan approval badge real renders (FN-443)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    vi.mocked(fetchBoardWorkflows).mockResolvedValue(LANE_PAYLOAD as never);
    writeBoardWorkflowsCache(TEST_PROJECT_ID, LANE_PAYLOAD as never);
  });

  it.each([
    ["mobile compact cards", "mobile" as const],
    ["desktop table rows", "desktop" as const],
  ])("renders the badge for an armed task with no other badge in %s", (_label, kind) => {
    const viewportSpy = mockViewport(kind);
    try {
      const { container } = renderList([listTask("FN-list-armed", true)]);

      // Prove the intended presentation is the one actually mounted, not the other branch.
      expect(Boolean(container.querySelector("table.list-table"))).toBe(kind === "desktop");

      const badges = screen.getAllByTestId("list-human-plan-approval-badge");
      expect(badges.length).toBeGreaterThan(0);
      expect(badges[0]).toHaveAttribute("data-state", "armed");
    } finally {
      viewportSpy.mockRestore();
    }
  });

  it.each([
    ["mobile compact cards", "mobile" as const],
    ["desktop table rows", "desktop" as const],
  ])("renders no badge for an unarmed task in %s", (_label, kind) => {
    const viewportSpy = mockViewport(kind);
    try {
      renderList([listTask("FN-list-plain", false)]);

      expect(screen.queryByTestId("list-human-plan-approval-badge")).toBeNull();
    } finally {
      viewportSpy.mockRestore();
    }
  });
});
