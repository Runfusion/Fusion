import type { CePipelineStore } from "./pipeline-store.js";

/**
 * The CE marker plugin id recorded on every CE-originated board task and link.
 * Kept here (separate from the orchestrator) so both the work-bridge AND the
 * reconciler can build the identical provenance payload without importing the
 * orchestrator module (which would create a cycle through pipeline-store).
 */
export const CE_PLUGIN_ID = "fusion-plugin-compound-engineering";

/**
 * SourceType chosen for CE-originated automated work. The work stage is a step in
 * the CE pipeline, so `workflow_step` is the closest existing provenance value
 * (vs. inventing a new SourceType). The CE marker + back-reference convenience
 * copy ride in `sourceMetadata`; the authoritative link is the pipeline-link row.
 */
export const CE_WORK_SOURCE_TYPE = "workflow_step" as const;

/** What a CE task+link pair needs: provenance ids plus the board task content. */
export interface CreateCeTaskWithLinkSpec {
  title?: string;
  description: string;
  column?: string;
  cePipelineId: string;
  ceStageId: string;
  ceArtifactPath: string | null;
}

/**
 * Build the shared CE provenance+link contract: create a board task tagged
 * CE-originated (source payload) and record the authoritative pipeline-link row
 * (FN-5719) resolving task→pipeline/stage/artifact. Returns the created task.
 *
 * This is the single source of truth for that contract — both the orchestrator's
 * work bridge and the reconciler's outbound advance use it so the provenance
 * payload and link row can never drift apart.
 */
export async function createCeTaskWithLink<T extends { id: string }>(
  taskStore: { createTask(input: unknown): Promise<T> },
  pipelineStore: CePipelineStore,
  spec: CreateCeTaskWithLinkSpec,
): Promise<T> {
  const task = await taskStore.createTask({
    title: spec.title,
    description: spec.description,
    column: spec.column as never,
    source: {
      sourceType: CE_WORK_SOURCE_TYPE,
      sourceSessionId: spec.cePipelineId,
      sourceMetadata: {
        pluginId: CE_PLUGIN_ID,
        cePipelineId: spec.cePipelineId,
        ceStageId: spec.ceStageId,
        ceArtifactPath: spec.ceArtifactPath,
      },
    },
  });

  await pipelineStore.createLinkAsync({
    taskId: task.id,
    cePipelineId: spec.cePipelineId,
    ceStageId: spec.ceStageId,
    ceArtifactPath: spec.ceArtifactPath,
  });

  return task;
}
