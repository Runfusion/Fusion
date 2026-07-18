/*
 * FNXC:PlannerOversight 2026-07-04-HH:MM:
 * FN-7516 card-surface tests for the read-only effective oversight-level badge.
 * Covers the Surface Enumeration data states: Observe/Steer/Autonomous render a
 * labeled badge; an explicit "off" effective level renders nothing (no empty
 * shell); an unset per-task override that resolves to the schema default
 * ("autonomous") renders NO badge at all (FN-7539: an inherited default is not
 * meaningfully-configured oversight), while an EXPLICIT per-task override of
 * "autonomous" still renders the badge (explicit intent is preserved).
 * Round-2 code-review fix covered here: when a card must fetch the workflow's
 * effective oversight tier (no synchronous per-task override), the badge does
 * not render until that fetch resolves — the schema default must never render
 * as a guess while the true workflow tier is unknown.
 *
 * FN-7542 removed the sibling active-overseer-state ("Executor") indicator as
 * unwanted per-card noise; see the removal-regression describe block below
 * asserting `card-overseer-state-badge` is gone across the surfaces it used
 * to render on.
 */
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TaskCard, __test_areTaskCardPropsEqual, __test_clearWorkflowOversightEffectiveCache } from "../TaskCard";
import type { Task } from "@fusion/core";
import { fetchWorkflowSettingValues } from "../../api";



vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => null,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    isConnected: true,
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));

vi.mock("../../hooks/useBatchBadgeFetch", () => ({
  getFreshBatchData: vi.fn(() => null),
}));

vi.mock("../../api", () => ({
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  // FNXC:PlannerOversight 2026-07-04-12:30: the FN-7516 code-review fix reads
  // the workflow's effective plannerOversightLevel setting via this route
  // when the workflowBadge prop's workflowId is set (see
  // loadWorkflowOversightEffectiveLevel in TaskCard.tsx). Default resolves an
  // empty effective map (no override).
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }),
}));
/*
FNXC:RuntimeFallbackUI 2026-07-11-00:00:
RuntimeFallbackBadge (commit 0bed997af / FUX-022) calls the shared useToast() hook directly. TaskCard
embeds RuntimeFallbackBadge and this file renders <TaskCard> outside a ToastProvider, so mock the hook
to avoid "useToast must be used within ToastProvider", matching the TaskCard.test.tsx pattern.
*/
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    status: "planning" as Task["status"],
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

function renderCard(
  overrides: Partial<Task> = {},
  cardProps: {
    workflowBadge?: { workflowId: string; workflowName: string; workflowIcon?: string };
    planningWorkflowId?: string | null;
    projectId?: string;
  } = {},
) {
  return render(<TaskCard task={makeTask(overrides)} onOpenDetail={noop} addToast={noop} {...cardProps} />);
}

afterEach(() => {
  vi.clearAllMocks();
  __test_clearWorkflowOversightEffectiveCache();
});

describe("TaskCard effective oversight-level badge (FN-7516)", () => {
  it.each([
    ["observe", "Observe"],
    ["steer", "Steer"],
    ["autonomous", "Auto-recovery"],
  ] as const)("renders the badge for level=%s with the correct label/modifier/testid", (level, label) => {
    renderCard({ plannerOversightLevel: level, column: "todo" });

    const badge = screen.getByTestId("card-oversight-badge");
    expect(badge).toBeTruthy();
    expect(badge.className).toContain(`card-oversight-badge--${level}`);
    expect(badge.textContent).toBe(label);
    expect(badge.getAttribute("title")).toBe(`Oversight: ${label}`);
  });

  it("renders no badge (no empty shell) when the effective level is off", () => {
    renderCard({ plannerOversightLevel: "off", column: "todo" });

    expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
  });

  it("renders no badge (no empty shell) when the level field is undefined and it resolves to the inherited schema default (autonomous) (FN-7539)", () => {
    renderCard({ column: "todo" });

    expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
  });

  it("renders the badge when the level is EXPLICITLY overridden to autonomous (explicit intent preserved) (FN-7539)", () => {
    renderCard({ plannerOversightLevel: "autonomous", column: "todo" });

    const badge = screen.getByTestId("card-oversight-badge");
    expect(badge).toBeTruthy();
    expect(badge.className).toContain("card-oversight-badge--autonomous");
    expect(badge.textContent).toBe("Auto-recovery");
  });

  it("does not render an always-on empty card-meta-badges child for the explicit-off case", () => {
    const { container } = renderCard({ plannerOversightLevel: "off", column: "todo" });

    const metaBadges = container.querySelector(".card-meta-badges");
    // Either the wrapper is entirely absent, or if present for some other
    // reason it must not contain an oversight badge element.
    if (metaBadges) {
      expect(metaBadges.querySelector(".card-oversight-badge")).toBeNull();
    }
  });

  it("does not render an always-on empty card-meta-badges child for the inherited-default case (FN-7539)", () => {
    const { container } = renderCard({ column: "todo" });

    const metaBadges = container.querySelector(".card-meta-badges");
    if (metaBadges) {
      expect(metaBadges.querySelector(".card-oversight-badge")).toBeNull();
    }
  });
});

