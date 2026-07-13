import React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskCard, type CliCardState } from "../TaskCard";
import type { Task } from "@fusion/core";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  // FNXC:DashboardMocks 2026-07-13-14:00 (round 11):
  // TaskCard now imports priorityIndicator.tsx, which reads ArrowDown/ArrowUp/Flag/TriangleAlert
  // from lucide-react at module-init time. A get-only Proxy is not enough: Vitest validates named
  // ESM exports via `in`/`getOwnPropertyDescriptor` before reading the binding, so a bare Proxy
  // over {} reports no exports and throws "No ArrowDown export is defined on the lucide-react mock".
  // Expose every string key as an own enumerable Stub so any icon resolves to a null stub.
  return new Proxy({}, {
    get: (_target, prop) => prop === "then" ? undefined : Stub,
    has: (_target, prop) => typeof prop === "string" && prop !== "then",
    getOwnPropertyDescriptor: (_target, prop) =>
      typeof prop === "string" && prop !== "then"
        ? { configurable: true, enumerable: true, value: Stub, writable: true }
        : undefined,
  });
});
// FNXC:DashboardMocks 2026-07-13-14:00 (round 11):
// TaskCard embeds RuntimeFallbackBadge, which calls the shared useToast() hook
// directly (not the addToast prop). This file renders <TaskCard> outside a
// ToastProvider, so mock the hook to avoid "useToast must be used within
// ToastProvider", matching the TaskCard.test.tsx pattern.
vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    addToast: vi.fn(),
    removeToast: vi.fn(),
    toasts: [],
  }),
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`provider-icon-${provider}`} />,
}));

vi.mock("../../hooks/useTaskDiffStats", () => ({
  useTaskDiffStats: () => ({ stats: null, loading: false }),
}));

const badgeUpdatesMock = new Map<string, unknown>();
vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({
    badgeUpdates: badgeUpdatesMock,
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
}));

vi.mock("../../hooks/useConfirm", () => ({
  useConfirm: () => ({ confirm: vi.fn(), confirmWithChoice: vi.fn() }),
}));

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-001",
    title: "Test task",
    column: "in-progress",
    status: undefined as never,
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

const noop = () => {};

function renderCard(cliSessionState?: CliCardState) {
  return render(
    <TaskCard
      task={makeTask()}
      onOpenDetail={noop}
      addToast={noop}
      cliSessionState={cliSessionState}
    />,
  );
}

afterEach(() => {
  badgeUpdatesMock.clear();
  vi.clearAllMocks();
});

describe("TaskCard CLI agent state badges (U11)", () => {
  it("renders the waiting-on-input badge when the session is waitingOnInput", () => {
    renderCard({ agentState: "waitingOnInput" });
    const badge = screen.getByText("Waiting on input");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-cli-state")).toBe("waitingOnInput");
  });

  it("renders the needs-attention badge when the session needsAttention", () => {
    renderCard({ agentState: "needsAttention" });
    const badge = screen.getByText("Needs attention");
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("data-cli-state")).toBe("needsAttention");
  });

  it("busy clears both CLI badges (F2 — answering re-arms to busy)", () => {
    renderCard({ agentState: "busy" });
    expect(screen.queryByText("Waiting on input")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("no cli session → no CLI badges (card unchanged)", () => {
    renderCard(undefined);
    expect(screen.queryByText("Waiting on input")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
  });
});
