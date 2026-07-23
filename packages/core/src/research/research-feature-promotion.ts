import type { AsyncResearchStore } from "../async-stores/async-research-store.js";
import type { AsyncMissionStore } from "../async-stores/async-mission-store.js";
import { resolveResearchFindingId } from "./research-types.js";

export type ResearchFeaturePromotionInput = {
  runId: string;
  findingId: string;
  sliceId: string;
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
};

/**
 * FNXC:ResearchMissionBridge 2026-07-18-12:00:
 * Engine tools and dashboard routes share this completed-run gate so a route
 * cannot create roadmap work for a nonterminal or position-shifted finding.
 */
export async function promoteResearchFinding(
  researchStore: Pick<AsyncResearchStore, "getRun">,
  missionStore: Pick<AsyncMissionStore, "addResearchFeature">,
  input: ResearchFeaturePromotionInput,
) {
  const run = await researchStore.getRun(input.runId);
  if (!run) throw new Error(`Research run ${input.runId} not found`);
  if (run.status !== "completed") throw new Error(`Research run ${input.runId} is not completed`);
  const finding = (run.results?.findings ?? []).find((candidate) => resolveResearchFindingId(candidate) === input.findingId);
  if (!finding) throw new Error(`Finding ${input.findingId} not found`);
  const findingId = resolveResearchFindingId(finding);
  const sourceUrls = [...new Set((finding.sources ?? []).map((url) => url.trim()).filter(Boolean))];
  const promoted = await missionStore.addResearchFeature(input.sliceId, {
    title: input.title?.trim() || finding.heading?.trim() || "Research finding",
    description: input.description?.trim() || finding.content?.trim() || undefined,
    acceptanceCriteria: input.acceptanceCriteria?.trim() || undefined,
    researchProvenance: { researchRunId: run.id, findingId, sourceUrls },
  });
  return { ...promoted, runId: run.id, findingId, citations: sourceUrls };
}
