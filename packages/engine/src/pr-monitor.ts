import { prMonitorLog } from "./logger.js";
import type { PrInfo } from "@kb/core";

export interface TrackedPr {
  owner: string;
  repo: string;
  prInfo: PrInfo;
  lastCheckedAt: Date;
  lastCommentId?: number;
  consecutiveErrors: number;
  isActive: boolean; // true if we've seen recent activity
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

/**
 * Monitors GitHub PRs for new comments.
 * Uses adaptive polling: 30s when active, 5min when idle.
 * Implements exponential backoff on errors.
 */
export class PrMonitor {
  private trackedPrs = new Map<string, TrackedPr>();
  private intervals = new Map<string, ReturnType<typeof setInterval>>();
  private newCommentsCallback?: OnNewCommentsCallback;
  private getGitHubToken: () => string | undefined;

  // Polling intervals in ms
  private readonly ACTIVE_INTERVAL = 30 * 1000; // 30 seconds
  private readonly IDLE_INTERVAL = 5 * 60 * 1000; // 5 minutes
  private readonly MIN_INTERVAL = 30 * 1000;
  private readonly MAX_INTERVAL = 15 * 60 * 1000; // 15 minutes max backoff

  constructor(options: { getGitHubToken?: () => string | undefined } = {}) {
    this.getGitHubToken = options.getGitHubToken ?? (() => process.env.GITHUB_TOKEN);
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
    };

    this.trackedPrs.set(taskId, tracked);

    // Do an initial check immediately
    this.checkForComments(taskId, tracked);

    // Set up polling interval
    this.scheduleNextCheck(taskId, tracked);

    prMonitorLog.log(`Started monitoring PR #${prInfo.number} for task ${taskId}`);
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
        // Reschedule if still tracked
        if (this.trackedPrs.has(taskId)) {
          this.scheduleNextCheck(taskId, tracked);
        }
      });
    }, interval);

    this.intervals.set(taskId, timeoutId);
  }

  private async checkForComments(
    taskId: string,
    tracked: TrackedPr
  ): Promise<boolean> {
    const token = this.getGitHubToken();
    if (!token) {
      prMonitorLog.warn(`No GitHub token available for task ${taskId}`);
      tracked.consecutiveErrors++;
      return false; // Don't reschedule - wait for next scheduled check
    }

    try {
      const since = tracked.lastCheckedAt.toISOString();
      const comments = await this.fetchComments(
        tracked.owner,
        tracked.repo,
        tracked.prInfo.number,
        since,
        token
      );

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

        // Mark as active since we found new comments
        tracked.isActive = true;

        // Notify handler
        if (this.newCommentsCallback) {
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

  private async fetchComments(
    owner: string,
    repo: string,
    prNumber: number,
    since: string,
    token: string
  ): Promise<PrComment[]> {
    const params = new URLSearchParams();
    params.append("per_page", "100");
    if (since) {
      params.append("since", since);
    }

    const url = `https://api.github.com/repos/${encodeURIComponent(
      owner
    )}/${encodeURIComponent(repo)}/issues/${prNumber}/comments?${params}`;

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "kb-engine/1.0",
      Authorization: `Bearer ${token}`,
    };

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`PR #${prNumber} not found in ${owner}/${repo}`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error("Authentication failed or rate limited");
      }
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<PrComment[]>;
  }
}
