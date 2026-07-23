import {
  collectDeterministicSignals,
  computeOverallScore,
  normalizeCategoryScore,
  resolveScoreBand,
  resolveValidatorSettingsModel,
  EVAL_SCORE_CATEGORIES,
  type DeterministicSignals,
  type EvalScoreCategory,
  type EvalTaskResultCreateInput,
  type EvaluationEvidenceRef,
  type FollowUpDraft,
  type Settings,
  type TaskDetail,
  type TaskEvaluationEvidenceBundle,
  type TaskStore,
} from "@fusion/core";
import { collectTaskEvaluationEvidence } from "./evaluator-evidence.js";
import { materializeEvalFollowUps, normalizeEvalFollowUps, resolveEvalFollowUpPolicyMode } from "./eval-followups.js";
import { createFnAgent, promptWithFallback } from "../pi.js";
import { createLogger } from "../logger.js";
import { resolveMcpServersForStore } from "../mcp/mcp-resolution.js";

const log = createLogger("evaluator");

export interface EvalRunContext {
  runId: string;
  startedAt: string;
}

export interface EvaluatorModelOverride {
  provider?: string;
  modelId?: string;
}

export interface EvaluatorDeps {
  cwd: string;
  store?: TaskStore;
  runPrompt?: (prompt: string, provider?: string, modelId?: string) => Promise<string>;
  collectEvidence?: (params: { task: TaskDetail; runId: string; cwd: string; store: TaskStore }) => Promise<TaskEvaluationEvidenceBundle>;
}

interface EvaluatorAiCategoryResponse {
  score: number;
  rationale: string;
  evidence: EvaluationEvidenceRef[];
}

interface EvaluatorAiResponse {
  categories: Record<EvalScoreCategory, EvaluatorAiCategoryResponse>;
  overallRationale: string;
  followUpDrafts: FollowUpDraft[];
}

export function resolveEvaluatorModel(
  settings: Partial<Settings>,
  override?: EvaluatorModelOverride,
): { provider?: string; modelId?: string } {
  if (override?.provider && override?.modelId) {
    return { provider: override.provider, modelId: override.modelId };
  }
  // Temporary fallback until FN-3393 introduces dedicated evaluator settings.
  return resolveValidatorSettingsModel(settings);
}

export class HybridEvaluatorService {
  constructor(private readonly deps: EvaluatorDeps) {}

  async evaluateTask(
    task: TaskDetail,
    run: EvalRunContext,
    settings: Partial<Settings>,
    modelOverride?: EvaluatorModelOverride,
  ): Promise<Omit<EvalTaskResultCreateInput, "taskId" | "taskSnapshot">> {
    const deterministicSignals = collectDeterministicSignals(task, run);
    const model = resolveEvaluatorModel(settings, modelOverride);
    const evidenceBundle = this.deps.store
      ? await (this.deps.collectEvidence ?? collectTaskEvaluationEvidence)({
        store: this.deps.store,
        task,
        runId: run.runId,
        cwd: this.deps.cwd,
      })
      : undefined;
    const prompt = buildEvaluationPrompt(task, run, deterministicSignals, evidenceBundle);
    const responseText = await this.runPrompt(prompt, model.provider, model.modelId);
    const ai = parseAiResponse(responseText);

    const categoryScores = EVAL_SCORE_CATEGORIES.map((category) => {
      const aiCategory = ai.categories[category];
      return normalizeCategoryScore({
        category,
        deterministicScore: deriveDeterministicCategoryScore(category, deterministicSignals),
        aiScore: aiCategory.score,
        rationale: aiCategory.rationale,
        evidence: aiCategory.evidence.map((ev) => ({
          type: "other",
          ref: `${ev.kind}:${ev.label}`,
          excerpt: ev.value,
          metadata: { source: ev.source },
        })),
      });
    });

    const overallScore = computeOverallScore(categoryScores);
    const followUpPolicyMode = resolveEvalFollowUpPolicyMode(settings.taskEvaluationFollowUpPolicy);
    const followUps = this.deps.store
      ? await materializeEvalFollowUps({
        parentTaskId: task.id,
        runId: run.runId,
        policyMode: followUpPolicyMode,
        overallScore,
        store: this.deps.store,
        followUps: await normalizeEvalFollowUps({
          parentTaskId: task.id,
          runId: run.runId,
          overallBand: resolveScoreBand(overallScore),
          drafts: ai.followUpDrafts,
          store: this.deps.store,
          policyMode: followUpPolicyMode,
        }),
      })
      : [];

    return {
      status: "scored",
      overallScore,
      categoryScores,
      rationale: ai.overallRationale,
      summary: ai.overallRationale,
      evidence: categoryScores.flatMap((categoryScore) => categoryScore.evidence),
      evidenceBundle,
      deterministicSignals: deterministicSignalsToEvalSignals(deterministicSignals),
      followUps,
      metadata: {
        runId: run.runId,
        evaluatorModel: model,
        evaluatorRationale: ai.overallRationale,
        hybridEvaluation: {
          deterministicSignals,
          ai,
        },
      },
    };
  }

