/**
 * FNXC:CodeOrganization 2026-08-03-22:05:
 * Simple worker-agent tool factories peeled from TaskExecutor (U4).
 *
 * These are thin wrappers over shared agent-tools factories. Kept free so
 * runImplementation can assemble the tool surface without one TaskExecutor
 * method per factory (and without bloating the runImplementation deps bag).
 *
 * FNXC:ArtifactRegistry 2026-07-10-14:30:
 * fn_artifact_register anchors relative paths at the task worktree and defaults
 * taskId to the executing task so agent media surfaces in the Artifacts tab.
 *
 * FNXC:EphemeralAgentTaskCreation 2026-07-01-00:00:
 * Pass callerIsEphemeral so fn_task_create honors ephemeralAgentsCanCreateTasks.
 *
 * FNXC:FileScope 2026-07-08-22:40:
 * fn_task_file_scope_add lets the coding agent extend declared ## File Scope at runtime.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "@fusion/core";
import type { EngineRunContext } from "../util/run-audit.js";
import {
  createArtifactListTool as sharedCreateArtifactListTool,
  createArtifactRegisterTool as sharedCreateArtifactRegisterTool,
  createArtifactViewTool as sharedCreateArtifactViewTool,
  createTaskCreateTool as sharedCreateTaskCreateTool,
  createTaskDocumentReadTool as sharedCreateTaskDocumentReadTool,
  createTaskDocumentWriteTool as sharedCreateTaskDocumentWriteTool,
  createTaskPromptWriteTool as sharedCreateTaskPromptWriteTool,
  createTaskFileScopeAddTool as sharedCreateTaskFileScopeAddTool,
  createTaskLogTool as sharedCreateTaskLogTool,
  createTaskLogsReadTool as sharedCreateTaskLogsReadTool,
  createWorkflowListTool as sharedCreateWorkflowListTool,
  createWorkflowGetTool as sharedCreateWorkflowGetTool,
  createWorkflowValidateTool as sharedCreateWorkflowValidateTool,
  createWorkflowSelectTool as sharedCreateWorkflowSelectTool,
  createTaskPromoteTool as sharedCreateTaskPromoteTool,
  createWorkflowCreateTool as sharedCreateWorkflowCreateTool,
  createWorkflowUpdateTool as sharedCreateWorkflowUpdateTool,
  createWorkflowDeleteTool as sharedCreateWorkflowDeleteTool,
  createWorkflowSettingsTool as sharedCreateWorkflowSettingsTool,
  createTraitListTool as sharedCreateTraitListTool,
} from "../agent-tools.js";

export type SharedWorkerToolsDeps = {
  store: TaskStore;
  rootDir: string;
  messageStore?: import("@fusion/core").MessageStore;
  getRunContextFor: (taskId: string) => EngineRunContext | undefined;
};

export function createTaskLogTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskLogTool(deps.store, taskId);
}

export function createTaskLogsReadTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskLogsReadTool(deps.store, taskId);
}

export function createTaskCreateTool(
  deps: SharedWorkerToolsDeps,
  callerIsEphemeral: boolean,
  sourceTaskId?: string,
  sourceAgentId?: string,
): ToolDefinition {
  return sharedCreateTaskCreateTool(
    deps.store,
    { sourceType: "api", sourceAgentId, sourceParentTaskId: sourceTaskId },
    {
      rootDir: deps.rootDir,
      callerIsEphemeral,
      sourceTaskId,
      sourceAgentId,
      messageStore: deps.messageStore,
    },
  );
}

export function createTaskDocumentWriteTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskDocumentWriteTool(deps.store, taskId);
}

export function createTaskDocumentReadTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskDocumentReadTool(deps.store, taskId);
}

export function createTaskPromptWriteTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskPromptWriteTool(deps.store, taskId, deps.getRunContextFor(taskId));
}

export function createTaskFileScopeAddTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskFileScopeAddTool(deps.store, taskId, deps.getRunContextFor(taskId));
}

export function createArtifactRegisterTool(
  deps: SharedWorkerToolsDeps,
  authorId: string,
  taskId: string,
  worktreePath: string,
): ToolDefinition {
  return sharedCreateArtifactRegisterTool(deps.store, authorId, deps.messageStore, {
    baseDir: worktreePath,
    defaultTaskId: taskId,
  });
}

export function createArtifactListTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateArtifactListTool(deps.store);
}

export function createArtifactViewTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateArtifactViewTool(deps.store);
}

export function createWorkflowListTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowListTool(deps.store);
}

export function createWorkflowGetTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowGetTool(deps.store);
}

export function createWorkflowValidateTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowValidateTool(deps.store);
}

export function createWorkflowSelectTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateWorkflowSelectTool(deps.store, taskId);
}

export function createTaskPromoteTool(deps: SharedWorkerToolsDeps, taskId: string): ToolDefinition {
  return sharedCreateTaskPromoteTool(deps.store, taskId);
}

export function createWorkflowCreateTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowCreateTool(deps.store);
}

export function createWorkflowUpdateTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowUpdateTool(deps.store);
}

export function createWorkflowDeleteTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowDeleteTool(deps.store);
}

export function createWorkflowSettingsTool(deps: SharedWorkerToolsDeps): ToolDefinition {
  return sharedCreateWorkflowSettingsTool(deps.store);
}

export function createTraitListTool(): ToolDefinition {
  return sharedCreateTraitListTool();
}
