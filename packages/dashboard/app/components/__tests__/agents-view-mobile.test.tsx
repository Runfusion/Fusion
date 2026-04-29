import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentsView } from "../AgentsView";
import { loadAllAppCss } from "../../test/cssFixture";
import type { Agent, AgentCapability, AgentState } from "../../api";

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const regex = /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;

    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount += 1;
      if (content[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }

    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  fetchAgentStats: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  updateAgentState: vi.fn(),
  deleteAgent: vi.fn(),
  startAgentRun: vi.fn(),
  fetchPluginRuntimes: vi.fn(() => Promise.resolve([])),
  fetchModels: vi.fn(() => Promise.resolve({ models: [] })),
  fetchOrgTree: vi.fn(),
  fetchSettings: vi.fn(() => Promise.resolve({ heartbeatMultiplier: 1 })),
  updateSettings: vi.fn(() => Promise.resolve({})),
}));

import {
  fetchAgents,
  fetchAgentStats,
  updateAgent,
  updateAgentState,
  deleteAgent,
  startAgentRun,
  fetchOrgTree,
} from "../../api";

const mockAgents: Agent[] = [
  {
    id: "agent-001",
    name: "Mobile Executor",
    role: "executor" as AgentCapability,
    state: "active" as AgentState,
    taskId: "FN-101",
    totalInputTokens: 60,
    totalOutputTokens: 20,
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
  {
    id: "agent-002",
    name: "Mobile Reviewer",
    role: "reviewer" as AgentCapability,
    state: "idle" as AgentState,
    totalInputTokens: 15,
    totalOutputTokens: 5,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {},
  },
];

const eventSourceFactory = vi.fn(() => ({
  addEventListener: vi.fn(),
  close: vi.fn(),
}));

describe("AgentsView mobile adaptations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal("EventSource", eventSourceFactory as unknown as typeof EventSource);

    vi.mocked(fetchAgents).mockResolvedValue(mockAgents);
    vi.mocked(fetchAgentStats).mockResolvedValue({
      activeCount: 1,
      assignedTaskCount: 1,
      completedRuns: 0,
      failedRuns: 0,
      successRate: 1,
    });
    vi.mocked(updateAgent).mockResolvedValue(mockAgents[0]);
    vi.mocked(updateAgentState).mockResolvedValue(mockAgents[0]);
    vi.mocked(deleteAgent).mockResolvedValue(undefined);
    vi.mocked(startAgentRun).mockResolvedValue({
      id: "run-1",
      agentId: "agent-001",
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: "active",
    });
    vi.mocked(fetchOrgTree).mockResolvedValue([]);
  });

  it("renders board view grid and board cards", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Board view" }));

    await waitFor(() => {
      expect(container.querySelector(".agent-board")).toBeTruthy();
      expect(container.querySelectorAll(".agent-board-card").length).toBeGreaterThan(0);
    });
  });

  it("renders list view cards", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "List view" }));

    await waitFor(() => {
      expect(container.querySelector(".agent-list")).toBeTruthy();
      expect(container.querySelectorAll(".agent-card").length).toBeGreaterThan(0);
    });

    // Token-stats panel now lives in the controls popup; open it before
    // asserting on the panel content.
    fireEvent.click(screen.getByRole("button", { name: "Controls" }));
    await waitFor(() => {
      expect(container.querySelector(".agent-token-stats-panel")).toBeTruthy();
      expect(screen.getByText("Combined Tokens")).toBeTruthy();
      expect(screen.getByText("100")).toBeTruthy();
    });
  });

  it("renders controls trigger and reveals panel controls on demand", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    const controlsTrigger = screen.getByRole("button", { name: "Controls" });
    expect(controlsTrigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(controlsTrigger);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Agent controls" })).toBeTruthy();
      expect(container.querySelector(".agent-controls")).toBeTruthy();
      expect(container.querySelector(".agent-controls-filters")).toBeTruthy();
      expect(container.querySelector(".agent-state-filter")).toBeTruthy();
      expect(container.querySelector(".agent-controls-actions")).toBeTruthy();
    });
  });

  it("switches between board, list, and tree views", async () => {
    const { container } = render(<AgentsView addToast={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Agents")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Tree view" }));
    await waitFor(() => expect(container.querySelector(".agent-tree__view")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Board view" }));
    await waitFor(() => expect(container.querySelector(".agent-board")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "List view" }));
    await waitFor(() => expect(container.querySelector(".agent-list")).toBeTruthy());
  });

  it("renders state filter select with expected options", async () => {
    render(<AgentsView addToast={vi.fn()} />);
    const controlsTrigger = await screen.findByRole("button", { name: "Controls" });
    fireEvent.click(controlsTrigger);
    await waitFor(() => expect(screen.getByLabelText("Filter agents by state")).toBeTruthy());

    const select = screen.getByLabelText("Filter agents by state") as HTMLSelectElement;
    expect(select).toBeTruthy();

    const optionValues = Array.from(select.options).map((option) => option.value);
    expect(optionValues).toEqual(["all", "idle", "active", "running", "paused", "error", "terminated"]);
  });
});

describe("agents-view mobile CSS", () => {
  const cssContent = loadAllAppCss();
  const mobileMediaBlock = extractMobileMediaBlocks(cssContent);

  it("defines .agents-view-content with reduced padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".agents-view-content");
    const block = extractRuleBlock(mobileMediaBlock, ".agents-view-content");
    expect(block).toContain("padding: var(--space-md)");
  });

  it("defines .agents-view-header with compact padding on mobile", () => {
    expect(mobileMediaBlock).toContain(".agents-view-header");
    const block = extractRuleBlock(mobileMediaBlock, ".agents-view-header");
    expect(block).toMatch(/padding:\s*var\(--space-sm\)\s+var\(--space-md\)/);
  });

  it("defines .agents-view-title h2 with 16px font on mobile", () => {
    expect(mobileMediaBlock).toContain(".agents-view-title h2");
    const block = extractRuleBlock(mobileMediaBlock, ".agents-view-title h2");
    expect(block).toContain("font-size: 16px");
  });

  it("defines .agents-view-controls with flex-wrap on mobile", () => {
    expect(mobileMediaBlock).toContain(".agents-view-controls");
    const block = extractRuleBlock(mobileMediaBlock, ".agents-view-controls");
    expect(block).toContain("flex-wrap: wrap");
  });

  it("stacks grouped filter controls on mobile", () => {
    expect(mobileMediaBlock).toContain(".agent-controls-filters");
    const block = extractRuleBlock(mobileMediaBlock, ".agent-controls-filters");
    expect(block).toContain("flex-direction: column");
    expect(block).toContain("width: 100%");
  });

  it("defines .agents-view-title with flex-wrap on mobile", () => {
    expect(mobileMediaBlock).toContain(".agents-view-title");
    const block = extractRuleBlock(mobileMediaBlock, ".agents-view-title");
    expect(block).toContain("flex-wrap: wrap");
  });

  it("defines mobile org chart sizing rules", () => {
    expect(extractRuleBlock(mobileMediaBlock, ".agent-org-chart")).toContain("gap: var(--space-sm)");
    expect(extractRuleBlock(mobileMediaBlock, ".agent-org-chart")).toContain("--org-chart-node-width: calc(var(--space-2xl) * 5)");
    expect(extractRuleBlock(mobileMediaBlock, ".org-chart-node-card")).toContain("padding: var(--space-sm)");
    expect(extractRuleBlock(mobileMediaBlock, ".org-chart-node__badge")).toContain("font-size: calc(var(--space-sm) + var(--space-xs) * 0.625)");
  });
});