  private async runPrompt(prompt: string, provider?: string, modelId?: string): Promise<string> {
    if (this.deps.runPrompt) {
      return this.deps.runPrompt(prompt, provider, modelId);
    }

    let text = "";
    // FNXC:McpConfig 2026-06-25-23:05: Evaluator sessions are an AI lane and receive the store-resolved MCP set at session creation; createFnAgent applies runtime support gating without logging plaintext env/header secrets.
    const { session } = await createFnAgent({
      cwd: this.deps.cwd,
      systemPrompt: "You are a strict evaluator. Reply with JSON only.",
      tools: "readonly",
      defaultProvider: provider,
      defaultModelId: modelId,
      mcpServers: this.deps.store ? (await resolveMcpServersForStore(this.deps.store)).servers : undefined,
      onText: (delta) => {
        text += delta;
      },
    });

    try {
      await promptWithFallback(session, prompt);
      return text;
    } finally {
      try {
        session.dispose();
      } catch (error) {
        log.warn(`Evaluator session disposal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

function deriveDeterministicCategoryScore(category: EvalScoreCategory, signals: DeterministicSignals): number {
  const workflowPassRate = signals.workflowSummary.total > 0
    ? (signals.workflowSummary.passed / signals.workflowSummary.total) * 100
    : 50;
  const errorPenalty = Math.min(signals.logSummary.errorCount * 20, 60);
  const warningPenalty = Math.min(signals.logSummary.warningCount * 5, 25);
  const commitScore = Math.min(signals.commitSummary.commitCount * 15, 100);
  const reviewScore = signals.reviewStatus === "approved" ? 100 : signals.reviewStatus ? 70 : 50;

  switch (category) {
    case "agentPerformance":
      return Math.round(Math.max(0, Math.min(100, (workflowPassRate * 0.5) + (reviewScore * 0.3) + (commitScore * 0.2) - warningPenalty)));
    case "taskOutcomeQuality":
      return Math.round(Math.max(0, Math.min(100, (workflowPassRate * 0.6) + (commitScore * 0.2) + (100 - errorPenalty) * 0.2)));
    case "processCompliance":
      return Math.round(Math.max(0, Math.min(100, (workflowPassRate * 0.5) + (reviewScore * 0.3) + ((signals.logSummary.timingEntries > 0 ? 100 : 50) * 0.2) - errorPenalty)));
    default:
      throw new Error(`Unsupported eval score category: ${String(category)}`);
  }
}

function deterministicSignalsToEvalSignals(signals: DeterministicSignals): Array<{ signalId: string; kind: string; name: string; value?: string | number; passed?: boolean }> {
  return [
    {
      signalId: "workflow-summary",
      kind: "workflow",
      name: "workflow-summary",
      value: `${signals.workflowSummary.passed}/${signals.workflowSummary.total}`,
      passed: signals.workflowSummary.failed === 0,
    },
    {
      signalId: "timing-ms",
      kind: "timing",
      name: "timed-execution-ms",
      value: signals.timedExecutionMs,
    },
    {
      signalId: "commit-count",
      kind: "commit",
      name: "commit-count",
      value: signals.commitSummary.commitCount,
    },
  ];
}

function formatEvidenceForPrompt(evidenceBundle: TaskEvaluationEvidenceBundle): string {
  return JSON.stringify({
    sourceOrder: evidenceBundle.sourceOrder,
    taskMetadata: evidenceBundle.taskMetadata,
    commits: evidenceBundle.commits,
    workflow: evidenceBundle.workflow,
    reviews: evidenceBundle.reviews,
    documents: evidenceBundle.documents,
    taskActivity: evidenceBundle.taskActivity,
    agentLogs: evidenceBundle.agentLogs,
    runAudit: evidenceBundle.runAudit,
  }, null, 2);
}

export function buildEvaluationPrompt(
  task: TaskDetail,
  run: EvalRunContext,
  deterministicSignals: DeterministicSignals,
  evidenceBundle?: TaskEvaluationEvidenceBundle,
): string {
  return [
    "Evaluate the completed task and respond with strict JSON.",
    "Scores must be integers between 0 and 100.",
    "When citing evidence, use labels that include evidence IDs from the ## Evidence section.",
    `Run: ${run.runId}`,
    "Schema:",
    JSON.stringify({
      categories: {
        agentPerformance: { score: 0, rationale: "", evidence: [{ kind: "task", label: "", value: "", source: "" }] },
        taskOutcomeQuality: { score: 0, rationale: "", evidence: [{ kind: "task", label: "", value: "", source: "" }] },
        processCompliance: { score: 0, rationale: "", evidence: [{ kind: "task", label: "", value: "", source: "" }] },
      },
      overallRationale: "",
      followUpDrafts: [{ title: "", description: "", reason: "", evidenceRefs: [] }],
    }, null, 2),
    "Task:",
    JSON.stringify({
      id: task.id,
      title: task.title,
      column: task.column,
      status: task.status,
      summary: task.summary,
    }, null, 2),
    "Deterministic signals:",
    JSON.stringify(deterministicSignals, null, 2),
    "## Evidence",
    evidenceBundle ? formatEvidenceForPrompt(evidenceBundle) : JSON.stringify({ sourceOrder: [], note: "No evidence bundle available" }, null, 2),
  ].join("\n\n");
}

export function parseAiResponse(raw: string): EvaluatorAiResponse {
  const candidate = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Evaluator AI response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const record = parsed as Partial<EvaluatorAiResponse>;
  if (!record.categories || typeof record.categories !== "object") throw new Error("Evaluator response missing categories");
  if (typeof record.overallRationale !== "string" || !record.overallRationale.trim()) throw new Error("Evaluator response missing overallRationale");

  const categories = {} as Record<EvalScoreCategory, EvaluatorAiCategoryResponse>;
  for (const category of EVAL_SCORE_CATEGORIES) {
    const entry = (record.categories as Record<string, EvaluatorAiCategoryResponse>)[category];
    if (!entry) throw new Error(`Evaluator response missing category ${category}`);
    if (!Number.isInteger(entry.score) || entry.score < 0 || entry.score > 100) {
      throw new Error(`Evaluator category ${category} score must be an integer in 0..100`);
    }
    if (typeof entry.rationale !== "string" || !entry.rationale.trim()) {
      throw new Error(`Evaluator category ${category} rationale is required`);
    }
    if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
      throw new Error(`Evaluator category ${category} evidence is required`);
    }
    categories[category] = entry;
  }

  return {
    categories,
    overallRationale: record.overallRationale,
    followUpDrafts: Array.isArray(record.followUpDrafts) ? record.followUpDrafts : [],
  };
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}
