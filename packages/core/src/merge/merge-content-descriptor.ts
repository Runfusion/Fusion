import { isWorkspaceTask, type Task } from "../types.js";

export type MergeContentDescriptor =
  | { kind: "singular"; diff: { state: "fingerprint"; fingerprint: string } | { state: "empty" } | { state: "unavailable"; reason: string } }
  | { kind: "workspace"; repositories: { state: "captured"; fingerprints: Record<string, string>; inScopeModified: string[] } | { state: "unavailable"; reason: string } };

/** Distinguish the N-repository workspace proof from a single worktree diff. */
export function describeMergeContentShape(task: Pick<Task, "workspaceWorktrees">): MergeContentDescriptor["kind"] {
  return isWorkspaceTask(task) ? "workspace" : "singular";
}
