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
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));

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
