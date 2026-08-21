import type { UpdateInstallResult } from "./update-check.js";

/**
 * Process-local fence shared by timer and HTTP update paths. It deliberately
 * retains a successfully installed target until this process exits, because an
 * old process must never reinstall files that are waiting for its restart.
 */
export type PendingUpdateInstall = UpdateInstallResult & {
  restartAttempted: boolean;
  restartScheduled: boolean;
  priorPid?: number;
};

export class UpdateInstallCoordinator {
  private inFlight: Promise<UpdateInstallResult> | undefined;
  private pendingVersion: string | undefined;
  private pendingResult: UpdateInstallResult | undefined;
  private restartRequested = false;

  /**
   * FNXC:PendingUpdateInstall 2026-08-21-05:58:
   * A completed install belongs to the still-running old process, not a mounted
   * Settings dialog. Expose its target until process replacement so every route
   * can reject a second install and every dashboard remount can offer restart.
   */
  getPendingInstall(): PendingUpdateInstall | undefined {
    if (!this.pendingVersion || !this.pendingResult) return undefined;
    return {
      ...this.pendingResult,
      latestVersion: this.pendingVersion,
      restartAttempted: this.restartRequested,
      restartScheduled: this.restartRequested,
      priorPid: this.restartRequested ? process.pid : undefined,
    };
  }

  async install(targetVersion: string, operation: () => Promise<UpdateInstallResult>): Promise<UpdateInstallResult> {
    if (this.pendingVersion && this.pendingResult) return this.pendingResult;
    if (!this.inFlight) {
      this.inFlight = operation().then((result) => {
        if (result.updated && result.outcome === "installed") {
          this.pendingVersion = result.latestVersion ?? targetVersion;
          this.pendingResult = result;
        }
        return result;
      }).finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  requestRestart(request: () => boolean): boolean {
    if (this.restartRequested) return true;
    if (!request()) return false;
    this.restartRequested = true;
    return true;
  }
}

/** Shared by the dashboard watcher and update route in this host process. */
export const processUpdateInstallCoordinator = new UpdateInstallCoordinator();
