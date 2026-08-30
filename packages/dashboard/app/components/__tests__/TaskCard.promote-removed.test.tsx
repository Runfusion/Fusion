import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../api", () => ({
  addressPrFeedback: vi.fn(),
  fetchTaskDetail: vi.fn(),
  uploadAttachment: vi.fn(),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn(),
  rebuildTaskSpec: vi.fn(),
  refreshPrStatus: vi.fn(),
  fetchBoardWorkflows: vi.fn().mockResolvedValue({ flagEnabled: true, defaultWorkflowId: "wf-test", workflows: [], taskWorkflowIds: {} }),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import { TaskCard } from "../TaskCard";
import { CostBadgeProvider } from "../../context/CostBadgeContext";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-262",
    title: "Removed Promote fixture",
    description: "A planned hold task",
    column: "todo",
    dependencies: [],
    steps: [{ name: "Implement", status: "pending" }] as Task["steps"],
    currentStep: 0,
    awaitingPlanning: false,
    enabledWorkflowSteps: [],
    tokenUsage: {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 1_000_000,
      firstUsedAt: "2026-08-30T01:00:00.000Z",
      lastUsedAt: "2026-08-30T01:00:00.000Z",
      modelProvider: "openai",
      modelId: "gpt-5-mini",
    },
    log: [],
    createdAt: "2026-08-30T01:00:00.000Z",
    updatedAt: "2026-08-30T01:00:00.000Z",
    ...overrides,
  } as Task;
}

const initialInnerWidth = window.innerWidth;
const initialMatchMedia = window.matchMedia;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialInnerWidth });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: initialMatchMedia });
});

describe("TaskCard Promote removal", () => {
  it.each([1280, 640])("removes the former hold-card Promote affordance at %ipx", (width) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("max-width: 768px") && width <= 768,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    const { container } = render(
      <CostBadgeProvider value={{ enabled: true }}>
        <TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} taskColumnFlags={{ hold: true }} />
      </CostBadgeProvider>,
    );

    expect(screen.queryByTestId("card-promote-FN-262")).toBeNull();
    expect(container.querySelector(".card-action-row")).toBeNull();
    expect(container.querySelector(".card-promote-cost-row")).toBeNull();
    expect(container.querySelector(".card-cost-indicator")).not.toBeNull();
  });

  it("keeps Start on the shared card-promote-action class", () => {
    render(
      <TaskCard
        task={task({ column: "ideas", tokenUsage: undefined })}
        onOpenDetail={vi.fn()}
        addToast={vi.fn()}
        onMoveTask={vi.fn().mockResolvedValue(task({ column: "todo" }))}
        taskColumnFlags={{ intake: true, manualIntake: true }}
        taskMoveColumns={[
          { id: "ideas", label: "Ideas", flags: { intake: true, manualIntake: true } },
          { id: "todo", label: "Todo", flags: { hold: true } },
        ]}
      />,
    );

    expect(screen.getByTestId("card-start-FN-262")).toHaveClass("card-promote-action", "card-send-back-btn");
  });
});
