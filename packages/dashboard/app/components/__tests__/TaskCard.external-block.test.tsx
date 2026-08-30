import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskCard } from "../TaskCard";

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({ fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }) }));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-209",
    title: "Frozen external obstacle",
    description: "Keep exact work",
    column: "in-progress",
    dependencies: [],
    steps: [{ name: "Implementation", status: "done" }, { name: "Testing & Verification", status: "in-progress" }],
    currentStep: 1,
    status: "blocked",
    paused: true,
    pausedReason: "external-block",
    error: "BLOCKED: host-environment/ENOSPC: no space left on device, write",
    externalBlock: {
      origin: "host-environment",
      code: "ENOSPC",
      message: "no space left on device, write",
      source: "agent-declaration",
      blockedAt: "2026-08-28T00:00:00.000Z",
      resume: { column: "in-progress", nodeId: "steps#1:step-execute", currentStep: 1, worktree: "/worktree", branch: "fusion/fn-209" },
    },
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as Task;
}

const originalRect = HTMLElement.prototype.getBoundingClientRect;
const originalInnerWidth = window.innerWidth;

beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({ width: 420, height: 240, top: 0, left: 0, right: 420, bottom: 240, x: 0, y: 0, toJSON: () => ({}) }));
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  vi.restoreAllMocks();
});

describe("TaskCard external Blocked overlay", () => {
  it("shows the raw obstacle and routes explanation and exact Retry on desktop", async () => {
    const onOpenChatWithPrefill = vi.fn();
    const onRetryTask = vi.fn().mockResolvedValue(task({ status: undefined, externalBlock: undefined }));
    const { container } = render(<TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={onOpenChatWithPrefill} onRetryTask={onRetryTask} />);

    expect(screen.getByTestId("external-block-card-FN-209")).toHaveTextContent("Blocked");
    expect(screen.getByText("ENOSPC: no space left on device, write")).toBeInTheDocument();
    expect(screen.queryByText("paused")).toBeNull();
    expect(container.querySelector(".card-error")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Explain this error" }));
    expect(onOpenChatWithPrefill).toHaveBeenCalledWith("Explain this error ENOSPC: no space left on device, write and how to resolve it.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onRetryTask).toHaveBeenCalledWith("FN-209"));
  });

  it("keeps both mobile actions usable at the 768px breakpoint", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 768 });
    render(<TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} onOpenChatWithPrefill={vi.fn()} onRetryTask={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Explain this error" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.getByTestId("external-block-card-FN-209")).toBeVisible();
  });

  it("renders no empty overlay or action shells for incomplete and read-only shapes", () => {
    const { rerender } = render(<TaskCard task={task({ externalBlock: undefined })} onOpenDetail={vi.fn()} addToast={vi.fn()} />);
    expect(screen.queryByTestId("external-block-card-FN-209")).toBeNull();

    rerender(<TaskCard task={task()} onOpenDetail={vi.fn()} addToast={vi.fn()} />);
    expect(screen.getByTestId("external-block-card-FN-209")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Explain this error" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
