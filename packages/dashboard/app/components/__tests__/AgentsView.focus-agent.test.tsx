import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import * as apiModule from "../../api";

const viewport = vi.fn<() => "desktop" | "mobile">(() => "desktop");
vi.mock("../../hooks/useViewportMode", () => ({
  useViewportMode: () => viewport(),
  isMobileViewport: () => viewport() === "mobile",
  isTabletTouchViewport: () => false,
  isFullScreenSheetViewport: () => false,
  isShortViewport: () => false,
}));
vi.mock("../../hooks/useConfirm", () => ({ useConfirm: () => ({ confirm: vi.fn().mockResolvedValue(true) }) }));
vi.mock("../AgentDetailView", () => ({
  AgentDetailView: ({ agentId }: { agentId: string }) => <output data-testid="focused-agent">{agentId}</output>,
  relativeTime: () => "now",
}));
vi.mock("../../api", async (importOriginal) => {
  const { createDashboardApiMock } = await import("../../test/mockApi");
  return createDashboardApiMock(() => importOriginal<typeof import("../../api")>(), {
    fetchAgents: vi.fn(),
    fetchAgentStats: vi.fn().mockResolvedValue({ total: 1, byState: {}, byRole: {} }),
    fetchOrgTree: vi.fn().mockResolvedValue([]),
    fetchSettings: vi.fn().mockResolvedValue({ heartbeatMultiplier: 1 }),
    updateSettings: vi.fn().mockResolvedValue({}),
  });
});

import { AgentsView } from "../AgentsView";

const agent = {
  id: "agent-activity", name: "Activity agent", role: "executor", state: "idle",
  createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z", metadata: {},
};

describe("AgentsView focusAgent", () => {
  beforeEach(() => {
    vi.mocked((apiModule as typeof apiModule).fetchAgents).mockResolvedValue([agent] as never);
  });
  afterEach(() => {
    vi.clearAllMocks();
    viewport.mockReturnValue("desktop");
  });

  it.each(["desktop", "mobile"] as const)("opens the requested agent detail through the %s overview path", async (mode) => {
    viewport.mockReturnValue(mode);
    render(<AgentsView addToast={vi.fn()} focusAgent={{ agentId: agent.id, requestId: 1 }} />);
    await expect(screen.findByTestId("focused-agent")).resolves.toHaveTextContent(agent.id);
  });

  it("does not reactivate an unchanged request but accepts a new request for the same agent", async () => {
    const { rerender } = render(<AgentsView addToast={vi.fn()} focusAgent={{ agentId: agent.id, requestId: 1 }} />);
    await screen.findByTestId("focused-agent");
    rerender(<AgentsView addToast={vi.fn()} focusAgent={{ agentId: agent.id, requestId: 1 }} />);
    await waitFor(() => expect(screen.getByTestId("focused-agent")).toHaveTextContent(agent.id));
    rerender(<AgentsView addToast={vi.fn()} focusAgent={{ agentId: agent.id, requestId: 2 }} />);
    await waitFor(() => expect(screen.getByTestId("focused-agent")).toHaveTextContent(agent.id));
  });
});