/*
 * FNXC:PlannerOversight 2026-07-04-HH:MM:
 * FN-7542 removal-regression coverage: `card-overseer-state-badge` must never
 * render again. Every case below is set up with `plannerOversightLevel: "steer"`
 * and a column/state combination that the pre-removal `deriveOverseerCardWatchedStage`
 * code WOULD have resolved to a stage (Executor/Reviewer/Pull request/Merger/
 * Workflow gate), plus the already-nothing-rendered baselines (non-monitorable
 * column, userPaused, off level) to confirm no regression there either.
 */
describe("TaskCard overseer-state badge removed (FN-7542)", () => {
  it.each([
    ["in-progress", {}],
    ["in-review", { reviewState: { source: "reviewer-agent", items: [], addressing: [] } }],
    ["in-review", { prInfo: { number: 1, status: "open" } }],
    [
      "in-review",
      { workflowTransitionNotification: { kind: "manual-merge-hold", column: "in-review", transitionId: "t1", createdAt: "2026-01-01" } },
    ],
    ["in-review", {}],
  ] as const)("renders no overseer-state badge for column=%s state=%o (previously would have shown a stage chip)", (column, stateOverrides) => {
    renderCard({ column, plannerOversightLevel: "steer", ...(stateOverrides as Partial<Task>) });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });

  it("renders no overseer-state badge when paused on a workflow input/approval gate", () => {
    renderCard({
      column: "in-progress",
      plannerOversightLevel: "steer",
      paused: true,
      pausedReason: "workflow-cli-approval:node-1",
    });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });

  it("renders no overseer-state badge when the task is not in a monitorable column (no regression)", () => {
    renderCard({ column: "todo", plannerOversightLevel: "steer" });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });

  it("renders no overseer-state badge when the effective oversight level is off (no regression)", () => {
    renderCard({ column: "in-progress", plannerOversightLevel: "off" });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });

  it("renders no overseer-state badge when the task is user-paused (no regression)", () => {
    renderCard({ column: "in-progress", plannerOversightLevel: "steer", userPaused: true });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });

  it("does not render an empty card-meta-badges shell when the overseer-state chip was the only would-be meta child", () => {
    const { container } = renderCard({ column: "in-progress", plannerOversightLevel: "steer" });

    const metaBadges = container.querySelector(".card-meta-badges");
    // Either the wrapper is entirely absent, or if present for some other
    // reason it must not contain an overseer-state badge element.
    if (metaBadges) {
      expect(metaBadges.querySelector(".card-overseer-state-badge")).toBeNull();
    }
  });
});

