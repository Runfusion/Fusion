import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { loadAllAppCss } from "../../test/cssFixture";
import { TaskCard } from "../TaskCard";

vi.mock("../../hooks/useToast", () => ({
  useOptionalToast: () => null,
  useToast: () => ({ addToast: vi.fn(), removeToast: vi.fn(), toasts: [] }),
}));
vi.mock("../../api", () => ({
  fetchWorkflowSettingValues: vi.fn(async () => ({ stored: {}, effective: {}, orphaned: [] })),
  fetchMission: vi.fn(),
  fetchAgent: vi.fn(),
  fetchAgents: vi.fn().mockResolvedValue([]),
  rebuildTaskSpec: vi.fn(),
}));
vi.mock("../../hooks/useBadgeWebSocket", () => ({
  useBadgeWebSocket: () => ({ badgeUpdates: new Map(), isConnected: false, subscribeToBadge: vi.fn(), unsubscribeFromBadge: vi.fn() }),
}));
vi.mock("../../hooks/useSessionFiles", () => ({ useSessionFiles: () => ({ files: [], loading: false }) }));
vi.mock("../../hooks/useTaskDiffStats", () => ({ useTaskDiffStats: () => ({ stats: null, loading: false }) }));
vi.mock("../../hooks/useAgentsMapCache", () => ({
  useAgentsMapCache: () => ({
    agentsMap: new Map([
      ["agent-backend", { name: "Backend Engineering Agent" }],
      ["agent-owner", { name: "Backend Engineering Agent" }],
    ]),
    agents: [],
    loading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));

const noop = () => {};
const sourceName = "Workflow Executor Agent";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-8902",
    title: "Distinguish ownership from provenance",
    column: "todo",
    status: "pending" as Task["status"],
    steps: [],
    dependencies: [],
    description: "",
    ...overrides,
  } as Task;
}

function renderCard(task: Task) {
  return render(<TaskCard task={task} onOpenDetail={noop} addToast={noop} />);
}

function getCssBlocks(css: string, fragment: string): string[] {
  const blocks: string[] = [];
  for (const match of css.matchAll(/@media[^{}]*\{/g)) {
    if (!match[0].includes(fragment)) continue;
    let depth = 1;
    let index = match.index! + match[0].length;
    while (index < css.length && depth > 0) {
      if (css[index] === "{") depth++;
      else if (css[index] === "}") depth--;
      index++;
    }
    blocks.push(css.slice(match.index! + match[0].length, index - 1));
  }
  return blocks;
}

describe("TaskCard agent provenance chip (FN-8930)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("distinguishes a different source agent from the assigned owner on narrow cards", () => {
    const { container } = renderCard(makeTask({
      assignedAgentId: "agent-backend",
      sourceType: "agent_heartbeat",
      sourceAgentId: "agent-workflow-exec",
      sourceMetadata: { agentName: sourceName },
    }));

    const owner = container.querySelector(".card-agent-badge") as HTMLElement;
    const provenance = container.querySelector(".card-agent-created-badge") as HTMLElement;
    expect(owner).toBeTruthy();
    expect(provenance).toBeTruthy();
    expect(owner.classList.contains("card-agent-created-badge--provenance")).toBe(false);
    expect(provenance).toHaveClass("card-agent-created-badge--provenance");
    expect(owner.querySelector("svg")?.className.baseVal).toContain("lucide-bot");
    expect(provenance.querySelector("svg")?.className.baseVal).toContain("lucide-sparkles");
    expect(provenance.textContent).toContain("by Workflow Exe...");
    expect(owner.textContent).not.toContain("by ");
    expect(owner).toHaveAttribute("title", "Assigned to Backend Engineering Agent");
    expect(owner).toHaveAttribute("aria-label", "Assigned to Backend Engineering Agent");
    expect(provenance).toHaveAttribute("title", "Created by agent: Workflow Executor Agent");
    expect(provenance).toHaveAttribute("aria-label", "Created by agent: Workflow Executor Agent");
  });

  it("covers single, deduped, generic, loading, and long-name states without empty rows", () => {
    const assignedOnly = renderCard(makeTask({ assignedAgentId: "agent-backend" })).container;
    expect(assignedOnly.querySelector(".card-agent-badge")).toBeTruthy();
    expect(assignedOnly.querySelector(".card-agent-badge-row")).toBeNull();

    const provenanceOnly = renderCard(makeTask({ sourceType: "automation", sourceMetadata: { agentName: sourceName } })).container;
    expect(provenanceOnly.querySelector(".card-agent-badge")).toBeNull();
    expect(provenanceOnly.querySelector(".card-agent-created-badge")?.textContent).toContain("by Workflow Exe...");
    expect(provenanceOnly.querySelector(".card-agent-row")).toBeNull();

    const sameId = renderCard(makeTask({ assignedAgentId: "agent-owner", sourceType: "agent_heartbeat", sourceAgentId: "agent-owner" })).container;
    expect(sameId.querySelector(".card-agent-created-badge")).toBeNull();
    expect(sameId.querySelector(".card-agent-badge-row")).toBeNull();

    const sameName = renderCard(makeTask({ assignedAgentId: "agent-owner", sourceType: "agent_heartbeat", sourceMetadata: { agentName: "BACKEND ENGINEERING AGENT" } })).container;
    expect(sameName.querySelector(".card-agent-created-badge")).toBeNull();

    const generic = renderCard(makeTask({ sourceType: "agent_heartbeat" })).container;
    const genericBadge = generic.querySelector(".card-agent-created-badge") as HTMLElement;
    const genericVisibleLabel = genericBadge.querySelector("span[aria-hidden='true']");
    expect(genericVisibleLabel?.textContent).toBe("Agent");
    expect(genericVisibleLabel?.textContent).not.toContain("by ");
    expect(genericBadge).toHaveAttribute("title", "Created by agent");

    const loading = renderCard(makeTask({ assignedAgentId: "agent-loading" })).container;
    expect(loading.querySelector(".card-agent-badge")).toHaveClass("card-agent-badge--loading");

    const long = renderCard(makeTask({ assignedAgentId: "agent-owner", sourceType: "automation", sourceMetadata: { agentName: sourceName } })).container;
    expect(long.querySelector(".card-agent-badge-text")?.textContent).toBe("Backend Engi...");
    expect(long.querySelector(".card-agent-created-badge")?.textContent).toContain("by Workflow Exe...");
  });

  it("keeps provenance labeled and outlined in the 768px mobile CSS block", () => {
    const mobileCss = getCssBlocks(loadAllAppCss(), "max-width: 768px").join("\n");
    expect(mobileCss).toContain(".card-agent-created-badge--provenance");
    expect(mobileCss).toMatch(/\.card-agent-created-badge--provenance\s*\{[^}]*border-style:\s*dashed/);
    expect(mobileCss).not.toMatch(/\.card-agent-created-badge[^}]*\{[^}]*display:\s*none/);
    expect(mobileCss).not.toMatch(/\.card-agent-created-badge--provenance\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--text-muted\) 18%/);
  });
});
