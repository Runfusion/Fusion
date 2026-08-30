import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: new Map(),
    subscribeToBadge: vi.fn(),
    unsubscribeFromBadge: vi.fn(),
  }),
}));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: () => null }));
vi.mock("../../hooks/useToast", () => ({ useOptionalToast: () => null, useToast: () => ({ addToast: vi.fn() }) }));
vi.mock("../RuntimeFallbackBadge", () => ({ RuntimeFallbackBadge: () => null }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { TaskCard } from "../TaskCard";
import { CostBadgeProvider } from "../../context/CostBadgeContext";

const noop = () => {};

function taskWithUsage(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8598",
    title: "Cost badge fixture",
    description: "",
    column: "todo",
    steps: [{ name: "Implement", status: "pending" }] as any,
    awaitingPlanning: false,
    enabledWorkflowSteps: [],
    dependencies: [],
    tokenUsage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_000_000,
      firstUsedAt: "2026-07-19T08:00:00.000Z",
      lastUsedAt: "2026-07-19T08:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-5-mini",
    },
    ...overrides,
  } as Task;
}

describe("TaskCard cost badge", () => {
  it("renders exactly one derived cost badge inside an enabled provider", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true, pricingOverrides: undefined }}>
        <TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );

    const badges = container.querySelectorAll(".card-cost-indicator");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain("$0.25");
    expect(badges[0]).toHaveAttribute("title", "Estimated cost $0.25");
    expect(badges[0]?.closest(".card-promote-cost-row")).toBeNull();
  });

  it("leaves no badge shell when disabled or usage is missing or zero", () => {
    const disabled = render(<TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />);
    expect(disabled.container.querySelector(".card-cost-indicator")).toBeNull();
    disabled.unmount();

    const missing = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={taskWithUsage({ tokenUsage: undefined })} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );
    expect(missing.container.querySelector(".card-cost-indicator")).toBeNull();
    missing.unmount();

    const zero = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={taskWithUsage({ tokenUsage: { ...taskWithUsage().tokenUsage!, totalTokens: 0, inputTokens: 0 } })} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );
    expect(zero.container.querySelector(".card-cost-indicator")).toBeNull();
  });

  it("uses the established footer placement alongside leading files-changed content", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard
          task={taskWithUsage({ column: "in-progress", modifiedFiles: ["packages/dashboard/app/components/TaskCard.tsx"] })}
          onOpenDetail={noop}
          addToast={noop}
        />
      </CostBadgeProvider>,
    );

    const badge = container.querySelector(".card-cost-indicator");
    expect(badge?.closest(".card-footer-row")).not.toBeNull();
    expect(badge?.closest(".card-footer-row-right")).not.toBeNull();
    expect(container.querySelector(".card-promote-cost-row")).toBeNull();
  });

  it.each([1280, 390])("keeps unavailable chips absent at %ipx", (width) => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    try {
      const { container } = render(
        <CostBadgeProvider value={{ enabled: true }}>
          <TaskCard
            task={taskWithUsage({ tokenUsage: { ...taskWithUsage().tokenUsage!, modelProvider: "unknown", modelId: "no-price" } })}
            onOpenDetail={noop}
            addToast={noop}
          />
        </CostBadgeProvider>,
      );
      expect(container.querySelector(".card-cost-indicator")).toBeNull();
      expect(container.querySelector(".card-promote-cost-row")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
    }
  });

  it("keeps the shared card cost chip visible at the mobile breakpoint", () => {
    const css = loadAllAppCss();
    expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-time-indicator\s*,\s*\.card-cost-indicator[\s\S]*?height:\s*var\(--card-chip-height-mobile\)/);
    expect(css).not.toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*?\.card-cost-indicator\s*\{[^}]*display:\s*none/);
  });
});
