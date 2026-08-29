/**
 * INTERIM ORCHESTRATOR. FN-3779 replaces this with cadence-registry + cron-sentinel wiring;
 * FN-3780 replaces the aggregate dependency with the real aggregation layer.
 * Keep the `ReportsPipelineDependencies` shape stable so both can plug in without callsite churn.
 */
import type { ReportsAggregator } from "./aggregation.js";
import type { ReportsCadence } from "./cadence.js";
import type { ReportRunRecord, ReportsRunsStore } from "./runs-store.js";

export interface ReportsPipelineDependencies {
  runsStore: ReportsRunsStore;
  aggregate: ReportsAggregator;
}

export interface StartPipelineInput {
  runId: string;
  cadence: ReportsCadence;
  settings: Record<string, unknown>;
  now?: Date;
}

export async function startReportsPipeline(
  input: StartPipelineInput,
  deps: ReportsPipelineDependencies,
): Promise<ReportRunRecord> {
  const nowIso = (input.now ?? new Date()).toISOString();

  const created = await deps.runsStore.create({
    id: input.runId,
    cadence: input.cadence,
    status: "queued",
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  await deps.runsStore.update(input.runId, { status: "running", updatedAt: nowIso });

  try {
    await deps.aggregate({
      runId: input.runId,
      cadence: input.cadence,
      settings: input.settings,
    });

    const updatedAt = new Date().toISOString();
    const reviewed = await deps.runsStore.update(input.runId, { status: "review", updatedAt });
    return reviewed ?? { ...created, status: "review", updatedAt };
  } catch (error) {
    const updatedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const failed = await deps.runsStore.update(input.runId, {
      status: "failed",
      error: message,
      updatedAt,
    });
    return failed ?? { ...created, status: "failed", error: message, updatedAt };
  }
}