describe("TaskCard workflow-effective oversight level (FN-7516 code-review fix)", () => {
  it.each(["in-progress", "in-review"] as const)("hides the stale non-off overseer snapshot and header wrapper when workflow-effective oversight resolves off in %s", async (column) => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "off" },
      effective: { plannerOversightLevel: "off" },
      orphaned: [],
    });

    renderCard(
      {
        column,
        status: undefined,
        plannerOverseerState: {
          state: "watching",
          oversightLevel: "autonomous",
          watchedStage: column === "in-review" ? "reviewer" : "executor",
          signal: "progressing",
          attemptCount: 0,
          attemptLimit: 3,
          pendingConfirmation: false,
          observedAt: 1700000000000,
        },
      },
      { workflowBadge: { workflowId: `wf-stale-snapshot-off-${column}`, workflowName: "Configured Off" } },
    );

    // FNXC:PlannerOversight 2026-07-18-00:00: An inherited workflow's tier is
    // unresolved on first render. The stale runtime snapshot must not leak an
    // Eye badge or header wrapper before the configured-off response arrives.
    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    expect(screen.queryByTestId("card-header-badges")).toBeNull();

    await waitFor(() => {
      expect(fetchWorkflowSettingValues).toHaveBeenCalledWith(`wf-stale-snapshot-off-${column}`, undefined);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
      expect(screen.queryByTestId("card-header-badges")).toBeNull();
    });
  });

  it("resolves the workflow's effective plannerOversightLevel (not the schema default) when no per-task override is set", async () => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "off" },
      effective: { plannerOversightLevel: "off" },
      orphaned: [],
    });

    renderCard({ column: "todo" }, { workflowBadge: { workflowId: "wf-configured-off", workflowName: "Configured Off" } });

    // FNXC:PlannerOversight 2026-07-04-16:00: round-2 code-review fix — the
    // schema default must NOT render transiently before the workflow-tier
    // fetch resolves (a task inheriting a workflow explicitly configured to
    // "off" must never flash "Auto-recovery"). No badge at all should be
    // present immediately after mount, while the fetch is still in flight.
    expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
    await waitFor(() => {
      expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("wf-configured-off", undefined);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
    });
  });

  it("does not render the schema-default badge while the workflow-tier fetch is pending (round-2 code-review fix)", async () => {
    let resolveFetch!: (value: { stored: Record<string, unknown>; effective: Record<string, unknown>; orphaned: unknown[] }) => void;
    vi.mocked(fetchWorkflowSettingValues).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    renderCard({ column: "todo" }, { workflowBadge: { workflowId: "wf-pending", workflowName: "Pending" } });

    // While the fetch is unresolved, no badge should render at all — not even
    // the schema default ("Auto-recovery"). Rendering a guessed default here
    // was the exact bug the second code-review round flagged.
    await waitFor(() => {
      expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("wf-pending", undefined);
    });
    expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();

    // Once the fetch resolves (workflow has no oversight setting → schema
    // default applies), the badge STILL does not render (FN-7539: an
    // inherited default is not meaningfully-configured oversight).
    resolveFetch({ stored: {}, effective: {}, orphaned: [] });
    await waitFor(() => {
      expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
    });
  });

  it("renders a per-task override immediately even while the workflow-tier fetch is pending", async () => {
    vi.mocked(fetchWorkflowSettingValues).mockReturnValueOnce(new Promise(() => {})); // never resolves

    renderCard(
      { column: "todo", plannerOversightLevel: "steer" },
      { workflowBadge: { workflowId: "wf-never-resolves", workflowName: "Never resolves" } },
    );

    // A synchronous per-task override is known from the task payload alone,
    // so it must not wait on the workflow-tier fetch.
    const badge = screen.getByTestId("card-oversight-badge");
    expect(badge.className).toContain("card-oversight-badge--steer");
  });

  it("prefers the per-task override over the workflow's effective level", async () => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "off" },
      effective: { plannerOversightLevel: "off" },
      orphaned: [],
    });

    renderCard({ column: "todo", plannerOversightLevel: "steer" }, { workflowBadge: { workflowId: "wf-configured-off", workflowName: "Configured Off" } });

    const badge = await screen.findByTestId("card-oversight-badge");
    expect(badge.className).toContain("card-oversight-badge--steer");
  });

  it("renders the workflow's effective non-default level (observe) when no per-task override is set", async () => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "observe" },
      effective: { plannerOversightLevel: "observe" },
      orphaned: [],
    });

    renderCard({ column: "todo" }, { workflowBadge: { workflowId: "wf-configured-observe", workflowName: "Configured Observe" } });

    const badge = await screen.findByTestId("card-oversight-badge");
    expect(badge.className).toContain("card-oversight-badge--observe");
  });

  it("renders no badge when the workflow's effective level explicitly resolves to autonomous (equals the inherited default) (FN-7539)", async () => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "autonomous" },
      effective: { plannerOversightLevel: "autonomous" },
      orphaned: [],
    });

    renderCard({ column: "todo" }, { workflowBadge: { workflowId: "wf-configured-autonomous", workflowName: "Configured Autonomous" } });

    await waitFor(() => {
      expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("wf-configured-autonomous", undefined);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
    });
  });
});

