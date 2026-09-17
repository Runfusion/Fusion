import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirmWithCheckbox: async (options?: { checkbox?: { defaultChecked?: boolean } }) => ({ choice: "cancel" as const, checkboxValue: options?.checkbox?.defaultChecked ?? false }), confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));

import { TaskCard } from "../TaskCard";

function task(id: string, legacyValue: boolean | "absent"): Task {
  const base = {
    id,
    title: "Human plan review",
    description: "Review before execution",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-08-28T11:48:00.000Z",
    updatedAt: "2026-08-28T11:48:00.000Z",
  };
  return (legacyValue === "absent"
    ? base
    : { ...base, requirePlanApproval: legacyValue }) as unknown as Task;
}

describe("TaskCard retired plan approval badge", () => {
  it.each([
    ["legacy-true", true],
    ["legacy-false", false],
    ["absent", "absent"],
  ] as const)("renders no badge or empty metadata wrapper for %s", (id, legacyValue) => {
    render(
      <TaskCard
        task={task(id, legacyValue)}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        taskColumnFlags={{ hold: true }}
      />,
    );

    expect(screen.queryByTestId(`plan-approval-badge-card-${id}`)).toBeNull();
    expect(screen.queryByTestId("card-meta-badges")).toBeNull();
  });
});

/*
FNXC:HumanPlanApproval 2026-09-15-23:08:
FN-443 symptom reproduction — the badge lived inside the `.card-meta-badges` wrapper, whose guard only
knew about priority, Fast and oversight. A freshly created armed card has none of those, so the wrapper
never mounted and the operator had NO visible proof the task would wait for their decision. These cases
render the real card: armed alone (the reported symptom), armed beside another badge, and each of the
three visible states. The negative cases keep the inverse invariant — the wrapper is never rendered
empty for a card with no option and no other badge.
*/
const PLAN_REVIEW_PASSED = {
  workflowStepId: "plan-review",
  status: "passed",
  completedAt: "2026-09-15T10:00:00.000Z",
};

function armedTask(overrides: Record<string, unknown> = {}): Task {
  return {
    id: "FN-armed",
    title: "Waits for my decision",
    description: "Requires human plan approval",
    column: "todo",
    status: null,
    dependencies: [],
    steps: [],
    currentStep: 0,
    createdAt: "2026-09-15T09:00:00.000Z",
    updatedAt: "2026-09-15T09:00:00.000Z",
    humanPlanApproval: { enabled: true },
    ...overrides,
  } as unknown as Task;
}

function renderCard(taskValue: Task) {
  return render(
    <TaskCard
      task={taskValue}
      onOpenDetail={vi.fn()}
      addToast={vi.fn()}
      taskColumnFlags={{ hold: true }}
    />,
  );
}

describe("TaskCard human plan approval badge (FN-443)", () => {
  it("renders the badge and its wrapper for an armed card carrying no other badge", () => {
    renderCard(armedTask());

    const badge = screen.getByTestId("card-human-plan-approval-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-state", "armed");
    expect(screen.getByTestId("card-meta-badges")).toBeInTheDocument();
    expect(screen.getByTestId("card-meta-badges")).toContainElement(badge);
  });

  it("renders the badge alongside another metadata badge without disturbing it", () => {
    renderCard(armedTask({ id: "FN-armed-priority", priority: "urgent" }));

    const wrapper = screen.getByTestId("card-meta-badges");
    expect(wrapper).toContainElement(screen.getByTestId("card-human-plan-approval-badge"));
    expect(wrapper.querySelector(".card-priority-badge")).not.toBeNull();
  });

  it.each([
    [
      "armed",
      {},
      "Your plan approval required before execution",
    ],
    [
      "awaiting",
      {
        workflowStepResults: [PLAN_REVIEW_PASSED],
        approvedPlanFingerprint: "fp-1",
      },
      "Awaiting your plan approval",
    ],
    [
      "approved",
      {
        workflowStepResults: [PLAN_REVIEW_PASSED],
        approvedPlanFingerprint: "fp-1",
        humanPlanApproval: {
          enabled: true,
          decision: {
            decision: "approved",
            planningEpisodeId: PLAN_REVIEW_PASSED.completedAt,
            planFingerprint: "fp-1",
          },
        },
      },
      "Plan approved by you",
    ],
  ])("renders the %s state with its own accessible label", (state, overrides, label) => {
    renderCard(armedTask({ id: `FN-${state}`, ...overrides }));

    const badge = screen.getByTestId("card-human-plan-approval-badge");
    expect(badge).toHaveAttribute("data-state", state);
    expect(badge).toHaveAttribute("aria-label", label);
    expect(screen.getByTestId("card-meta-badges")).toContainElement(badge);
  });

  it.each([
    ["option absent", {}],
    ["option disabled", { humanPlanApproval: { enabled: false } }],
  ])("renders neither badge nor wrapper when the option is %s", (_label, overrides) => {
    renderCard(armedTask({ id: "FN-unarmed", humanPlanApproval: undefined, ...overrides }));

    expect(screen.queryByTestId("card-human-plan-approval-badge")).toBeNull();
    expect(screen.queryByTestId("card-meta-badges")).toBeNull();
  });
});
