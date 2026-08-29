/**
 * FNXC:CodeOrganization 2026-08-03-18:30:
 * generateCompletionFeatureVideo + awaitFeatureVideoBounded peeled from TaskExecutor (U4).
 *
 * FNXC:ReviewArtifacts 2026-07-19-10:00:
 * A successful executor handoff may offer reviewers a short local feature-video, but capture is
 * strictly best-effort. Bound and swallow this optional work before the review transition so
 * browser, scenario, and artifact failures never delay or fail it.
 */
import type { Task, TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import {
  generateFeatureVideo,
  type FeatureVideoResult,
  type GenerateFeatureVideoOptions,
} from "../review-artifacts/feature-video.js";

export type CompletionFeatureVideoDeps = {
  store: TaskStore;
  options: {
    reviewArtifactGenerator?: (opts: GenerateFeatureVideoOptions) => Promise<FeatureVideoResult>;
    [k: string]: unknown;
  };
};

const FEATURE_VIDEO_TIMEOUT_MS = 20_000;

export async function awaitFeatureVideoBounded(
  result: Promise<FeatureVideoResult>,
): Promise<FeatureVideoResult> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("feature-video timeout")), FEATURE_VIDEO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function generateCompletionFeatureVideo(
  deps: CompletionFeatureVideoDeps,
  task: Task,
): Promise<void> {
  try {
    const [settings, detail] = await Promise.all([deps.store.getSettings(), deps.store.getTask(task.id)]);
    const generator = deps.options.reviewArtifactGenerator ?? generateFeatureVideo;
    const result = await awaitFeatureVideoBounded(generator({ store: deps.store, task: detail ?? task, settings }));
    executorLog.log(`${task.id}: feature-video ${result.status}${"reason" in result ? ` (${result.reason})` : ""}`);
  } catch (error) {
    executorLog.warn(`${task.id}: feature-video capture ignored: ${error instanceof Error ? error.message : String(error)}`);
  }
}
