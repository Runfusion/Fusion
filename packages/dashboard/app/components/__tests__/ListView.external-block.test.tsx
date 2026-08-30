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
  externalBlock: { origin: "network", code: "ETIMEDOUT", message: "connection timed out", source: "session-failure", blockedAt: "2026-08-28T00:00:00.000Z", resume: { column: "in-progress", currentStep: 0 } },
} as Task;

describe("ListView external-block surfaces", () => {
  it("renders the list notice actions with the raw reason", () => {
    const explain = vi.fn();
    render(<ExternalBlockNotice task={blocked} variant="list" onOpenChatWithPrefill={explain} onRetryTask={vi.fn()} />);
    expect(screen.getByTestId("external-block-list-FN-209")).toHaveTextContent("ETIMEDOUT: connection timed out");
    fireEvent.click(screen.getByRole("button", { name: "Explain this error" }));
    expect(explain).toHaveBeenCalledWith(expect.stringContaining("ETIMEDOUT: connection timed out"));
  });

  it("keeps both grouped-card and table-row render branches wired to the shared notice", () => {
    const source = readAppFile("components/ListView.tsx");
    const notices = source.match(/<ExternalBlockNotice task=\{task\} variant="list"[^>]*\/>/g) ?? [];
    expect(notices).toHaveLength(2);
    const firstNotice = source.indexOf(notices[0]);
    const secondNotice = source.indexOf(notices[1], firstNotice + notices[0].length);
    const table = source.indexOf("<table className=\"list-table\"");
    expect(firstNotice).toBeLessThan(table);
    expect(secondNotice).toBeGreaterThan(table);
  });
});
