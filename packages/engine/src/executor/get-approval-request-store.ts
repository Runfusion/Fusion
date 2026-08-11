/**
 * FNXC:CodeOrganization 2026-08-03-20:15:
 * approvalRequestStore lazy getter peeled from TaskExecutor (U4).
 *
 * FNXC:PostgresSatelliteCutover 2026-07-14-17:30:
 * Runtime approval persistence is PostgreSQL-only; never reopen the removed project SQLite database.
 */
import { ApprovalRequestStore } from "@fusion/core";
import type { TaskStore } from "@fusion/core";

export type GetApprovalRequestStoreState = {
  getCache: () => ApprovalRequestStore | undefined;
  setCache: (value: ApprovalRequestStore) => void;
  store: TaskStore;
};

export function getApprovalRequestStore(state: GetApprovalRequestStoreState): ApprovalRequestStore {
  const existing = state.getCache();
  if (existing) return existing;
  const layer = state.store.getAsyncLayer();
  if (!layer) throw new Error("Executor TaskStore is missing its PostgreSQL AsyncDataLayer");
  /* FNXC:PostgresSatelliteCutover 2026-07-14-17:30: Runtime approval persistence is PostgreSQL-only; never reopen the removed project SQLite database when backend wiring is incomplete. */
  const created = new ApprovalRequestStore(null, { asyncLayer: layer });
  state.setCache(created);
  return created;
}
