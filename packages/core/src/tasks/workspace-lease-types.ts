import type { Task } from "../types.js";

export type WorkspaceLeaseKind = "acquire" | "land" | "merge-dispatch";
export type WorkspaceLeaseStatus = "held" | "released" | "expired";
export type WorkspaceLeaseOwner = { taskId: string; nodeId: string; incarnationId: string; runId?: string };
export type WorkspaceLeaseHandle = { leaseKey: string; owner: WorkspaceLeaseOwner; fenceToken: bigint; expiresAt: string; fenceRefName?: string; fenceRefSha?: string };
export type WorkspaceLeaseClaimOutcome = "acquired" | "reentrant" | "reclaimed-expired" | "conflict";
export type WorkspaceLeaseFenceOutcome = "valid" | "superseded" | "missing" | "unknown";
export type WorkspaceLandIntentResolution = "landed" | "not-landed";
export type WorkspaceLandIntentResolveOutcome = "resolved" | "lease-live" | "stale-intent" | "superseded" | "missing";
export type WorkspaceLeaseReclaimOutcome = "reclaimed" | "stale-precondition" | "still-live" | "owner-unresolvable" | "missing";
export interface WorkspaceLease extends WorkspaceLeaseHandle { kind: WorkspaceLeaseKind; status: WorkspaceLeaseStatus; acquiredAt: string; renewedAt: string; }
export interface WorkspaceLeaseConflict { leaseKey: string; taskId: string; nodeId: string; incarnationId: string; fenceToken: bigint; expiresAt: string; }
export type AcquireWorkspaceLeaseResult = { outcome: Exclude<WorkspaceLeaseClaimOutcome, "conflict">; handle: WorkspaceLeaseHandle } | { outcome: "conflict"; conflict: WorkspaceLeaseConflict };
export interface WorkspaceLandIntent { taskId: string; repoRelPath: string; remoteUrl: string; integrationRef: string; intendedSha: string; expectedTip: string; fenceRefName: string; fenceRefSha: string; owner: WorkspaceLeaseOwner; fenceToken: bigint; status: "pending" | "recorded" | "abandoned"; resolvedSha?: string; resolution?: WorkspaceLandIntentResolution; createdAt: string; updatedAt: string; resolvedAt?: string; }

/**
 * FNXC:Workspace 2026-08-15-08:23:
 * Store reclaim and workspace self-healing share this deliberately narrow
 * terminal rule so either cannot reclaim a task the other considers live.
 *
 * DELIBERATE-LITERAL — narrow terminal-owner rule (FN-9059). A lease-owner row is
 * read without its workflow context, so resolving the complete lane per-workflow
 * here would let a resolver failure make a live owner read as terminal and allow a
 * competing reclaim. The legacy `done` literal is the intentionally conservative
 * shared floor for both reclaim paths.
 */
export function isTerminalWorkspaceLeaseOwner(row: Pick<Task, "column" | "status"> | null | undefined): boolean {
  return row != null && (row.column === "done" || row.status === "failed");
}
