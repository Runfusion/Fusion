import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { ExternalBlockNotice } from "../TaskCard";
import { readAppFile } from "../../test/cssFixture";

vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PrCreateModal", () => ({ PrCreateModal: () => null }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useBadgeWebSocket", () => ({ useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: true, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }) }));
vi.mock("../../hooks/useBatchBadgeFetch", () => ({ getFreshBatchData: vi.fn(() => null) }));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }) }));
vi.mock("../../api", () => ({ fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }) }));

const blocked = {
  id: "FN-209", title: "Blocked", description: "", column: "in-progress", dependencies: [], steps: [], currentStep: 0,
  status: "blocked", paused: true, pausedReason: "external-block",
  externalBlock: { origin: "credentials", code: "AUTH_REQUIRED", message: "credentials expired", source: "session-failure", blockedAt: "2026-08-28T00:00:00.000Z", resume: { column: "in-progress", currentStep: 0 } },
} as Task;

describe("Task Detail external Blocked affordance", () => {
  it("shows the same raw reason and exact resume actions", () => {
    const retry = vi.fn().mockResolvedValue(blocked);
    render(<ExternalBlockNotice task={blocked} variant="detail" onOpenChatWithPrefill={vi.fn()} onRetryTask={retry} />);
    expect(screen.getByTestId("external-block-detail-FN-209")).toHaveTextContent("AUTH_REQUIRED: credentials expired");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledWith("FN-209");
  });

  it("mounts the shared notice before the failed-task alert so the identities cannot coexist", () => {
    const source = readAppFile("components/TaskDetailModal.tsx");
    const notice = source.indexOf('<ExternalBlockNotice task={task as Task} variant="detail"');
    const failure = source.indexOf("{shouldShowTaskFailureAlert && (");
    expect(notice).toBeGreaterThan(0);
    expect(failure).toBeGreaterThan(notice);
    expect(source).toContain('const shouldShowTaskFailureAlert = Boolean(task.status === "failed"');
  });
});