/*
 * FNXC:PlannerOversight 2026-07-17-15:50:
 * FN-8251 regression coverage keeps card-level inherited workflow resolution
 * fail-closed. Selected-workflow boards provide `planningWorkflowId` without
 * aggregate `workflowBadge` metadata, so no stale runtime Eye may appear
 * unless the selected workflow's effective oversight is positively active.
 */
describe("TaskCard selected-workflow oversight identity (FN-8251)", () => {
  const staleSnapshot = (column: "in-progress" | "in-review") => ({
    column,
    status: undefined,
    plannerOverseerState: {
      state: "watching" as const,
      oversightLevel: "autonomous" as const,
      watchedStage: column === "in-review" ? "reviewer" as const : "executor" as const,
      signal: "progressing" as const,
      attemptCount: 0,
      attemptLimit: 3,
      pendingConfirmation: false,
      observedAt: 1700000000000,
    },
  });

  it.each(["in-progress", "in-review"] as const)("uses planningWorkflowId and hides the stale eye before and after selected-workflow off resolves in %s", async (column) => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "off" },
      effective: { plannerOversightLevel: "off" },
      orphaned: [],
    });

    renderCard(staleSnapshot(column), { planningWorkflowId: " selected-workflow-off ", projectId: "project-8251" });

    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    expect(screen.queryByTestId("card-header-badges")).toBeNull();
    await waitFor(() => {
      expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("selected-workflow-off", "project-8251");
    });
    await waitFor(() => {
      expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
      expect(screen.queryByTestId("card-header-badges")).toBeNull();
    });
  });

  it.each([
    ["rejected", () => vi.mocked(fetchWorkflowSettingValues).mockRejectedValueOnce(new Error("unavailable"))],
    ["missing", () => vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({ stored: {}, effective: {}, orphaned: [] })],
    ["invalid", () => vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({ stored: {}, effective: { plannerOversightLevel: "unknown" }, orphaned: [] })],
  ])("fails closed after a %s inherited workflow resolution", async (_state, arrange) => {
    arrange();
    renderCard(staleSnapshot("in-progress"), { planningWorkflowId: `workflow-${_state}` });

    await waitFor(() => expect(fetchWorkflowSettingValues).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
      expect(screen.queryByTestId("card-header-badges")).toBeNull();
      expect(screen.queryByLabelText(/overseer/i)).toBeNull();
    });
  });

  it("fails closed without workflow identity but keeps a valid active task override authoritative", () => {
    const { rerender } = renderCard(staleSnapshot("in-progress"));
    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    expect(screen.queryByTestId("card-header-badges")).toBeNull();

    rerender(
      <TaskCard
        task={makeTask({ ...staleSnapshot("in-progress"), plannerOversightLevel: "steer" })}
        onOpenDetail={noop}
        addToast={noop}
      />,
    );
    expect(screen.getByTestId("planner-overseer-state-badge")).toBeTruthy();
  });

  it.each([
    ["aggregate", { workflowBadge: { workflowId: "aggregate-active", workflowName: "Aggregate active" } }],
    ["selected workflow", { planningWorkflowId: "selected-active" }],
  ])("renders the eye only after positively resolved active oversight for %s cards", async (_surface, props) => {
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "steer" },
      effective: { plannerOversightLevel: "steer" },
      orphaned: [],
    });
    renderCard(staleSnapshot("in-progress"), props);

    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    expect(await screen.findByTestId("planner-overseer-state-badge")).toBeTruthy();
  });

  it("re-resolves when the selected workflow identity changes", async () => {
    vi.mocked(fetchWorkflowSettingValues)
      .mockResolvedValueOnce({ stored: { plannerOversightLevel: "off" }, effective: { plannerOversightLevel: "off" }, orphaned: [] })
      .mockResolvedValueOnce({ stored: { plannerOversightLevel: "observe" }, effective: { plannerOversightLevel: "observe" }, orphaned: [] });
    const task = makeTask(staleSnapshot("in-progress"));
    const { rerender } = render(
      <TaskCard task={task} onOpenDetail={noop} addToast={noop} planningWorkflowId="first-workflow" />,
    );

    await waitFor(() => expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("first-workflow", undefined));
    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    rerender(<TaskCard task={task} onOpenDetail={noop} addToast={noop} planningWorkflowId="second-workflow" />);

    await waitFor(() => expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("second-workflow", undefined));
    expect(await screen.findByTestId("planner-overseer-state-badge")).toBeTruthy();
  });

  it("hides the eye synchronously when an active selected workflow changes to an unresolved off workflow", async () => {
    vi.mocked(fetchWorkflowSettingValues)
      .mockResolvedValueOnce({ stored: { plannerOversightLevel: "steer" }, effective: { plannerOversightLevel: "steer" }, orphaned: [] })
      .mockResolvedValueOnce({ stored: { plannerOversightLevel: "off" }, effective: { plannerOversightLevel: "off" }, orphaned: [] });
    const task = makeTask(staleSnapshot("in-progress"));
    const { rerender } = render(
      <TaskCard task={task} onOpenDetail={noop} addToast={noop} planningWorkflowId="active-workflow" />,
    );

    expect(await screen.findByTestId("planner-overseer-state-badge")).toBeTruthy();
    rerender(<TaskCard task={task} onOpenDetail={noop} addToast={noop} planningWorkflowId="off-workflow" />);

    // FNXC:PlannerOversight 2026-07-17-15:50: A useEffect reset is too late:
    // this render must not reuse the prior workflow's active resolution while
    // the selected off workflow is loading.
    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    await waitFor(() => expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("off-workflow", undefined));
    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
  });

  it("keeps selected-workflow suppression at the 375px mobile viewport", async () => {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
    vi.mocked(fetchWorkflowSettingValues).mockResolvedValueOnce({
      stored: { plannerOversightLevel: "off" },
      effective: { plannerOversightLevel: "off" },
      orphaned: [],
    });
    renderCard(staleSnapshot("in-review"), { planningWorkflowId: "mobile-off" });

    await waitFor(() => expect(fetchWorkflowSettingValues).toHaveBeenCalledWith("mobile-off", undefined));
    expect(screen.queryByTestId("planner-overseer-state-badge")).toBeNull();
    expect(screen.queryByTestId("card-header-badges")).toBeNull();
  });
});

