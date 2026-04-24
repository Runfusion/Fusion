import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  Agent,
  AgentHeartbeatRun,
  AgentPerformanceSummary,
  AgentReflection,
  AgentStore,
  ReflectionMetrics,
  ReflectionStore,
  ReflectionTrigger,
  Task,
  TaskStore,
} from "@fusion/core";
import { createLogger } from "./logger.js";
import { createFnAgent, promptWithFallback } from "./pi.js";

const reflectionLog = createLogger("reflection");

const REFLECTION_SYSTEM_PROMPT = `You are an autonomous performance analyst reviewing an AI agent's recent execution history.

Your task is to identify concrete, actionable improvements from the provided metrics and outcomes.
Return STRICT JSON with this exact shape:
{
  "insights": ["short, specific observation"],
  "suggestedImprovements": ["actionable improvement"],
  "summary": "2-4 sentence synthesis"
}

Rules:
- Output valid JSON only (no markdown fences, no prose outside JSON).
- Keep insights specific to the provided evidence.
- Prefer improvements that can be applied in the agent's next run.
- Avoid generic advice unless strongly justified by data.`;

const DEFAULT_OUTCOME_LIMIT = 20;

interface ReflectionContext {
  agent: Agent;
  recentOutcomes: TaskOutcome[];
  performanceSummary: AgentPerformanceSummary | null;
  latestReflection: AgentReflection | null;
  instructions?: string;
}

interface TaskOutcome {
  taskId: string;
  outcome: "completed" | "failed" | "stuck";
  durationMs?: number;
  completedAt?: string;
}

interface ReflectionPayload {
  insights: string[];
  suggestedImprovements: string[];
  summary: string;
}

export interface AgentReflectionServiceOptions {
  agentStore: AgentStore;
  taskStore: TaskStore;
  reflectionStore: ReflectionStore;
  rootDir: string;
  modelProvider?: string;
  modelId?: string;
}

export class AgentReflectionService {
  private readonly agentStore: AgentStore;
  private readonly taskStore: TaskStore;
  private readonly reflectionStore: ReflectionStore;
  private readonly rootDir: string;
  private readonly modelProvider?: string;
  private readonly modelId?: string;

  constructor(options: AgentReflectionServiceOptions) {
    this.agentStore = options.agentStore;
    this.taskStore = options.taskStore;
    this.reflectionStore = options.reflectionStore;
    this.rootDir = options.rootDir;
    this.modelProvider = options.modelProvider;
    this.modelId = options.modelId;
  }

  async generateReflection(
    agentId: string,
    trigger: ReflectionTrigger,
    options: { taskId?: string; triggerDetail?: string } = {},
  ): Promise<AgentReflection | null> {
    try {
      const context = await this.buildReflectionContext(agentId);
      const recentRuns = await this.agentStore.getRecentRuns(agentId, DEFAULT_OUTCOME_LIMIT);

      if (context.recentOutcomes.length === 0 && recentRuns.length === 0) {
        reflectionLog.log(`Skipping reflection for ${agentId}: no recent tasks or heartbeat runs`);
        return null;
      }

      let responseText = "";
      const { session } = await createFnAgent({
        cwd: this.rootDir,
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        tools: "readonly",
        defaultProvider: this.modelProvider,
        defaultModelId: this.modelId,
        onText: (delta: string) => {
          responseText += delta;
        },
      });

      try {
        await promptWithFallback(session, this.buildReflectionPrompt(context, options.triggerDetail));

        const sessionError = (session.state as { errorMessage?: string; error?: string } | undefined);
        const stateErr = sessionError?.errorMessage ?? sessionError?.error;
        if (stateErr) {
          throw new Error(stateErr);
        }
      } finally {
        try {
          session.dispose();
        } catch {
          // best-effort cleanup
        }
      }

      const parsed = this.parseReflectionResponse(responseText);
      const metrics = this.buildReflectionMetrics(context.recentOutcomes, context.performanceSummary, recentRuns);

      return await this.reflectionStore.createReflection({
        agentId,
        trigger,
        triggerDetail: options.triggerDetail,
        taskId: options.taskId,
        metrics,
        insights: parsed.insights,
        suggestedImprovements: parsed.suggestedImprovements,
        summary: parsed.summary,
      });
    } catch (error) {
      reflectionLog.error(`Failed to generate reflection for ${agentId}: ${(error as Error).message}`);
      return null;
    }
  }

  async buildReflectionContext(agentId: string): Promise<ReflectionContext> {
    const [agentRecord, recentOutcomes, performanceSummaryRaw, latestReflection] = await Promise.all([
      this.agentStore.getAgent(agentId),
      this.getRecentTaskOutcomes(agentId, DEFAULT_OUTCOME_LIMIT),
      this.reflectionStore.getPerformanceSummary(agentId),
      this.reflectionStore.getLatestReflection(agentId),
    ]);

    const agent = agentRecord ?? this.createUnknownAgent(agentId);
    if (!agentRecord) {
      reflectionLog.warn(`Agent ${agentId} not found while building reflection context`);
    }

    const instructions = await this.resolveInstructions(agentRecord);
    const performanceSummary = this.isMeaningfulSummary(performanceSummaryRaw)
      ? performanceSummaryRaw
      : null;

    return {
      agent,
      recentOutcomes,
      performanceSummary,
      latestReflection,
      instructions,
    };
  }

