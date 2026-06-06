import { isExperimentalFeatureEnabled } from "./experimental-features.js";
import type { Settings } from "./types.js";

/**
 * The `experimentalFeatures.companyModel` flag (company-model plan KTD-1). OFF:
 * execution semantics are byte-identical to today (ephemeral workers, triage
 * processor, entry-driven merge, no role teams, no CEO). ON: company-model
 * semantics apply — for U4 specifically, task execution on a company-model board
 * resolves to a persistent column agent and ephemeral worker creation is bypassed.
 *
 * Composed additively with `workflowColumns` / `workflowGraphExecutor` (which it
 * implies for board internals). Mirrors {@link isWorkflowColumnsEnabled} — a thin,
 * named accessor so the literal flag key lives in exactly one place.
 */
export function isCompanyModelEnabled(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
): boolean {
  return isExperimentalFeatureEnabled(settings, "companyModel");
}
