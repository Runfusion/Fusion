import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const stylesPath = path.join(__dirname, "../styles.css");
const stylesContent = fs.readFileSync(stylesPath, "utf-8");

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

function extractSection(startMarker: string, endMarker: string): string {
  const start = stylesContent.indexOf(startMarker);
  const end = stylesContent.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end >= 0 ? stylesContent.slice(start, end) : "";
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

  // Verify BEM button modifier classes exist
  it("should define BEM button modifier classes", () => {
    expect(hasClass(".btn--sm")).toBe(true);
    expect(hasClass(".btn--primary")).toBe(true);
    expect(hasClass(".btn--danger")).toBe(true);
    expect(hasClass(".btn--warning")).toBe(true);
    expect(hasClass(".btn--compact")).toBe(true);
  });

  // Verify badge base class
  it("should define .badge base class", () => {
    expect(hasClass(".badge")).toBe(true);
  });

  // Verify AgentMetricsBar classes
  it("should define AgentMetricsBar CSS classes", () => {
    expect(hasClass(".agent-metrics-bar")).toBe(true);
    expect(hasClass(".agent-metric-card")).toBe(true);
    expect(hasClass(".agent-metric-card--active")).toBe(true);
    expect(hasClass(".agent-metric-card--tasks")).toBe(true);
    expect(hasClass(".agent-metric-card--success")).toBe(true);
    expect(hasClass(".agent-metric-card--runs")).toBe(true);
    expect(hasClass(".agent-metric-info")).toBe(true);
    expect(hasClass(".agent-metric-value")).toBe(true);
    expect(hasClass(".agent-metric-label")).toBe(true);
  });

  // Verify AgentsView classes
  it("should define AgentsView CSS classes", () => {
    expect(hasClass(".agents-view")).toBe(true);
    expect(hasClass(".agents-view-header")).toBe(true);
    expect(hasClass(".agents-view-title")).toBe(true);
    expect(hasClass(".agents-view-controls")).toBe(true);
    expect(hasClass(".agents-view-content")).toBe(true);
    expect(hasClass(".agent-controls")).toBe(true);
    expect(hasClass(".agent-controls-filters")).toBe(true);
    expect(hasClass(".agent-state-filter")).toBe(true);
    expect(hasClass(".agent-state-filter-select")).toBe(true);
    expect(hasClass(".agent-board")).toBe(true);
    expect(hasClass(".agent-board-card")).toBe(true);
    expect(hasClass(".agent-board-card--idle")).toBe(true);
    expect(hasClass(".agent-board-card--active")).toBe(true);
    expect(hasClass(".agent-board-card--running")).toBe(true);
    expect(hasClass(".agent-board-card--paused")).toBe(true);
    expect(hasClass(".agent-board-card--error")).toBe(true);
    expect(hasClass(".agent-board-card--terminated")).toBe(true);
    expect(hasClass(".agent-board-header")).toBe(true);
    expect(hasClass(".agent-board-icon")).toBe(true);
    expect(hasClass(".agent-board-badge")).toBe(true);
    expect(hasClass(".agent-badge--idle")).toBe(true);
    expect(hasClass(".agent-badge--active")).toBe(true);
    expect(hasClass(".agent-badge--running")).toBe(true);
    expect(hasClass(".agent-badge--paused")).toBe(true);
    expect(hasClass(".agent-badge--error")).toBe(true);
    expect(hasClass(".agent-badge--terminated")).toBe(true);
    expect(hasClass(".agent-board-health")).toBe(true);
    expect(hasClass(".agent-board-name")).toBe(true);
    expect(hasClass(".agent-board-id")).toBe(true);
    expect(hasClass(".agent-board-clickable")).toBe(true);
    expect(hasClass(".agent-board-actions")).toBe(true);
    expect(hasClass(".agent-list")).toBe(true);
    expect(hasClass(".agent-card")).toBe(true);
    expect(hasClass(".agent-card--idle")).toBe(true);
    expect(hasClass(".agent-card--active")).toBe(true);
    expect(hasClass(".agent-card--running")).toBe(true);
    expect(hasClass(".agent-card--paused")).toBe(true);
    expect(hasClass(".agent-card--error")).toBe(true);
    expect(hasClass(".agent-card--terminated")).toBe(true);
    expect(hasClass(".agent-card-header")).toBe(true);
    expect(hasClass(".agent-card-body")).toBe(true);
    expect(hasClass(".agent-card-actions")).toBe(true);
    expect(hasClass(".agent-info")).toBe(true);
    expect(hasClass(".agent-info--clickable")).toBe(true);
    expect(hasClass(".agent-icon")).toBe(true);
    expect(hasClass(".agent-icon--clickable")).toBe(true);
    expect(hasClass(".agent-meta")).toBe(true);
    expect(hasClass(".agent-name")).toBe(true);
    expect(hasClass(".agent-id")).toBe(true);
    expect(hasClass(".agent-badges")).toBe(true);
    expect(hasClass(".agent-card-chevron")).toBe(true);
    expect(hasClass(".agent-task")).toBe(true);
    expect(hasClass(".agent-heartbeat")).toBe(true);
    expect(hasClass(".agent-role-select")).toBe(true);
    expect(hasClass(".agent-empty")).toBe(true);
    expect(hasClass(".spin")).toBe(true);
  });

  it("should visually group the filter controls", () => {
    const filtersBlock = extractRuleBlock(".agent-controls-filters");
    expect(filtersBlock).toContain("padding: var(--space-xs) var(--space-sm)");
    expect(filtersBlock).toContain("background: var(--surface)");
    expect(filtersBlock).toContain("border: 1px solid var(--border)");
    expect(filtersBlock).toContain("border-radius: var(--radius-md)");
  });

  it("should use design tokens for the updated tree view spacing and transitions", () => {
    const treeViewBlock = extractRuleBlock(".agent-tree__view");
    expect(treeViewBlock).toContain("gap: var(--space-xs)");
    expect(treeViewBlock).toContain("padding: var(--space-sm) 0");

    const treeNodeBlock = extractRuleBlock(".agent-tree__node");
    expect(treeNodeBlock).toContain("gap: var(--space-sm)");
    expect(treeNodeBlock).toContain("padding: var(--space-sm) var(--space-md)");
    expect(treeNodeBlock).toContain("border-radius: var(--radius-sm)");
    expect(treeNodeBlock).toContain("transition: background-color var(--transition-fast)");
    expect(treeNodeBlock).not.toMatch(/gap:\s*4px|padding:\s*8px 12px|border-radius:\s*4px|0\.15s\s+ease/);

    expect(extractRuleBlock(".agent-tree__indent--1")).toContain("padding-left: var(--space-xl)");
    expect(extractRuleBlock(".agent-tree__indent--2")).toContain("padding-left: calc(var(--space-xl) * 2)");
    expect(extractRuleBlock(".agent-tree__indent--3")).toContain("padding-left: calc(var(--space-xl) * 3)");
    expect(extractRuleBlock(".agent-tree__indent--4")).toContain("padding-left: calc(var(--space-xl) * 4)");
  });

  it("should use dashboard tokens in the updated org chart styles", () => {
    const orgChartSection = extractSection("/* === FN-1167: Agent Org Chart + Chain of Command === */", "/* === Agent Dialog Mobile Responsive === */");
    expect(orgChartSection).toContain("gap: var(--space-xl)");
    expect(orgChartSection).toContain("padding: var(--space-lg)");
    expect(orgChartSection).toContain("min-height: calc(var(--space-xl) * 9 + var(--space-xs))");
    expect(orgChartSection).toContain("border: 1px solid var(--border)");
    expect(orgChartSection).toContain("color: var(--text)");
    expect(orgChartSection).toContain("color: var(--text-muted)");
    expect(orgChartSection).toContain("border-radius: var(--radius-pill)");
    expect(orgChartSection).toContain("transition: border-color var(--transition-fast), background-color var(--transition-fast), transform var(--transition-fast)");
    expect(orgChartSection).not.toContain("var(--border-color)");
    expect(orgChartSection).not.toContain("var(--text-primary)");
    expect(orgChartSection).not.toContain("var(--text-secondary)");
    expect(orgChartSection).not.toMatch(/1\.5rem|0\.75rem|0\.72rem|0\.78rem|0\.65rem|120ms\s+ease|220px|10px/);
  });

  // Verify AgentDetailView classes
  it("should define AgentDetailView CSS classes", () => {
    expect(hasClass(".agent-detail-overlay")).toBe(true);
    expect(hasClass(".agent-detail-modal")).toBe(true);
    expect(hasClass(".agent-detail-loading")).toBe(true);
    expect(hasClass(".agent-detail-header")).toBe(true);
    expect(hasClass(".agent-detail-title")).toBe(true);
    expect(hasClass(".agent-detail-icon")).toBe(true);
    expect(hasClass(".agent-detail-info")).toBe(true);
    expect(hasClass(".agent-detail-badges")).toBe(true);
    expect(hasClass(".agent-detail-actions")).toBe(true);
    // Redesigned compact header structure
    expect(hasClass(".agent-detail-identity")).toBe(true);
    expect(hasClass(".agent-detail-controls")).toBe(true);
    expect(hasClass(".agent-detail-utility-actions")).toBe(true);
    expect(hasClass(".agent-detail-tabs")).toBe(true);
    expect(hasClass(".agent-detail-tab")).toBe(true);
    expect(hasClass(".agent-detail-content")).toBe(true);
    expect(hasClass(".agent-detail-footer")).toBe(true);
    expect(hasClass(".agent-detail-id")).toBe(true);
    expect(hasClass(".dashboard-tab")).toBe(true);
    expect(hasClass(".dashboard-section")).toBe(true);
    expect(hasClass(".info-grid")).toBe(true);
    expect(hasClass(".info-item")).toBe(true);
    expect(hasClass(".info-label")).toBe(true);
    expect(hasClass(".info-value")).toBe(true);
    expect(hasClass(".inline-badge")).toBe(true);
    expect(hasClass(".stats-grid")).toBe(true);
    expect(hasClass(".stat-card")).toBe(true);
    expect(hasClass(".stat-value")).toBe(true);
    expect(hasClass(".stat-label")).toBe(true);
    expect(hasClass(".current-task")).toBe(true);
    expect(hasClass(".task-badge")).toBe(true);
    expect(hasClass(".metadata-json")).toBe(true);
    expect(hasClass(".logs-tab")).toBe(true);
    expect(hasClass(".logs-header")).toBe(true);
    expect(hasClass(".logs-count")).toBe(true);
    expect(hasClass(".streaming-indicator")).toBe(true);
    expect(hasClass(".streaming-dot")).toBe(true);
    expect(hasClass(".logs-container")).toBe(true);
    expect(hasClass(".logs-empty")).toBe(true);
    expect(hasClass(".log-entry")).toBe(true);
    expect(hasClass(".log-timestamp")).toBe(true);
    expect(hasClass(".log-agent")).toBe(true);
    expect(hasClass(".log-icon")).toBe(true);
    expect(hasClass(".log-text")).toBe(true);
    expect(hasClass(".log-detail")).toBe(true);
    expect(hasClass(".runs-tab")).toBe(true);
    expect(hasClass(".runs-empty")).toBe(true);
    expect(hasClass(".run-card")).toBe(true);
    expect(hasClass(".run-card--active")).toBe(true);
    expect(hasClass(".run-header")).toBe(true);
    expect(hasClass(".run-live-indicator")).toBe(true);
    expect(hasClass(".live-dot")).toBe(true);
    expect(hasClass(".run-id")).toBe(true);
    expect(hasClass(".run-status")).toBe(true);
    expect(hasClass(".run-details")).toBe(true);
    expect(hasClass(".config-tab")).toBe(true);
    expect(hasClass(".config-section")).toBe(true);
    expect(hasClass(".config-description")).toBe(true);
    expect(hasClass(".config-fields")).toBe(true);
    expect(hasClass(".config-field")).toBe(true);
    expect(hasClass(".config-hint")).toBe(true);
    expect(hasClass(".config-error")).toBe(true);
    expect(hasClass(".config-actions")).toBe(true);
    expect(hasClass(".config-saved-indicator")).toBe(true);
    expect(hasClass(".input--error")).toBe(true);
  });

  it("should define AgentReflectionsTab and ratings CSS classes", () => {
    expect(hasClass(".reflections-tab")).toBe(true);
    expect(hasClass(".reflections-header")).toBe(true);
    expect(hasClass(".reflections-stats-grid")).toBe(true);
    expect(hasClass(".reflections-stat-card")).toBe(true);
    expect(hasClass(".reflections-no-data")).toBe(true);
    expect(hasClass(".reflections-loading-indicator")).toBe(true);
    expect(hasClass(".reflections-ratings-section")).toBe(true);
    expect(hasClass(".reflections-list")).toBe(true);
    expect(hasClass(".reflection-cards")).toBe(true);
    expect(hasClass(".reflection-card")).toBe(true);
    expect(hasClass(".reflection-card--expanded")).toBe(true);
    expect(hasClass(".reflection-card-header")).toBe(true);
    expect(hasClass(".reflection-trigger-badge")).toBe(true);
    expect(hasClass(".reflection-summary")).toBe(true);
    expect(hasClass(".reflection-details")).toBe(true);
    expect(hasClass(".reflection-empty")).toBe(true);

    expect(hasClass(".rating-summary-card")).toBe(true);
    expect(hasClass(".rating-score-display")).toBe(true);
    expect(hasClass(".rating-average")).toBe(true);
    expect(hasClass(".rating-stats")).toBe(true);
    expect(hasClass(".rating-count")).toBe(true);
    expect(hasClass(".rating-trend-badge")).toBe(true);
    expect(hasClass(".trend-improving")).toBe(true);
    expect(hasClass(".trend-declining")).toBe(true);
    expect(hasClass(".trend-stable")).toBe(true);
    expect(hasClass(".trend-insufficient")).toBe(true);
    expect(hasClass(".category-breakdown")).toBe(true);
    expect(hasClass(".category-item")).toBe(true);
    expect(hasClass(".category-name")).toBe(true);
    expect(hasClass(".category-score")).toBe(true);
    expect(hasClass(".add-rating-form")).toBe(true);
    expect(hasClass(".add-rating-category-select")).toBe(true);
    expect(hasClass(".add-rating-comment-input")).toBe(true);
    expect(hasClass(".star-selector")).toBe(true);
    expect(hasClass(".star-btn")).toBe(true);
    expect(hasClass(".rating-stars")).toBe(true);
    expect(hasClass(".star-filled")).toBe(true);
    expect(hasClass(".star-empty")).toBe(true);
    expect(hasClass(".rating-history")).toBe(true);
    expect(hasClass(".rating-history-item")).toBe(true);
    expect(hasClass(".rating-item-header")).toBe(true);
    expect(hasClass(".rating-category-badge")).toBe(true);
    expect(hasClass(".rating-time")).toBe(true);
    expect(hasClass(".rating-delete-btn")).toBe(true);
    expect(hasClass(".rating-comment")).toBe(true);
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

  // Verify ActiveAgentsPanel classes
  it("should define ActiveAgentsPanel CSS classes", () => {
    expect(hasClass(".active-agents-panel")).toBe(true);
    expect(hasClass(".active-agents-panel-header")).toBe(true);
    expect(hasClass(".active-agents-grid")).toBe(true);
    expect(hasClass(".live-agent-card")).toBe(true);
    expect(hasClass(".live-agent-card-header")).toBe(true);
    expect(hasClass(".live-agent-card-name")).toBe(true);
    expect(hasClass(".live-agent-pulse")).toBe(true);
    expect(hasClass(".live-agent-task")).toBe(true);
    expect(hasClass(".live-agent-card-transcript")).toBe(true);
    expect(hasClass(".live-agent-card-empty")).toBe(true);
    expect(hasClass(".live-agent-card-line")).toBe(true);
    expect(hasClass(".live-agent-card-footer")).toBe(true);
    expect(hasClass(".live-agent-streaming-dot")).toBe(true);
  });

  // Verify NewAgentDialog classes
  it("should define NewAgentDialog CSS classes", () => {
    expect(hasClass(".agent-dialog-overlay")).toBe(true);
    expect(hasClass(".agent-dialog")).toBe(true);
    expect(hasClass(".agent-dialog-header")).toBe(true);
    expect(hasClass(".agent-dialog-header-title")).toBe(true);
    expect(hasClass(".agent-dialog-body")).toBe(true);
    expect(hasClass(".agent-dialog-footer")).toBe(true);
    expect(hasClass(".agent-dialog-steps")).toBe(true);
    expect(hasClass(".agent-dialog-step")).toBe(true);
    expect(hasClass(".agent-dialog-field")).toBe(true);
    expect(hasClass(".agent-role-grid")).toBe(true);
    expect(hasClass(".agent-role-option")).toBe(true);
    expect(hasClass(".agent-role-option-icon")).toBe(true);
    expect(hasClass(".agent-role-option-label")).toBe(true);
    expect(hasClass(".agent-dialog-summary")).toBe(true);
    expect(hasClass(".agent-dialog-summary-row")).toBe(true);
    expect(hasClass(".agent-dialog-summary-row-label")).toBe(true);
    expect(hasClass(".agent-dialog-summary-row-value")).toBe(true);
    expect(hasClass(".agent-dialog-required")).toBe(true);
    expect(hasClass(".agent-dialog-optional")).toBe(true);
    expect(hasClass(".agent-dialog-error")).toBe(true);
    expect(hasClass(".agent-dialog-info")).toBe(true);
    expect(hasClass(".agent-dialog-loading")).toBe(true);
  });

  it("should give role option buttons a tokenized focus-visible state", () => {
    expect(stylesContent).toContain(".agent-role-option:focus-visible");
    const roleFocusBlock = extractRuleBlock(".agent-role-option:focus-visible");
    expect(roleFocusBlock).toContain("border-color: var(--todo)");
    expect(roleFocusBlock).toContain("box-shadow: var(--focus-ring-strong)");
  });

  it("should define shared AgentEmptyState component primitives", () => {
    expect(hasClass(".agent-empty-state__icon")).toBe(true);
    expect(hasClass(".agent-empty-state__title")).toBe(true);
    expect(hasClass(".agent-empty-state__description")).toBe(true);
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
