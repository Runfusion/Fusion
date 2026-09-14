import { describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import type { Agent } from "../../api";
import { loadAllAppCss } from "../../test/cssFixture";

vi.mock("../../hooks/useLiveTranscript", () => ({
  useLiveTranscript: () => ({ entries: [], isConnected: false }),
}));
vi.mock("../../hooks/useAgentActivity", () => ({
  useAgentActivity: () => ({ activityByAgentId: new Map(), events: [], nowTick: 0 }),
}));
vi.mock("../RuntimeFallbackBadge", () => ({ RuntimeFallbackBadge: () => null }));
vi.mock("../AgentTaskBadge", () => ({ AgentTaskBadge: () => null }));

import { AgentsOverviewBar, AgentsOverviewToggle } from "../AgentsOverviewBar";

function makeAgent(id: string): Agent {
  return {
    id,
    name: `Agent ${id}`,
    role: "executor",
    state: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  };
}

const css = loadAllAppCss();

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
}

describe("AgentsOverviewBar mobile scroll contract", () => {
  it("keeps the overview content as the constrained touch scroll owner", () => {
    const overview = rule(".agents-overview-bar");
    const content = rule(".agents-overview-bar__content");

    expect(overview).toContain("min-height: 0");
    expect(overview).toContain("overflow: hidden");
    expect(content).toContain("min-height: 0");
    expect(content).toContain("overflow-y: auto");
    expect(content).toContain("-webkit-overflow-scrolling: touch");
    expect(content).toContain("overscroll-behavior: contain");
    expect(rule(".agents-overview-bar__toggle")).toContain("flex-shrink: 0");

    expect(rule(".agents-view-content")).toContain("flex: 1");
    expect(rule(".agents-view-content")).toContain("min-height: 0");
    expect(rule(".agents-view-content")).toContain("overflow-y: auto");
    expect(rule(".agent-org-chart-viewport")).toContain("overflow: hidden");
    expect(rule(".agent-org-chart-viewport")).toContain("overscroll-behavior: contain");
  });

  it("renders the production overview chain for many, duplicate, and empty active-agent states", () => {
    const agents = Array.from({ length: 13 }, (_, index) => makeAgent(`agent-${index}`));
    const onToggle = vi.fn();
    // The trigger is hosted by the Agents header, so it is a sibling of the expanded section rather than its child.
    const { container, rerender } = render(
      <div className="agents-view">
        <div className="agents-view-controls">
          <AgentsOverviewToggle activeAgents={[...agents, agents[0]]} isOpen onToggle={onToggle} />
        </div>
        <AgentsOverviewBar stats={{ activeCount: 13, assignedTaskCount: 13, completedRuns: 0, failedRuns: 0, successRate: 1 }} activeAgents={[...agents, agents[0]]} isOpen />
      </div>,
    );

    const overview = container.querySelector(".agents-view > section.agents-overview-bar");
    const toggle = container.querySelector(".agents-view-controls > button.agents-overview-bar__toggle");
    const content = overview?.querySelector(":scope > .agents-overview-bar__content");
    expect(overview).toBeTruthy();
    expect(overview?.querySelector("button.agents-overview-bar__toggle")).toBeNull();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(content?.firstElementChild).toHaveClass("agent-metrics-bar", "agents-overview-bar__metrics");

    const panel = content?.querySelector(":scope > .active-agents-panel.agents-overview-bar__active-panel");
    expect(panel?.querySelector(":scope > .active-agents-panel-header")).toBeTruthy();
    expect(panel?.querySelector(":scope > .active-agents-grid")).toBeTruthy();
    expect(panel?.querySelectorAll(":scope > .active-agents-grid > .live-agent-card")).toHaveLength(13);

    fireEvent.click(toggle!);
    expect(onToggle).toHaveBeenCalledOnce();

    rerender(
      <div className="agents-view">
        <AgentsOverviewBar stats={{ activeCount: 0, assignedTaskCount: 0, completedRuns: 0, failedRuns: 0, successRate: 1 }} activeAgents={[]} isOpen />
      </div>,
    );
    const emptyContent = container.querySelector(".agents-overview-bar__content");
    expect(emptyContent?.querySelector(".agent-metrics-bar.agents-overview-bar__metrics")).toBeTruthy();
    expect(emptyContent?.querySelector(".active-agents-panel")).toBeNull();

    rerender(
      <div className="agents-view">
        <AgentsOverviewBar stats={{ activeCount: 13, assignedTaskCount: 13, completedRuns: 0, failedRuns: 0, successRate: 1 }} activeAgents={agents} isOpen={false} />
      </div>,
    );
    expect(container.querySelector(".agents-overview-bar__content")).toBeNull();
    expect(container.querySelector("section.agents-overview-bar")).toBeNull();
  });
});
