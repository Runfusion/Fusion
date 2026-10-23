import { prMonitorLog } from "../logger.js";
import type { PrInfo } from "@fusion/core";
import {
  createDefaultPrMonitorGhClient,
  type PrMonitorGhClient,
} from "./pr-monitor-gh.js";

export interface TrackedPr {
  owner: string;
  repo: string;
  prInfo: PrInfo;
  lastCheckedAt: Date;
  lastCommentId?: number;
  consecutiveErrors: number;
  isActive: boolean; // true if we've seen recent activity
  /** Buffered comments collected since last drain, used for follow-up task creation. */
  bufferedComments: PrComment[];
  /** Set by finishMonitoring: no further polls, and a pending poll only buffers for the final drain. */
  finishing?: boolean;
}

export interface PrComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  updated_at: string;
  html_url: string;
}

export type OnNewCommentsCallback = (
  taskId: string,
  prInfo: PrInfo,
  comments: PrComment[]
) => void | Promise<void>;

interface PrMonitorOptions {
  /**
   * @deprecated Kept for backwards compatibility only. gh CLI auth is required.
   */
  getGitHubToken?: () => string | undefined;
  /** Internal seam for gh auth/comment polling behavior in tests. */
  ghClient?: PrMonitorGhClient;
}

/**
 * Monitors GitHub PRs for new comments.
 * Uses adaptive polling: 30s when active, 5min when idle.
 * Implements exponential backoff on errors.
 *
 * NOTE: Uses gh CLI for all GitHub operations. Requires gh CLI to be installed
 * and authenticated (run `gh auth login`). The GITHUB_TOKEN fallback is no
 * longer supported - monitoring will fail if gh CLI is not available.
 */
export class PrMonitor {
  private trackedPrs = new Map<string, TrackedPr>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private pendingChecks = new Map<string, Promise<boolean>>();
  private newCommentsCallback?: OnNewCommentsCallback;
  private readonly ghClient: PrMonitorGhClient;

  // Polling intervals in ms
  private readonly ACTIVE_INTERVAL = 30 * 1000; // 30 seconds
  private readonly IDLE_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MIN_INTERVAL = 30 * 1000;
  private readonly MAX_INTERVAL = 15 * 60 * 1000; // 15 minutes max backoff

  /**
   * Create a PR monitor.
   * @param options Deprecated getGitHubToken is retained for backwards compatibility.
   */
  constructor(options?: PrMonitorOptions) {
    // getGitHubToken option is no longer used - gh CLI auth is required
    this.ghClient = options?.ghClient ?? createDefaultPrMonitorGhClient();
  }

  /**
   * Register a callback to be called when new comments are found.
   */
  onNewComments(callback: OnNewCommentsCallback): void {
    this.newCommentsCallback = callback;
  }

  /**
   * Start monitoring a PR for comments.
   */
  startMonitoring(
    taskId: string,
    owner: string,
    repo: string,
    prInfo: PrInfo
  ): void {
    // Stop any existing monitoring for this task
    this.stopMonitoring(taskId);

    const tracked: TrackedPr = {
      owner,
      repo,
      prInfo,
      lastCheckedAt: new Date(),
      lastCommentId: undefined,
      consecutiveErrors: 0,
      isActive: true, // Start as active
      bufferedComments: [],
    };

    this.trackedPrs.set(taskId, tracked);

    // Do an initial check immediately
    this.checkForComments(taskId, tracked);

    // Set up polling interval
    this.scheduleNextCheck(taskId, tracked);

    prMonitorLog.log(`Started monitoring PR #${prInfo.number} for task ${taskId}`);
  }

  /**
   * Update the cached PR metadata for an already tracked task.
   * Keeps comment polling state intact while refreshing fields like PR status.
   */
  updatePrInfo(taskId: string, prInfo: PrInfo): void {
    const tracked = this.trackedPrs.get(taskId);
    if (!tracked) return;
    tracked.prInfo = prInfo;
  }

  /**
   * Drain (consume and return) buffered comments for a tracked PR.
   * Returns all comments collected since the last drain and clears the buffer.
   * This is used for creating follow-up tasks when a PR is closed/merged.
   * Returns an empty array if the task is not tracked or has no buffered comments.
   */
  drainComments(taskId: string): PrComment[] {
    const tracked = this.trackedPrs.get(taskId);
    if (!tracked) return [];
    const comments = tracked.bufferedComments;
    tracked.bufferedComments = [];
    return comments;
  }

