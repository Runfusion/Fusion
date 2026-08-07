/**
 * FNXC:CodeOrganization 2026-08-03-17:15:
 * readTaskArtifact peeled from TaskExecutor (U4).
 *
 * Read a task artifact by key through the task-documents layer, falling back to
 * the task's own PROMPT content for the default `PROMPT.md` step-source artifact.
 */
import type { TaskStore } from "@fusion/core";

export type ReadTaskArtifactDeps = {
  store: TaskStore;
};

export async function readTaskArtifact(
  deps: ReadTaskArtifactDeps,
  taskId: string,
  key: string,
): Promise<string | undefined> {
  // Declared artifacts ride the task-documents layer.
  let documentReadError: unknown;
  try {
    const doc = await deps.store.getTaskDocument(taskId, key);
    if (doc) return doc.content;
  } catch (error) {
    documentReadError = error;
  }
  if (key === "PROMPT.md") {
    try {
      const detail = await deps.store.getTask(taskId);
      if (typeof detail.prompt === "string") return detail.prompt;
      return undefined;
    } catch (error) {
      throw new Error(
        `Unable to read required artifact ${key} from task documents or task storage: ${error instanceof Error ? error.message : String(error)}`,
        { cause: documentReadError ?? error },
      );
    }
  }
  if (documentReadError) throw documentReadError;
  return undefined;
}
