/**
 * FNXC:SymbolLock 2026-07-30-14:00:
 * Mission-lineage scheduler admission needs a durable, project-scoped seam for
 * protecting code symbols before later scheduling phases consume it. These
 * opaque normalized keys deliberately avoid storing raw planning prose.
 */
export type SymbolLockStatus = "held" | "released" | "expired";

export interface SymbolLockIdentity {
  projectId: string;
  symbolKey: string;
  normalizedSymbol: string;
}

export interface SymbolLockOwner {
  ownerTaskId: string;
  missionId?: string;
  featureId?: string;
  lineageId?: string;
  nodeId?: string;
  agentId?: string;
}

export interface SymbolLockLease {
  status: SymbolLockStatus;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
}

export interface SymbolLock extends SymbolLockIdentity, SymbolLockOwner, SymbolLockLease {}

export interface SymbolLockConflict {
  symbolKey: string;
  ownerTaskId: string;
  missionId?: string;
  featureId?: string;
  lineageId?: string;
  nodeId?: string;
  agentId?: string;
  expiresAt: string;
}

export type AcquireSymbolLocksResult =
  | { acquired: true; locks: SymbolLock[]; conflicts: [] }
  | { acquired: false; locks: []; conflicts: SymbolLockConflict[] };

export interface RenewSymbolLocksResult {
  renewed: string[];
  lost: string[];
}

export interface ReleaseSymbolLocksResult {
  released: string[];
}

export interface ReconcileStaleSymbolLocksResult {
  reconciled: string[];
  skipped: string[];
}
