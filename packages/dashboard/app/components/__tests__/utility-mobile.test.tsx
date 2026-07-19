import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllAppCss } from "../../test/cssFixture";
import { render, screen } from "@testing-library/react";
import type { Agent } from "../../api";
import type { Toast } from "../../hooks/useToast";

vi.mock("../../hooks/useExecutorStats", () => ({
  useExecutorStats: vi.fn(),
}));

vi.mock("../../hooks/useLiveTranscript", () => ({
  useLiveTranscript: vi.fn(() => ({
    entries: [],
    isConnected: false,
  })),
}));
/*
FNXC:RuntimeFallbackUI 2026-07-11-00:00:
RuntimeFallbackBadge (commit 0bed997af / FUX-022) calls the shared useToast() hook directly.
ActiveAgentsPanel embeds RuntimeFallbackBadge and this file renders it outside a ToastProvider, so mock
the hook to avoid "useToast must be used within ToastProvider", matching the TaskCard.test.tsx pattern.
*/
vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

import { useExecutorStats } from "../../hooks/useExecutorStats";
import { ExecutorStatusBar } from "../ExecutorStatusBar";
import { ActiveAgentsPanel } from "../ActiveAgentsPanel";
import { ToastContainer } from "../ToastContainer";


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expectMobileRule(css: string, selector: string, declaration: string): void {
  const pattern = new RegExp(
    `@media[^{]*\\(max-width:\\s*768px\\)[^{]*\\{[\\s\\S]*?${escapeRegExp(selector)}\\s*\\{[\\s\\S]*?${escapeRegExp(declaration)}`,
  );
  expect(pattern.test(css)).toBe(true);
}

describe("Utility component mobile adaptations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useExecutorStats).mockReturnValue({
      stats: {
        runningTaskCount: 1,
        blockedTaskCount: 2,
        stuckTaskCount: 0,
        queuedTaskCount: 3,
        inReviewCount: 4,
        executorState: "running",
        maxConcurrent: 5,
        lastActivityAt: new Date().toISOString(),
      },
      loading: false,
      error: null,
      refresh: vi.fn(),
    });
  });

  it("renders ExecutorStatusBar segments", () => {
    render(<ExecutorStatusBar tasks={[]} />);

    const bar = screen.getByRole("status");
    expect(bar).toHaveTextContent("Running");
    expect(bar).toHaveTextContent("Blocked");
    expect(bar).toHaveTextContent("Queued");
    expect(bar).toHaveTextContent("In Review");
  });

  it("renders ActiveAgentsPanel grid and cards when agents are provided", () => {
    const agents: Agent[] = [
      {
        id: "agent-1",
        name: "Live Agent",
        role: "executor",
        state: "active",
        taskId: "FN-555",
        lastHeartbeatAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
    ];

    const { container } = render(<ActiveAgentsPanel agents={agents} />);

    expect(container.querySelector(".active-agents-grid")).toBeTruthy();
    expect(container.querySelectorAll(".live-agent-card").length).toBe(1);
  });

  it("returns null for ActiveAgentsPanel when no agents are active", () => {
    const { container } = render(<ActiveAgentsPanel agents={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders toasts in ToastContainer", () => {
    const toasts: Toast[] = [
      { id: 1, message: "Saved", type: "success" },
      { id: 2, message: "Failed", type: "error" },
    ];

    const { container } = render(<ToastContainer toasts={toasts} onRemove={vi.fn()} />);

    expect(container.querySelector(".toast-container")).toBeTruthy();
    expect(container.querySelector(".toast-success")).toBeTruthy();
    expect(container.querySelector(".toast-error")).toBeTruthy();
  });

  it("contains mobile CSS overrides for adapted utility and layout components", () => {
    const css = loadAllAppCss();

    expectMobileRule(css, ".settings-layout", "flex-direction: column;");
    expectMobileRule(css, ".agent-board", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".active-agents-grid", "grid-template-columns: 1fr;");
    expectMobileRule(css, ".toast-container", "top: calc(var(--header-height, 57px) + env(safe-area-inset-top, 0px) + var(--space-sm));");
    expectMobileRule(css, ".toast-container", "bottom: auto;");
    expectMobileRule(css, ".toast-container", "right: var(--space-sm);");
    expectMobileRule(css, ".toast-container", "left: var(--space-sm);");
  });
});
