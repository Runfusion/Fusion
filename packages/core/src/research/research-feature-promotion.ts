import type { AsyncResearchStore } from "../async-stores/async-research-store.js";
import type { AsyncMissionStore } from "../async-stores/async-mission-store.js";
import { NOOP_RECALL_CAPTURE_WRITER, type RecallCaptureWriter } from "../memory/recall-capture.js";
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
  recallCaptureWriter: RecallCaptureWriter = NOOP_RECALL_CAPTURE_WRITER,
) {
  const run = await researchStore.getRun(input.runId);
  if (!run) throw new Error(`Research run ${input.runId} not found`);
  if (run.status !== "completed") throw new Error(`Research run ${input.runId} is not completed`);
  const finding = (run.results?.findings ?? []).find((candidate) => resolveResearchFindingId(candidate) === input.findingId);
  if (!finding) throw new Error(`Finding ${input.findingId} not found`);
  const findingId = resolveResearchFindingId(finding);
  const sourceUrls = [...new Set((finding.sources ?? []).map((url) => url.trim()).filter(Boolean))];
  const title = input.title?.trim() || finding.heading?.trim() || "Research finding";
  const description = input.description?.trim() || finding.content?.trim() || undefined;
  const promoted = await missionStore.addResearchFeature(input.sliceId, {
    title,
    description,
    acceptanceCriteria: input.acceptanceCriteria?.trim() || undefined,
    researchProvenance: { researchRunId: run.id, findingId, sourceUrls },
  });

  /*
  FNXC:ResearchRecallCapture 2026-08-11-10:56:
  Promotion must return as soon as its canonical mission write commits. Recall is a best-effort
  projection, so its void-only writer records the promoted finding without delaying or failing the
  roadmap action.
  */
  recallCaptureWriter.capture({
    origin: "research-finding",
    title,
    summary: `Research finding ${findingId} from completed run ${run.id} was promoted to the roadmap.`,
    researchRunId: run.id,
    findingId,
    tags: ["research", "promotion", ...run.tags],
  });
  return { ...promoted, runId: run.id, findingId, citations: sourceUrls };
}
