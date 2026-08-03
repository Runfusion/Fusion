/**
 * FNXC:CodeOrganization 2026-08-03-12:00:
 * buildCodeNodeRunner peeled from TaskExecutor (U4).
 * Wires createCodeNodeRunner with task store artifact/cwd/custom-field adapters.
 */
import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { createCodeNodeRunner } from "../execution/code-node-runner.js";
import type { CodeNodeRunner } from "../workflows/workflow-node-handlers.js";


export type BuildCodeNodeRunnerDeps = {
  store: TaskStore;
  rootDir: string;
  readTaskArtifact: (taskId: string, key: string) => Promise<string | undefined | null>;
};

export function buildCodeNodeRunner(deps: BuildCodeNodeRunnerDeps): CodeNodeRunner {
  return createCodeNodeRunner({
    resolveCwd: async (task): Promise<string> => {
      try {
        return (await deps.store.getTask(task.id)).worktree || deps.rootDir;
      } catch {
        return deps.rootDir;
      }
    },
    readArtifacts: async (task): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      try {
        const docs = await deps.store.getTaskDocuments(task.id);
        for (const doc of docs) out[doc.key] = doc.content;
      } catch {
        // No documents — pass an empty artifact map.
      }
      // Surface PROMPT.md from the task prompt when not already a document
      // (shared artifact-read fallback — FIX 7).
      if (out["PROMPT.md"] === undefined) {
        const prompt = await deps.readTaskArtifact(task.id, "PROMPT.md");
        if (typeof prompt === "string") out["PROMPT.md"] = prompt;
      }
      return out;
    },
    writeCustomFields: async (task, patch) => {
      if (typeof deps.store.updateTaskCustomFields !== "function") {
        return {
          ok: false as const,
          rejection: { code: "no-fields-defined" as const, fieldId: "", detail: "custom fields unsupported by store" },
        };
      }
      const result = await deps.store.updateTaskCustomFields(task.id, patch);
      return result.ok ? { ok: true as const } : { ok: false as const, rejection: result.rejection };
    },
    audit: (reason, detail) => {
      executorLog.warn(`[code-node] ${reason}: ${detail}`);
    },
  });
}
