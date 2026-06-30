import React from "react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TaskCard, type CliCardState } from "../TaskCard";
import type { Task } from "@fusion/core";

vi.mock("lucide-react", () => {
  const Stub = () => null;
  return new Proxy({}, {
    get: (_target, prop) => prop === "then" ? undefined : Stub,
  });
});

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