  /**
   * Finish monitoring a PR whose task left review: stop future polls, wait for a poll that is
   * already waiting on gh, then drain everything it buffered and stop. Returns the drained comments.
   *
   * FNXC:GhAsyncChecks 2026-10-18-12:40: with async gh, a poll can still be in flight when the
   * task leaves review. Draining before it lands would drop its comments from the closed-PR
   * follow-up, so the final drain waits for it. Only the record that was finished is removed; a
   * task that re-entered review in the meantime keeps its new monitoring.
   */
  async finishMonitoring(taskId: string): Promise<PrComment[]> {
    const tracked = this.trackedPrs.get(taskId);
    if (!tracked) return [];
    tracked.finishing = true;
    const timer = this.intervals.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.intervals.delete(taskId);
    }
    await this.pendingChecks.get(taskId)?.catch(() => false);
    const comments = tracked.bufferedComments;
    tracked.bufferedComments = [];
    if (this.trackedPrs.get(taskId) === tracked) {
      this.trackedPrs.delete(taskId);
      this.pendingChecks.delete(taskId);
      prMonitorLog.log(`Stopped monitoring task ${taskId}`);
    }
    return comments;
  }

  /**
   * Stop monitoring a PR.
   */
  stopMonitoring(taskId: string): void {
    const interval = this.intervals.get(taskId);
    if (interval) {
      clearTimeout(interval);
      this.intervals.delete(taskId);
    }

    if (this.trackedPrs.has(taskId)) {
      this.trackedPrs.delete(taskId);
      prMonitorLog.log(`Stopped monitoring task ${taskId}`);
    }
  }

  /**
   * Stop monitoring all PRs. Called on scheduler shutdown.
   */
  stopAll(): void {
    for (const [taskId] of this.trackedPrs) {
      this.stopMonitoring(taskId);
    }
    prMonitorLog.log("Stopped all PR monitoring");
  }

  /**
   * Get currently tracked PRs (for testing/debugging).
   */
  getTrackedPrs(): Map<string, TrackedPr> {
    return new Map(this.trackedPrs);
  }

  private scheduleNextCheck(taskId: string, tracked: TrackedPr): void {
    // Calculate interval based on activity and error count
    let interval = tracked.isActive ? this.ACTIVE_INTERVAL : this.IDLE_INTERVAL;

    // Exponential backoff on errors: 30s * 2^errors, capped at 15min
    if (tracked.consecutiveErrors > 0) {
      const backoffMultiplier = Math.pow(2, Math.min(tracked.consecutiveErrors, 5));
      interval = Math.min(interval * backoffMultiplier, this.MAX_INTERVAL);
    }

    const timeoutId = setTimeout(() => {
      this.checkForComments(taskId, tracked).then(() => {
        // Reschedule only the record this poll belonged to, and never one being finished.
        if (this.trackedPrs.get(taskId) === tracked && !tracked.finishing) {
          this.scheduleNextCheck(taskId, tracked);
        }
      });
    }, interval);

    this.intervals.set(taskId, timeoutId);
  }

  private checkForComments(taskId: string, tracked: TrackedPr): Promise<boolean> {
    const check = this.runCheckForComments(taskId, tracked);
    this.pendingChecks.set(taskId, check);
    void check.finally(() => {
      if (this.pendingChecks.get(taskId) === check) this.pendingChecks.delete(taskId);
    });
    return check;
  }

  private async runCheckForComments(
    taskId: string,
    tracked: TrackedPr
  ): Promise<boolean> {
    // Check if gh CLI is available
    if (!(await this.ghClient.checkAuth())) {
      prMonitorLog.warn(`GitHub CLI (gh) not available or not authenticated for task ${taskId}. Run 'gh auth login' to enable PR monitoring.`);
      tracked.consecutiveErrors++;
      return false;
    }

    try {
      const since = tracked.lastCheckedAt.toISOString();
      const comments = await this.ghClient.fetchComments({
        owner: tracked.owner,
        repo: tracked.repo,
        prNumber: tracked.prInfo.number,
        since,
      });

      // A stopped or replaced record must not publish. A record being finished still buffers, so
      // finishMonitoring's drain includes comments that landed while this poll waited on gh.
      const current = this.trackedPrs.get(taskId) === tracked;
      if (!current && !tracked.finishing) return false;

      // Filter to only new comments (by ID)
      const newComments = tracked.lastCommentId
        ? comments.filter((c) => c.id > tracked.lastCommentId!)
        : comments;

      if (newComments.length > 0) {
        prMonitorLog.log(
          `Found ${newComments.length} new comment(s) on PR #${tracked.prInfo.number}`
        );

        // Update lastCommentId
        const maxId = Math.max(...newComments.map((c) => c.id));
        tracked.lastCommentId = maxId;

        // Buffer comments for potential follow-up task creation on PR close/merge
        tracked.bufferedComments.push(...newComments);

        // Mark as active since we found new comments
        tracked.isActive = true;

        // Notify handler (not for a record being finished: its comments go to the closed-PR follow-up)
        if (this.newCommentsCallback && !tracked.finishing && this.trackedPrs.get(taskId) === tracked) {
          try {
            await this.newCommentsCallback(taskId, tracked.prInfo, newComments);
          } catch (err) {
            prMonitorLog.error(`Error handling new comments for ${taskId}:`, err);
          }
        }
      } else {
        // No new comments - mark as idle after 5 minutes of no activity
        const timeSinceLastComment = Date.now() - tracked.lastCheckedAt.getTime();
        if (timeSinceLastComment > 5 * 60 * 1000) {
          tracked.isActive = false;
        }
      }

      // Reset error count on success
      tracked.consecutiveErrors = 0;
      tracked.lastCheckedAt = new Date();
      return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      tracked.consecutiveErrors++;
      prMonitorLog.error(
        `Error checking PR #${tracked.prInfo.number} for task ${taskId} ` +
          `(attempt ${tracked.consecutiveErrors}):`,
        err.message
      );

      // Disable monitoring after 5 consecutive failures
      if (tracked.consecutiveErrors >= 5) {
        prMonitorLog.warn(
          `Disabling PR monitoring for task ${taskId} after 5 consecutive failures`
        );
        this.stopMonitoring(taskId);
        return false;
      }
      return false;
    }
  }
}
