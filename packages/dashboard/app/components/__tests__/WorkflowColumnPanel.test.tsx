import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, TraitCatalogEntry } from "../../api";
import { fetchAgents, fetchTraits } from "../../api";
import { WorkflowColumnPanel } from "../WorkflowColumnPanel";

vi.mock("../../api", () => ({
  fetchAgents: vi.fn(),
  fetchTraits: vi.fn(),
}));

const traitCatalog: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
];

const agents = [
  { id: "agent-1", name: "Column Bot" },
] as Agent[];

function renderPanel({
  columns = [
    { id: "triage", name: "Triage", traits: [{ trait: "intake" }], agent: { agentId: "agent-1", mode: "defer" as const } },
    { id: "done", name: "Done", traits: [{ trait: "complete" }] },
  ],
  readOnly = false,
}: {
  columns?: ComponentProps<typeof WorkflowColumnPanel>["columns"];
  readOnly?: boolean;
} = {}) {
  return render(
    <WorkflowColumnPanel
      columns={columns}
      onChange={vi.fn()}
      violations={[]}
      readOnly={readOnly}
      addToast={vi.fn()}
      columnAgentsEnabled
    />,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectorMatches(selectorList: string, selector: string): boolean {
  return selectorList
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === selector || part.startsWith(`${selector}:`));
}

function themedRuleBlocks(css: string, selector: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => selectorMatches(match[1], selector))
    .map((match) => match[2]);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkflowColumnPanel", () => {
  beforeEach(() => {
    vi.mocked(fetchTraits).mockResolvedValue(traitCatalog);
    vi.mocked(fetchAgents).mockResolvedValue(agents);
  });

  it("renders populated column controls with the themed column-panel classes", async () => {
    const { container } = renderPanel();

    expect(screen.getByRole("button", { name: /Add column/i })).toHaveClass("wf-column-add");
    const triageRow = screen.getByTestId("wf-column-triage");
    const moveButtons = within(triageRow).getAllByRole("button", { name: /Move column (up|down)/i });
    expect(moveButtons).toHaveLength(2);
    expect(moveButtons[0]).toHaveClass("wf-column-move");
    expect(within(triageRow).getByRole("button", { name: /Remove column/i })).toHaveClass("wf-column-remove");
    expect(screen.getByTestId("wf-column-agent-select-triage")).toHaveClass("wf-column-agent-select");
    expect(screen.getByTestId("wf-column-agent-badge-triage")).toHaveClass("wf-column-agent-badge");
    expect(container.querySelector(".wf-column-traits")).toBeTruthy();
    expect(container.querySelector(".wf-column-agent-mode-option")).toBeTruthy();

    await waitFor(() => expect(fetchTraits).toHaveBeenCalled());
    await waitFor(() => expect(fetchAgents).toHaveBeenCalled());
  });

  it("renders the themed empty-state class when no columns exist", () => {
    renderPanel({ columns: [] });

    expect(screen.getByText(/No columns yet/i)).toHaveClass("wf-column-panel-empty");
  });

  it("keeps read-only controls visible with their themed classes and disabled state", () => {
    renderPanel({ readOnly: true });

    expect(screen.getByRole("button", { name: /Add column/i })).toHaveClass("wf-column-add");
    expect(screen.getByRole("button", { name: /Add column/i })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /Move column (up|down)/i })[0]).toHaveClass("wf-column-move");
    expect(screen.getAllByRole("button", { name: /Move column (up|down)/i })[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: /Remove column/i })[0]).toHaveClass("wf-column-remove");
    expect(screen.getAllByRole("button", { name: /Remove column/i })[0]).toBeDisabled();
    expect(screen.getByTestId("wf-column-agent-select-triage")).toHaveClass("wf-column-agent-select");
    expect(screen.getByTestId("wf-column-agent-select-triage")).toBeDisabled();
  });

  it("defines tokenized CSS rules for every column-panel selector themed by FN-6400", () => {
    const css = readFileSync(resolve(__dirname, "../WorkflowNodeEditor.css"), "utf8");
    const selectors = [
      ".wf-column-add",
      ".wf-column-move",
      ".wf-column-remove",
      ".wf-column-panel-empty",
      ".wf-column-panel-errors",
      ".wf-column-traits",
      ".wf-column-agent",
      ".wf-column-agent-label",
      ".wf-column-agent-select",
      ".wf-column-agent-badge",
      ".wf-column-agent-badge--stale",
      ".wf-column-agent-error",
      ".wf-column-agent-stale",
      ".wf-column-agent-mode",
      ".wf-column-agent-mode-option",
    ];

    for (const selector of selectors) {
      const blocks = themedRuleBlocks(css, selector);
      expect(blocks.length, `${selector} should have a CSS rule`).toBeGreaterThan(0);
      expect(blocks.some((block) => block.includes("var(--")), `${selector} should use design tokens`).toBe(true);
      for (const block of blocks) {
        expect(block, `${selector} should not use raw hex or rgba()`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba\(/);
      }
    }

    expect(css.match(new RegExp(escapeRegExp(".wf-column-agent-select"), "g"))?.length ?? 0).toBeGreaterThan(0);
  });
});
