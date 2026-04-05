import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const stylesPath = path.join(__dirname, "../styles.css");
const stylesContent = fs.readFileSync(stylesPath, "utf-8");

// Agent component file paths to verify inline <style> blocks are removed
const agentsViewContent = fs.readFileSync(path.join(__dirname, "../components/AgentsView.tsx"), "utf-8");
const agentDetailViewContent = fs.readFileSync(path.join(__dirname, "../components/AgentDetailView.tsx"), "utf-8");
const activeAgentsPanelContent = fs.readFileSync(path.join(__dirname, "../components/ActiveAgentsPanel.tsx"), "utf-8");
const newAgentDialogContent = fs.readFileSync(path.join(__dirname, "../components/NewAgentDialog.tsx"), "utf-8");

/** Check that styles.css contains a CSS class definition for the given selector */
function hasClass(cls: string): boolean {
  const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match standalone class or class within a grouped selector list
  return new RegExp(`${escaped}\\s*(,|\\{)`).test(stylesContent);
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
  });

  // Verify badge base class
  it("should define .badge base class", () => {
    expect(hasClass(".badge")).toBe(true);
  });

  // Verify AgentMetricsBar classes
  it("should define AgentMetricsBar CSS classes", () => {
    expect(hasClass(".agent-metrics-bar")).toBe(true);
    expect(hasClass(".agent-metric-card")).toBe(true);
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
    expect(hasClass(".agent-state-filter")).toBe(true);
    expect(hasClass(".agent-state-filter-select")).toBe(true);
    expect(hasClass(".agent-board")).toBe(true);
    expect(hasClass(".agent-board-card")).toBe(true);
    expect(hasClass(".agent-board-header")).toBe(true);
    expect(hasClass(".agent-board-icon")).toBe(true);
    expect(hasClass(".agent-board-badge")).toBe(true);
    expect(hasClass(".agent-board-health")).toBe(true);
    expect(hasClass(".agent-board-name")).toBe(true);
    expect(hasClass(".agent-board-id")).toBe(true);
    expect(hasClass(".agent-board-clickable")).toBe(true);
    expect(hasClass(".agent-board-actions")).toBe(true);
    expect(hasClass(".agent-list")).toBe(true);
    expect(hasClass(".agent-card")).toBe(true);
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

  // Verify no inline <style> blocks remain in agent components
  it("should not have inline <style> blocks in AgentsView", () => {
    expect(agentsViewContent).not.toContain("<style>");
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
