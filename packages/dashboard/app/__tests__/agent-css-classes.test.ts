import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { loadAllAppCss } from "../test/cssFixture";

const stylesContent = loadAllAppCss();

// Agent component file paths to verify inline <style> blocks are removed
const agentsViewContent = fs.readFileSync(path.join(__dirname, "../components/AgentsView.tsx"), "utf-8");
const agentEmptyStateContent = fs.readFileSync(path.join(__dirname, "../components/AgentEmptyState.tsx"), "utf-8");
const agentDetailViewContent = fs.readFileSync(path.join(__dirname, "../components/AgentDetailView.tsx"), "utf-8");
const activeAgentsPanelContent = fs.readFileSync(path.join(__dirname, "../components/ActiveAgentsPanel.tsx"), "utf-8");
const newAgentDialogContent = fs.readFileSync(path.join(__dirname, "../components/NewAgentDialog.tsx"), "utf-8");

/** Check that styles.css contains a CSS class definition for the given selector */
function extractRuleBlock(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesContent.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  return match?.[1] ?? "";
}

function hasClass(cls: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match standalone class, grouped selector, or compound selector (e.g. `.foo svg`)
  return new RegExp(`${escaped}(?=[\\s,{:.#>+~])`).test(stylesContent);
}

describe("Agent CSS classes", () => {
  // Verify agent state CSS variables are defined in the global stylesheet
  it("should define --state-* CSS variables", () => {
    expect(stylesContent).toContain("--state-idle-bg:");
    expect(stylesContent).toContain("--state-idle-text:");
    expect(stylesContent).toContain("--state-idle-border:");
    expect(stylesContent).toContain("--state-active-bg:");
    expect(stylesContent).toContain("--state-active-text:");
    expect(stylesContent).toContain("--state-active-border:");
    expect(stylesContent).toContain("--state-paused-bg:");
    expect(stylesContent).toContain("--state-paused-text:");
    expect(stylesContent).toContain("--state-paused-border:");
    expect(stylesContent).toContain("--state-error-bg:");
    expect(stylesContent).toContain("--state-error-text:");
    expect(stylesContent).toContain("--state-error-border:");
  });

  it("keeps split layout as the scroll-constrained pane container", () => {
    const splitLayout = extractRuleBlock(".agents-split-layout");
    expect(splitLayout).toContain("flex: 1");
    expect(splitLayout).toContain("min-height: 0");
    expect(splitLayout).not.toContain("height: 100%");

    const viewContent = extractRuleBlock(".agents-view-content");
    expect(viewContent).toContain("overflow-y: auto");
    expect(viewContent).toContain("min-height: 0");
  });

  it("removes legacy standalone mobile back-row classes from AgentsView", () => {
    expect(hasClass(".agents-mobile-back-row")).toBe(false);
    expect(hasClass(".agents-mobile-back-btn")).toBe(false);
  });

  it("removes desktop sidebar quick-controls strip classes", () => {
    expect(hasClass(".agents-sidebar-quick-controls")).toBe(false);
    expect(hasClass(".agents-sidebar-quick-controls__header")).toBe(false);
    expect(hasClass(".agents-sidebar-quick-controls__meta")).toBe(false);
    expect(hasClass(".agents-sidebar-quick-controls__actions")).toBe(false);
  });

  it("should visually group the filter controls", () => {
    const filtersBlock = extractRuleBlock(".agent-controls-filters");
    expect(filtersBlock).toContain("padding: var(--space-xs) var(--space-sm)");
    expect(filtersBlock).toContain("background: var(--surface)");
    expect(filtersBlock).toContain("border: 1px solid var(--border)");
    expect(filtersBlock).toContain("border-radius: var(--radius-md)");
  });

  it("should use dashboard tokens in the updated org chart styles", () => {
    const agentsViewCss = fs.readFileSync(path.join(__dirname, "../components/AgentsView.css"), "utf-8");
    const orgChartStart = agentsViewCss.indexOf("/* === FN-1167: Agent Org Chart + Chain of Command === */");
    const orgChartEnd = agentsViewCss.indexOf(".chain-of-command-path", orgChartStart);
    const orgChartSection = orgChartStart >= 0
      ? agentsViewCss.slice(orgChartStart, orgChartEnd >= 0 ? orgChartEnd : undefined)
      : "";
    expect(orgChartSection).toContain("gap: var(--space-xl)");
    expect(orgChartSection).toContain("padding: var(--space-xl)");
    expect(orgChartSection).toContain("padding: var(--space-md)");
    expect(orgChartSection).toContain("--org-chart-node-width: calc(var(--space-xl) * 9 + var(--space-xs))");
    expect(orgChartSection).toContain("--org-chart-root-gap: var(--space-xl)");
    expect(orgChartSection).toContain("--org-chart-connector-gap: var(--space-sm)");
    expect(orgChartSection).toContain("--org-chart-sibling-gap: var(--space-xl)");
    expect(orgChartSection).toContain("--org-chart-children-offset: calc(var(--space-lg) + var(--space-sm))");
    expect(orgChartSection).toContain("--org-chart-connector-color: color-mix(in srgb, var(--text-muted) 60%, transparent)");
    expect(orgChartSection).toMatch(/\.agent-org-chart-canvas\s*\{[^}]*--org-chart-connector-color:/);
    expect(orgChartSection).toContain("min-height: var(--org-chart-node-width)");
    expect(orgChartSection).toContain("touch-action: none");
    expect(orgChartSection).toContain("overflow: hidden");
    expect(orgChartSection).toContain("overscroll-behavior: contain");
    expect(orgChartSection).toContain("transform-origin: top left");
    expect(orgChartSection).toContain("background: var(--bg)");
    expect(orgChartSection).toContain("background: var(--card)");
    expect(orgChartSection).toContain("background: var(--card-hover)");
    expect(orgChartSection).toContain("border: 1px solid var(--border)");
    expect(orgChartSection).toContain("border-radius: var(--radius-lg)");
    expect(orgChartSection).toContain("border-radius: var(--radius-pill)");
    expect(orgChartSection).toContain("box-shadow: var(--shadow-sm)");
    expect(orgChartSection).toContain("box-shadow: var(--shadow-md)");
    expect(orgChartSection).toContain("box-shadow: var(--shadow-md), var(--focus-ring-strong)");
    expect(orgChartSection).toContain("border-color: color-mix(in srgb, var(--color-success) 40%, var(--border))");
    expect(orgChartSection).toContain("color: var(--text)");
    expect(orgChartSection).toContain("color: var(--text-muted)");
    expect(orgChartSection).toContain("box-shadow var(--transition-fast)");
    expect(orgChartSection).toContain("background-color var(--transition-fast)");
    expect(orgChartSection).toContain("transform var(--transition-fast)");
    expect(orgChartSection).toContain("--org-chart-subtree-leaves-number: var(--org-chart-subtree-leaves, 1)");
    expect(orgChartSection).toContain("min-width: calc(");
    expect(orgChartSection).toContain(".agent-org-chart--vertical .org-chart-children");
    expect(orgChartSection).toContain(".agent-org-chart-connectors");
    expect(orgChartSection).toContain("position: absolute");
    expect(orgChartSection).toContain("inset: 0");
    expect(orgChartSection).toContain("pointer-events: none");
    expect(orgChartSection).toContain(".agent-org-chart-canvas[data-panning=\"true\"]");
    expect(orgChartSection).toContain("transition: none");
    expect(orgChartSection).toContain("gap: var(--space-sm)");
    expect(orgChartSection).toContain("padding-top: var(--space-sm)");
    expect(orgChartSection).toContain("padding-left: calc(var(--space-lg) + var(--space-sm))");
    expect(orgChartSection).toContain("@media (max-width: 768px)");
    expect(orgChartSection).not.toContain("org-chart-node--has-children > .org-chart-node-card::after");
    expect(orgChartSection).not.toContain("var(--text-primary)");
    expect(orgChartSection).not.toContain("var(--text-secondary)");
    expect(orgChartSection).not.toMatch(/1\.5rem|0\.75rem|0\.72rem|0\.78rem|0\.65rem|120ms\s+ease|10px/);
    expect(orgChartSection).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba\(/);
  });

  it("encodes compact mobile agent detail header layout contracts", () => {
    const css = fs.readFileSync(path.join(__dirname, "../components/AgentDetailView.css"), "utf-8");
    const mobileStart = css.indexOf("@media (max-width: 768px)");
    const mobileCss = mobileStart >= 0 ? css.slice(mobileStart) : "";

    expect(mobileCss).toContain(".agent-detail-header {");
    expect(mobileCss).toContain("grid-template-columns: minmax(0, 1fr) auto;");
    expect(mobileCss).not.toContain("grid-template-rows: auto auto;");
    expect(mobileCss).toContain(".agent-detail-header-actions {");
    expect(mobileCss).toContain("grid-column: 2;");
    expect(mobileCss).toContain(".agent-detail-mobile-icon-control .agent-detail-control-label {");
  });

  it("should apply accessible focus/hover styles for merged evaluation cards and actions", () => {
    expect(stylesContent).toContain(".star-btn:focus-visible");
    expect(extractRuleBlock(".star-btn:focus-visible")).toContain("box-shadow: var(--focus-ring-strong)");

    expect(stylesContent).toContain(".reflection-card:focus-visible");
    expect(extractRuleBlock(".reflection-card:focus-visible")).toContain("box-shadow: var(--focus-ring-strong)");

    const reflectionHoverBlock = extractRuleBlock(".reflection-card:hover");
    expect(reflectionHoverBlock).toContain("background: var(--card-hover)");

    expect(stylesContent).toContain("@media (max-width: 768px)");
    expect(stylesContent).toContain(".reflections-header {");
    expect(stylesContent).toContain("flex-wrap: wrap");
  });

  it("should give role option buttons a tokenized focus-visible state", () => {
    expect(stylesContent).toContain(".agent-role-option:focus-visible");
    const roleFocusBlock = extractRuleBlock(".agent-role-option:focus-visible");
    expect(roleFocusBlock).toContain("border-color: var(--todo)");
    expect(roleFocusBlock).toContain("box-shadow: var(--focus-ring-strong)");
  });

  it("should keep the create-agent empty-state action copy", () => {
    expect(agentEmptyStateContent).toContain("Create Agent");
  });

  // Verify no inline <style> blocks remain in agent components
  it("should not have inline <style> blocks in AgentsView", () => {
    expect(agentsViewContent).not.toContain("<style>");
  });

  it("should only keep runtime health color inline styles in AgentsView", () => {
    const inlineStyleCount = (agentsViewContent.match(/style=\{\{/g) || []).length;
    expect(inlineStyleCount).toBe(4);
  });

  it("should not have inline <style> blocks in AgentDetailView", () => {
    expect(agentDetailViewContent).not.toContain("<style>");
  });

  it("should not have inline <style> blocks in ActiveAgentsPanel", () => {
    expect(activeAgentsPanelContent).not.toContain("<style>");
  });

  // Verify no inline style={{}} in NewAgentDialog
  it("should not have inline style={{}} attributes in NewAgentDialog", () => {
    const inlineStyleCount = (newAgentDialogContent.match(/style=\{\{/g) || []).length;
    expect(inlineStyleCount).toBe(0);
  });
});
