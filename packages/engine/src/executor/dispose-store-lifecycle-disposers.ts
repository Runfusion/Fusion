/**
 * FNXC:CodeOrganization 2026-08-03-19:00:
 * disposeStoreLifecycleDisposers peeled from TaskExecutor (U4).
 *
 * Remove only this executor's store-scoped lifecycle disposer registrations.
 */

export type DisposeStoreLifecycleDisposersDeps = {
  clearTaskMoveDisposer: () => void;
};

export function disposeStoreLifecycleDisposers(
  deps: DisposeStoreLifecycleDisposersDeps,
): void {
  deps.clearTaskMoveDisposer();
}
