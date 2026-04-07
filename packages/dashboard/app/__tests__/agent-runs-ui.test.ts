import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ── Static analysis tests for agent run UI ────────────────────────────
// These tests verify that the agent run UI components are properly wired
// by analyzing the source files for the expected patterns.

const agentsViewPath = path.join(__dirname, "../components/AgentsView.tsx");
const agentDetailViewPath = path.join(__dirname, "../components/AgentDetailView.tsx");
const apiPath = path.join(__dirname, "../api.ts");

const agentsViewContent = fs.readFileSync(agentsViewPath, "utf-8");
const agentDetailViewContent = fs.readFileSync(agentDetailViewPath, "utf-8");
const apiContent = fs.readFileSync(apiPath, "utf-8");

describe("Agent runs UI — static analysis", () => {
  describe("startAgentRun API function", () => {
    it("accepts optional source and triggerDetail parameters", () => {
      expect(apiContent).toMatch(/startAgentRun\s*\(\s*agentId.*projectId\?/s);
      expect(apiContent).toMatch(/options\?\.\s*source/);
      expect(apiContent).toMatch(/options\?\.\s*triggerDetail/);
    });

    it("exports HeartbeatInvocationSource type", () => {
      expect(apiContent).toMatch(/export type.*HeartbeatInvocationSource/);
    });
  });

  describe("AgentsView Run Heartbeat button", () => {
    it("has handleRunHeartbeat function", () => {
      expect(agentsViewContent).toContain("handleRunHeartbeat");
    });

    it("calls startAgentRun with on_demand source", () => {
      expect(agentsViewContent).toMatch(/startAgentRun.*on_demand/);
      expect(agentsViewContent).toMatch(/startAgentRun.*Triggered from dashboard/);
    });

    it("shows Run Heartbeat button for active agents with taskId", () => {
      // The button should appear in the active state block
      // and should be conditioned on agent.taskId
      const activeBlock = agentsViewContent.match(/agent\.state === "active"[\s\S]*?agent\.state === "paused"/)?.[0] ?? "";
      expect(activeBlock).toContain("handleRunHeartbeat");
      expect(activeBlock).toContain("agent.taskId");
    });

    it("shows disabled button for running agents", () => {
      const runningBlock = agentsViewContent.match(/agent\.state === "running"[\s\S]*?agent\.state === "error"/)?.[0] ?? "";
      expect(runningBlock).toContain("disabled");
    });

    it("uses Activity icon for the Run Heartbeat button", () => {
      expect(agentsViewContent).toContain("handleRunHeartbeat");
      // Activity icon is imported and used in run heartbeat buttons
      expect(agentsViewContent).toMatch(/from.*lucide-react/);
      expect(agentsViewContent).toContain("Activity");
    });
  });

  describe("AgentDetailView RunsTab", () => {
    it("loads runs via fetchAgentRuns API", () => {
      expect(agentDetailViewContent).toMatch(/fetchAgentRuns/);
    });

    it("loads run detail via fetchAgentRunDetail API", () => {
      expect(agentDetailViewContent).toMatch(/fetchAgentRunDetail/);
    });

    it("has startAgentRun import for Run Heartbeat button", () => {
      expect(agentDetailViewContent).toMatch(/import.*startAgentRun.*from.*api/);
    });

    it("has Run Heartbeat button in runs tab", () => {
      expect(agentDetailViewContent).toMatch(/Run Heartbeat/);
      expect(agentDetailViewContent).toMatch(/handleRunHeartbeat/);
    });

    it("displays stdoutExcerpt in pre block", () => {
      expect(agentDetailViewContent).toContain("stdoutExcerpt");
    });

    it("displays stderrExcerpt", () => {
      expect(agentDetailViewContent).toContain("stderrExcerpt");
    });

    it("displays token usage (usageJson)", () => {
      expect(agentDetailViewContent).toContain("usageJson");
      expect(agentDetailViewContent).toMatch(/inputTokens|outputTokens|cachedTokens/);
    });

    it("displays resultJson", () => {
      expect(agentDetailViewContent).toContain("resultJson");
    });

    it("displays contextSnapshot", () => {
      expect(agentDetailViewContent).toContain("contextSnapshot");
    });

    it("has polling for active runs", () => {
      expect(agentDetailViewContent).toContain("setInterval");
      expect(agentDetailViewContent).toContain("5000");
    });

    it("has empty state for no runs", () => {
      expect(agentDetailViewContent).toContain("No runs yet");
    });

    it("has empty state for no output captured", () => {
      expect(agentDetailViewContent).toContain("No output captured");
    });

    it("has invocation source badge", () => {
      expect(agentDetailViewContent).toContain("invocationSource");
    });

    it("has trigger detail display", () => {
      expect(agentDetailViewContent).toContain("triggerDetail");
    });

    it("has no-runs empty state", () => {
      expect(agentDetailViewContent).toContain("No runs yet");
    });
  });
});
