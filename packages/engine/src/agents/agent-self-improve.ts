import type { AgentHeartbeatConfig, AgentStore, ReflectionStore } from "@fusion/core";
import { createLogger } from "../logger.js";

const selfImproveLog = createLogger("agent-self-improve");

const DEFAULT_SELF_IMPROVE_INTERVAL_MS = 14_400_000;
const MIN_SELF_IMPROVE_INTERVAL_MS = 3_600_000;

export interface AgentSelfImproveServiceOptions {
  agentStore: AgentStore;
  reflectionStore: ReflectionStore;
  rootDir: string;
}

export class AgentSelfImproveService {
  private readonly agentStore: AgentStore;
  private readonly reflectionStore: ReflectionStore;
  private readonly rootDir: string;

  constructor(options: AgentSelfImproveServiceOptions) {
    this.agentStore = options.agentStore;
    this.reflectionStore = options.reflectionStore;
    this.rootDir = options.rootDir;
  }

  async shouldRunSelfImprove(agentId: string): Promise<boolean> {
    void this.reflectionStore;
    void this.rootDir;

    const agent = await this.agentStore.getAgent(agentId);
    if (!agent) {
      return false;
    }

    const runtimeConfig = (agent.runtimeConfig ?? {}) as AgentHeartbeatConfig;
    if (runtimeConfig.selfImproveEnabled === false) {
      return false;
    }

    const intervalMs = typeof runtimeConfig.selfImproveIntervalMs === "number" && Number.isFinite(runtimeConfig.selfImproveIntervalMs)
      ? Math.max(MIN_SELF_IMPROVE_INTERVAL_MS, runtimeConfig.selfImproveIntervalMs)
      : DEFAULT_SELF_IMPROVE_INTERVAL_MS;

    const lastSelfImproveAt = runtimeConfig.lastSelfImproveAt;
    if (!lastSelfImproveAt) {
      const summary = await this.agentStore.getRatingSummary(agentId);
      return summary.totalRatings > 0;
    }

    const lastMs = Date.parse(lastSelfImproveAt);
    if (!Number.isFinite(lastMs)) {
      return true;
    }

    return Date.now() - lastMs > intervalMs;
  }

  async getSelfImprovePrompt(agentId: string): Promise<string> {
    const agent = await this.agentStore.getAgent(agentId);
    const runtimeConfig = (agent?.runtimeConfig ?? {}) as AgentHeartbeatConfig;
    const lastSelfImproveAt = runtimeConfig.lastSelfImproveAt ?? "never";

    return `## Self-Improvement Phase

It is time for your periodic self-improvement review. Your last self-improvement was at ${lastSelfImproveAt}.

Follow this process:
1. Call fn_read_evaluations to review your ratings, reflections, and feedback.
2. Analyze the data for actionable patterns:
   - Declining scores or negative trends
   - Recurring error categories
   - Repeated negative feedback themes
   - Suggestions from reflections you haven't addressed
3. Based on your analysis, call fn_update_identity to update your instructions, soul, or memory:
   - Update instructionsText to incorporate new operating procedures or avoid repeated mistakes
   - Update soul to refine your personality/behavior based on feedback
   - Update memory to record self-improvement observations and commitments
4. Be conservative: only make changes you're confident will improve performance based on concrete evidence.
5. Document your self-improvement decisions concisely.`;
  }

  async recordSelfImprove(agentId: string): Promise<void> {
    const agent = await this.agentStore.getAgent(agentId);
    if (!agent) {
      return;
    }

    const existingRuntime = (agent.runtimeConfig ?? {}) as Record<string, unknown>;
    await this.agentStore.updateAgent(agentId, {
      runtimeConfig: {
        ...existingRuntime,
        lastSelfImproveAt: new Date().toISOString(),
      },
    });

    selfImproveLog.log(`Recorded self-improve checkpoint for ${agentId}`);
  }
}
