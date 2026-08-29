import { useEffect, useSyncExternalStore } from "react";
import { checkForUpdate } from "../api";
import type { UpdateCheckResponse, UpdateInstallResponse } from "../api";

type Listener = () => void;
const listeners = new Set<Listener>();
let pendingInstall: UpdateInstallResponse | undefined;
let hydration: Promise<void> | undefined;

function publish(): void {
  listeners.forEach((listener) => listener());
}

function validPending(value: unknown): value is UpdateInstallResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<UpdateInstallResponse>;
  return candidate.updated === true
    && candidate.outcome !== "failed"
    && candidate.outcome !== "check-failed"
    && typeof candidate.currentVersion === "string"
    && typeof candidate.latestVersion === "string";
}

/**
 * FNXC:PendingUpdateInstall 2026-08-21-05:58:
 * The browser mirrors the old host's retained install without durable storage.
 * A successful result is monotonic for this page: stale empty checks and late
 * failures may not replace the restart action before process/page replacement.
 */
export const pendingUpdateInstallState = {
  getSnapshot: (): UpdateInstallResponse | undefined => pendingInstall,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  record(value: unknown): void {
    if (!validPending(value) || pendingInstall) return;
    pendingInstall = value;
    publish();
  },
  hydrate(): Promise<void> {
    if (!hydration) {
      hydration = checkForUpdate()
        .then((result: UpdateCheckResponse) => {
          this.record(result.pendingInstall);
        })
        .catch(() => {
          // Best effort: an existing success remains authoritative on transport failure.
        })
        .finally(() => { hydration = undefined; });
    }
    return hydration;
  },
};

export function usePendingUpdateInstall(options: { hydrate?: boolean } = {}): UpdateInstallResponse | undefined {
  const hydrate = options.hydrate !== false;
  const snapshot = useSyncExternalStore(
    pendingUpdateInstallState.subscribe,
    pendingUpdateInstallState.getSnapshot,
    pendingUpdateInstallState.getSnapshot,
  );

  useEffect(() => {
    if (hydrate) void pendingUpdateInstallState.hydrate();
  }, [hydrate]);

  return snapshot;
}

/** Test-only isolation for this module-level browser state. */
export function __test_resetPendingUpdateInstall(): void {
  hydration = undefined;
  pendingInstall = undefined;
  publish();
}