  async getRecentTaskOutcomes(agentId: string, limit = DEFAULT_OUTCOME_LIMIT): Promise<TaskOutcome[]> {
    const effectiveLimit = Math.max(1, limit);

    const [tasks, recentRuns, agent] = await Promise.all([
      this.taskStore.listTasks({ slim: true, includeArchived: false }),
      this.agentStore.getRecentRuns(agentId, effectiveLimit * 4),
      this.agentStore.getAgent(agentId),
    ]);

    const recentTaskIdsFromRuns = this.extractTaskIdsFromRuns(recentRuns);
    const sortedByRecency = [...tasks].sort((a, b) => this.getTaskTimestampMs(b) - this.getTaskTimestampMs(a));
    const tasksToScan = sortedByRecency.slice(0, effectiveLimit * 2);

    const agentMentions = [agentId, agent?.name].filter((value): value is string => Boolean(value?.trim()));

    const outcomes: TaskOutcome[] = [];
    for (const task of tasksToScan) {
      if (!this.isTaskLinkedToAgent(task, agentId, recentTaskIdsFromRuns, agentMentions)) {
        continue;
      }

      const outcome = this.classifyOutcome(task);
      if (!outcome) {
        continue;
      }

      const durationMs = this.calculateDurationMs(task);
      const completedAt = this.resolveCompletedAt(task);

      outcomes.push({
        taskId: task.id,
        outcome,
        durationMs,
        completedAt,
      });

      if (outcomes.length >= effectiveLimit) {
        break;
      }
    }

    return outcomes;
  }

  async extractErrorPatterns(agentId: string): Promise<string[]> {
    const summary = await this.reflectionStore.getPerformanceSummary(agentId);
    if (!this.isMeaningfulSummary(summary)) {
      return [];
    }
    return summary.commonErrors ?? [];
  }

  private buildReflectionPrompt(context: ReflectionContext, triggerDetail?: string): string {
    const summary = {
      agent: {
        id: context.agent.id,
        name: context.agent.name,
        role: context.agent.role,
        state: context.agent.state,
      },
      triggerDetail,
      recentOutcomes: context.recentOutcomes,
      performanceSummary: context.performanceSummary,
      latestReflection: context.latestReflection
        ? {
            timestamp: context.latestReflection.timestamp,
            summary: context.latestReflection.summary,
            insights: context.latestReflection.insights,
            suggestedImprovements: context.latestReflection.suggestedImprovements,
          }
        : null,
      instructions: context.instructions,
    };

    return [
      "Analyze the following agent performance context and propose concrete improvements.",
      "Respond with strict JSON matching the required schema.",
      JSON.stringify(summary, null, 2),
    ].join("\n\n");
  }

  private parseReflectionResponse(rawResponse: string): ReflectionPayload {
    const candidate = this.extractJsonCandidate(rawResponse);

    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      reflectionLog.warn("Reflection response was not valid JSON; using fallback reflection payload");
      return {
        insights: ["Insufficient structured output from reflection model."],
        suggestedImprovements: ["Retry reflection with clearer historical context."],
        summary: "The reflection model did not return valid structured JSON.",
      };
    }

    const record = parsed as Partial<ReflectionPayload>;
    const insights = Array.isArray(record.insights)
      ? record.insights.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const suggestedImprovements = Array.isArray(record.suggestedImprovements)
      ? record.suggestedImprovements.map((value) => String(value).trim()).filter(Boolean)
      : [];
    const summary = typeof record.summary === "string" && record.summary.trim().length > 0
      ? record.summary.trim()
      : "No summary was provided by the reflection model.";

