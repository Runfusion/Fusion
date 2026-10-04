import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Settings } from "@fusion/core";
import { createPostMergeInspectionTool } from "./post-merge-evidence-inspection.js";
import { createTaskReadTools, isAgentTaskCreateToolAvailable } from "../agent-tools.js";
import {
  createTaskCreateTool,
  createTaskDocumentReadTool,
  createTaskDocumentWriteTool,
  type SharedWorkerToolsDeps,
} from "./shared-worker-tools.js";

/** Evidence publication and follow-up intake do not authorize edits to landed code. */
export function createPostMergeEvidenceTools(
  deps: SharedWorkerToolsDeps,
  taskId: string,
  settings: Settings,
  sourceAgentId?: string,
): ToolDefinition[] {
  return [
    createPostMergeInspectionTool(deps, taskId),
    createTaskDocumentReadTool(deps, taskId),
    createTaskDocumentWriteTool(deps, taskId),
    ...createTaskReadTools(deps.store),
    ...(isAgentTaskCreateToolAvailable(settings, true)
      ? [createTaskCreateTool(deps, true, taskId, sourceAgentId)]
      : []),
  ];
}