/*
 * FNXC:PlannerOversight 2026-07-04-HH:MM:
 * FN-7542 dropped the `pausedReason`/`reviewState`/`workflowTransitionNotification`
 * memo-comparator compares — they existed solely to repaint the now-removed
 * overseer-state badge and none of those fields are read by any other render
 * path in this component. `plannerOversightLevel` and `workflowBadge.workflowId`
 * remain compared for the surviving oversight-level badge.
 */
describe("TaskCard memo comparator — oversight level (FN-7516)", () => {
  it("returns false when task.plannerOversightLevel changes, so the card repaints", () => {
    const base = makeTask({ plannerOversightLevel: "observe" });
    const changed = makeTask({ plannerOversightLevel: "steer" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: base, onOpenDetail: noop, addToast: noop } as any,
        { task: changed, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when workflowBadge.workflowId changes, so the workflow-effective oversight tier re-resolves", () => {
    const task = makeTask({});

    expect(
      __test_areTaskCardPropsEqual(
        { task, workflowBadge: { workflowId: "wf-a", workflowName: "A" }, onOpenDetail: noop, addToast: noop } as any,
        { task, workflowBadge: { workflowId: "wf-b", workflowName: "B" }, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns false when planningWorkflowId changes, so selected-workflow cards re-resolve their effective tier", () => {
    const task = makeTask({});

    expect(
      __test_areTaskCardPropsEqual(
        { task, planningWorkflowId: "wf-a", onOpenDetail: noop, addToast: noop } as any,
        { task, planningWorkflowId: "wf-b", onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(false);
  });

  it("returns true when nothing relevant changes, including plannerOversightLevel", () => {
    const base = makeTask({ plannerOversightLevel: "steer" });
    const same = makeTask({ plannerOversightLevel: "steer" });

    expect(
      __test_areTaskCardPropsEqual(
        { task: base, onOpenDetail: noop, addToast: noop } as any,
        { task: same, onOpenDetail: noop, addToast: noop } as any,
      ),
    ).toBe(true);
  });
});

/*
 * FNXC:PlannerOversight 2026-07-04-19:45:
 * FN-7521 Surface Enumeration requirement: "UI controls ... Desktop AND mobile
 * (@media (max-width: 768px)) breakpoints where the control renders
 * responsively." TaskCard.tsx has no JS-side isMobile/matchMedia branch for
 * the oversight badge or overseer-state indicator — TaskCard.css scales
 * `.card-oversight-badge`/`.card-overseer-state-badge` purely via a
 * `@media (max-width: 768px)` CSS rule (no conditional DOM). This suite
 * proves the invariant that matters for a JS unit test: setting a narrow
 * `window.innerWidth` before render does not suppress the badge/indicator
 * (guarding against a future `isMobile`-gated regression, per the FN-6115→
 * FN-6123 mobile-empty-shell-shell precedent in AGENTS.md), and that the
 * badge is absent under the same narrow viewport exactly when it is absent
 * at desktop width (no accidental mobile-only leftover shell either).
 */
describe("TaskCard oversight badge/indicator — mobile breakpoint (FN-7521, @media max-width: 768px)", () => {
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalInnerWidth, configurable: true });
  });

  function setMobileViewport() {
    Object.defineProperty(window, "innerWidth", { value: 375, configurable: true });
  }

  it.each([
    ["observe", "Observe"],
    ["steer", "Steer"],
    ["autonomous", "Auto-recovery"],
  ] as const)("still renders the badge for level=%s at a 375px mobile viewport", (level, label) => {
    setMobileViewport();
    renderCard({ plannerOversightLevel: level, column: "todo" });

    const badge = screen.getByTestId("card-oversight-badge");
    expect(badge).toBeTruthy();
    expect(badge.className).toContain(`card-oversight-badge--${level}`);
    expect(badge.textContent).toBe(label);
  });

  it("still renders no badge (no empty shell) at a 375px mobile viewport when the effective level is off", () => {
    setMobileViewport();
    renderCard({ plannerOversightLevel: "off", column: "todo" });

    expect(screen.queryByTestId("card-oversight-badge")).toBeNull();
  });

  // FNXC:PlannerOversight 2026-07-04-19:45: FN-7542 (already on main ahead of
  // this branch's fork point) removed the active-overseer-state indicator
  // entirely, so the mobile-breakpoint invariant for it collapses to "never
  // renders, at any viewport" — matching the FN-7542 removal-regression
  // coverage above.
  it("still renders no active-overseer-state indicator at a 375px mobile viewport for a previously-monitorable in-progress task (FN-7542 removal holds on mobile too)", () => {
    setMobileViewport();
    renderCard({ plannerOversightLevel: "autonomous", column: "in-progress" });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });

  it("still renders no indicator at a 375px mobile viewport when the task is not in a monitorable column", () => {
    setMobileViewport();
    renderCard({ plannerOversightLevel: "autonomous", column: "done" });

    expect(screen.queryByTestId("card-overseer-state-badge")).toBeNull();
  });
});