    return {
      insights: insights.length > 0 ? insights : ["No specific insights were identified."],
      suggestedImprovements: suggestedImprovements.length > 0
        ? suggestedImprovements
        : ["No concrete improvements were suggested."],
      summary,
    };
  }

  private extractJsonCandidate(rawResponse: string): string {
    const trimmed = rawResponse.trim();
    if (!trimmed) {
      return "{}";
    }

    if (trimmed.startsWith("```") && trimmed.endsWith("```")) {
      const withoutFences = trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      return withoutFences || "{}";
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }

    return trimmed;
  }

  private buildReflectionMetrics(
    outcomes: TaskOutcome[],
    performanceSummary: AgentPerformanceSummary | null,
    recentRuns: AgentHeartbeatRun[],
  ): ReflectionMetrics {
    const tasksCompleted = outcomes.filter((outcome) => outcome.outcome === "completed").length;
    const tasksFailed = outcomes.filter((outcome) => outcome.outcome !== "completed").length;

    const durations = outcomes
      .map((outcome) => outcome.durationMs)
      .filter((duration): duration is number => typeof duration === "number" && Number.isFinite(duration));

    const avgDurationMs = durations.length > 0
      ? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
      : performanceSummary?.avgDurationMs ?? 0;

    const runErrors = recentRuns
      .map((run) => this.extractRunError(run))
      .filter((value): value is string => Boolean(value));

    const mergedErrors = [
      ...(performanceSummary?.commonErrors ?? []),
      ...outcomes.filter((outcome) => outcome.outcome !== "completed").map((outcome) => `${outcome.outcome}: ${outcome.taskId}`),
      ...runErrors,
    ];

    const commonErrors = Array.from(new Set(mergedErrors.map((error) => error.trim()).filter(Boolean))).slice(0, 10);

    return {
      tasksCompleted,
      tasksFailed,
      avgDurationMs,
      commonErrors,
    };
  }

  private extractRunError(run: AgentHeartbeatRun): string | null {
    if (typeof run.stderrExcerpt === "string" && run.stderrExcerpt.trim()) {
      return run.stderrExcerpt.trim().split("\n")[0] ?? null;
    }

    const resultError = run.resultJson && typeof run.resultJson.error === "string"
      ? run.resultJson.error.trim()
      : "";

    if (resultError) {
      return resultError;
    }

    return null;
  }

  private extractTaskIdsFromRuns(runs: AgentHeartbeatRun[]): Set<string> {
    const ids = new Set<string>();
    for (const run of runs) {
      const taskId = run.contextSnapshot?.taskId;
      if (typeof taskId === "string" && taskId.trim()) {
        ids.add(taskId.trim());
      }
    }
    return ids;
  }

  private classifyOutcome(task: Task): TaskOutcome["outcome"] | null {
    const normalizedStatus = task.status?.toLowerCase() ?? "";
    const hasStuckSignal =
      normalizedStatus.includes("stuck")
      || task.log.some((entry) => {
        const action = entry.action.toLowerCase();
        return action.includes("stuck") || action.includes("terminated due to stuck");
      });

    if (hasStuckSignal) {
      return "stuck";
    }

    if (normalizedStatus.includes("failed")) {
      return "failed";
    }

    if (task.column === "done" || task.column === "in-review") {
      return "completed";
    }

    return null;
  }

  private isTaskLinkedToAgent(
    task: Task,
    agentId: string,
    recentTaskIdsFromRuns: Set<string>,
    agentMentions: string[],
  ): boolean {
    if (task.assignedAgentId === agentId) {
      return true;
    }

    if (recentTaskIdsFromRuns.has(task.id)) {
      return true;
    }

    if (agentMentions.length === 0) {
      return false;
    }

    return task.log.some((entry) => {
      const content = `${entry.action} ${entry.outcome ?? ""}`.toLowerCase();
      return agentMentions.some((mention) => content.includes(mention.toLowerCase()));
    });
  }

  private calculateDurationMs(task: Task): number | undefined {
    const startedAtMs = Date.parse(task.createdAt);
    const completedAtIso = this.resolveCompletedAt(task);
    const completedAtMs = completedAtIso ? Date.parse(completedAtIso) : Date.parse(task.updatedAt);

    if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs <= startedAtMs) {
      return undefined;
    }

    return completedAtMs - startedAtMs;
  }

  private resolveCompletedAt(task: Task): string | undefined {
    return task.columnMovedAt ?? task.updatedAt;
  }

  private async resolveInstructions(agent: Agent | null): Promise<string | undefined> {
    if (!agent) {
      return undefined;
    }

    const pieces: string[] = [];

    if (agent.instructionsText?.trim()) {
      pieces.push(agent.instructionsText.trim());
    }

    if (agent.instructionsPath?.trim()) {
      const resolvedPath = isAbsolute(agent.instructionsPath)
        ? agent.instructionsPath
        : resolve(this.rootDir, agent.instructionsPath);

      try {
        const content = await readFile(resolvedPath, "utf-8");
        if (content.trim()) {
          pieces.push(content.trim());
        }
      } catch (error) {
        reflectionLog.warn(
          `Unable to read instructions file for ${agent.id} at ${agent.instructionsPath}: ${(error as Error).message}`,
        );
      }
    }

    return pieces.length > 0 ? pieces.join("\n\n") : undefined;
  }

  private isMeaningfulSummary(summary: AgentPerformanceSummary): boolean {
    return summary.recentReflectionCount > 0
      || summary.totalTasksCompleted > 0
      || summary.totalTasksFailed > 0
      || summary.commonErrors.length > 0
      || summary.strengths.length > 0
      || summary.weaknesses.length > 0;
  }

  private createUnknownAgent(agentId: string): Agent {
    const now = new Date().toISOString();
    return {
      id: agentId,
      name: `Unknown Agent (${agentId})`,
      role: "custom",
      state: "idle",
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };
  }

  private getTaskTimestampMs(task: Task): number {
    const candidate = task.columnMovedAt ?? task.updatedAt ?? task.createdAt;
    const timestamp = Date.parse(candidate);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }
}
