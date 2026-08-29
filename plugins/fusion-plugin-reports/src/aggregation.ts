/**
 * INTERIM SEAM — replaced by FN-3780's real aggregation orchestrator.
 * Keep the type surface stable so FN-3780 can swap the implementation without renaming exports.
 */
import type { ReportsCadence } from "./cadence.js";

export interface ReportAggregationInput {
  runId: string;
  cadence: ReportsCadence;
  settings: Record<string, unknown>;
}

export interface ReportAggregationOutput {
  summary: string;
  sections: Array<{ id: string; title: string; body: string }>;
}

export type ReportsAggregator = (input: ReportAggregationInput) => Promise<ReportAggregationOutput>;

export const aggregateReportData: ReportsAggregator = async ({ cadence }) => ({
  summary: `Aggregation scaffold not yet implemented for ${cadence} reports.`,
  sections: [],
});
