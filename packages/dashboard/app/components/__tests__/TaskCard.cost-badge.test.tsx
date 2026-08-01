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
    steps: [],
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
  it("renders exactly one derived cost badge for a slim-payload-compatible task inside an enabled provider", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true, pricingOverrides: undefined }}>
        <TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );

    const badges = container.querySelectorAll(".card-cost-indicator");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toContain("$0.25");
    expect(badges[0]).toHaveAttribute("title", "Estimated cost $0.25");
  });

  it("leaves no badge shell when disabled or when usage is missing or zero", () => {
    const disabled = render(<TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />);
    expect(disabled.container.querySelector(".card-cost-indicator")).toBeNull();
    disabled.unmount();

    const missing = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={taskWithUsage({ tokenUsage: undefined })} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );
    expect(missing.container.querySelector(".card-cost-indicator")).toBeNull();
    expect(missing.container.querySelector(".card-cost-indicator[aria-label]")).toBeNull();
    missing.unmount();

    const zero = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={taskWithUsage({ tokenUsage: { ...taskWithUsage().tokenUsage!, totalTokens: 0, inputTokens: 0 } })} onOpenDetail={noop} addToast={noop} />
      </CostBadgeProvider>,
    );
    expect(zero.container.querySelector(".card-cost-indicator")).toBeNull();
  });

  it("renders once alongside leading files-changed footer content", () => {
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard
          task={taskWithUsage({ column: "in-progress", modifiedFiles: ["packages/dashboard/app/components/TaskCard.tsx"] })}
          onOpenDetail={noop}
          addToast={noop}
        />
      </CostBadgeProvider>,
    );

    const badges = container.querySelectorAll(".card-cost-indicator");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.closest(".card-footer-row")).not.toBeNull();
    expect(badges[0]?.closest(".card-footer-row-right")).not.toBeNull();
  });

  it.each([1280, 390])("omits unavailable cost chips and their shells at %ipx with or without Promote", (width) => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });

    try {
      const unavailableWithoutPromote = render(
        <CostBadgeProvider value={{ enabled: true }}>
          <TaskCard
            task={taskWithUsage({
              tokenUsage: { ...taskWithUsage().tokenUsage!, modelProvider: "unknown", modelId: "no-price" },
            })}
            onOpenDetail={noop}
            addToast={noop}
          />
        </CostBadgeProvider>,
      );
      expect(unavailableWithoutPromote.container.querySelector(".card-cost-indicator")).toBeNull();
      expect(unavailableWithoutPromote.container.querySelector(".card-cost-indicator[aria-label]")).toBeNull();
      expect(unavailableWithoutPromote.container.querySelector(".card-promote-cost-row")).toBeNull();
      unavailableWithoutPromote.unmount();

      const unavailableWithPromote = render(
        <CostBadgeProvider value={{ enabled: true }}>
          <TaskCard
            task={taskWithUsage({
              tokenUsage: {
                ...taskWithUsage().tokenUsage!,
                modelProvider: "unknown",
                modelId: "no-price",
                perModel: [
                  { modelProvider: "openai", modelId: "gpt-5-mini", inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1_000_000 },
                  { modelProvider: "unknown", modelId: "no-price", inputTokens: 1, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, totalTokens: 1 },
                ],
              },
            })}
            onOpenDetail={noop}
            addToast={noop}
            onPromote={vi.fn().mockResolvedValue(undefined)}
          />
        </CostBadgeProvider>,
      );
      expect(unavailableWithPromote.container.querySelector(".card-cost-indicator")).toBeNull();
      expect(unavailableWithPromote.container.querySelector(".card-cost-indicator[aria-label]")).toBeNull();
      expect(unavailableWithPromote.container.querySelector(".card-promote-cost-row")).toBeNull();
      unavailableWithPromote.unmount();

      const pricedWithoutPromote = render(
        <CostBadgeProvider value={{ enabled: true }}>
          <TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} />
        </CostBadgeProvider>,
      );
      const footerBadge = pricedWithoutPromote.container.querySelectorAll(".card-cost-indicator");
      expect(footerBadge).toHaveLength(1);
      expect(footerBadge[0]?.textContent).toContain("$");
      pricedWithoutPromote.unmount();

      const pricedWithPromote = render(
        <CostBadgeProvider value={{ enabled: true }}>
          <TaskCard task={taskWithUsage()} onOpenDetail={noop} addToast={noop} onPromote={vi.fn().mockResolvedValue(undefined)} />
        </CostBadgeProvider>,
      );
      const promoteBadge = pricedWithPromote.container.querySelectorAll(".card-cost-indicator");
      expect(promoteBadge).toHaveLength(1);
      expect(promoteBadge[0]?.textContent).toContain("$");
      expect(promoteBadge[0]?.closest(".card-promote-cost-row")).not.toBeNull();
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
