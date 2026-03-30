import { EventEmitter } from "node:events";
import {
  type IssueInfo,
  type PrInfo,
  type TaskStore,
} from "@kb/core";
import { GitHubClient, type BadgeBatchRequest, type BadgeBatchResponse } from "./github.js";

export type WatchedBadgeType = "pr" | "issue";

export interface TaskWatchInput {
  taskId: string;
  type: WatchedBadgeType;
  owner: string;
  repo: string;
  number: number;
}

interface TaskWatchSet {
  pr?: TaskWatchInput;
  issue?: TaskWatchInput;
  lastCheckedAt: Partial<Record<WatchedBadgeType, string>>;
}

export interface GitHubPollingServiceOptions {
  store?: TaskStore;
  token?: string;
  pollingIntervalMs?: number;
  rateLimiter?: GitHubRateLimiter;
}

export interface GitHubPollingServiceEvents {}

interface RepoBatchConsumer {
  taskId: string;
  type: WatchedBadgeType;
  alias: string;
}

const DEFAULT_GITHUB_RATE_LIMIT_MAX_REQUESTS = 90;
const DEFAULT_GITHUB_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export class GitHubRateLimiter {
  private readonly requests = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(options: { maxRequests?: number; windowMs?: number } = {}) {
    this.maxRequests = options.maxRequests ?? DEFAULT_GITHUB_RATE_LIMIT_MAX_REQUESTS;
    this.windowMs = options.windowMs ?? DEFAULT_GITHUB_RATE_LIMIT_WINDOW_MS;
  }

  canMakeRequest(repoKey: string): boolean {
    const now = Date.now();
    const timestamps = (this.requests.get(repoKey) ?? []).filter((ts) => now - ts < this.windowMs);

    if (timestamps.length >= this.maxRequests) {
      this.requests.set(repoKey, timestamps);
      return false;
    }

    timestamps.push(now);
    this.requests.set(repoKey, timestamps);
    return true;
  }

  getResetTime(repoKey: string): Date | null {
    const timestamps = this.requests.get(repoKey);
    if (!timestamps || timestamps.length === 0) return null;

    const oldest = Math.min(...timestamps);
    return new Date(oldest + this.windowMs);
  }
}

export const githubRateLimiter = new GitHubRateLimiter();

export class GitHubPollingService extends EventEmitter<GitHubPollingServiceEvents> {
  private readonly watches = new Map<string, TaskWatchSet>();
  private readonly rateLimiter: GitHubRateLimiter;
  private pollingIntervalMs: number;
  private store?: TaskStore;
  private token?: string;
  private timer: NodeJS.Timeout | null = null;
  private isPolling = false;
  private enabled = false;

  constructor(options: GitHubPollingServiceOptions = {}) {
    super();
    this.store = options.store;
    this.token = options.token;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 60_000;
    this.rateLimiter = options.rateLimiter ?? githubRateLimiter;
  }

  configure(options: GitHubPollingServiceOptions): void {
    if (options.store) {
      this.store = options.store;
    }

    if (options.token !== undefined) {
      this.token = options.token;
    }

    if (options.pollingIntervalMs !== undefined) {
      this.pollingIntervalMs = options.pollingIntervalMs;
      if (this.timer) {
        this.stop();
        this.start();
      }
    }
  }

  start(): void {
    this.enabled = true;
    if (this.timer || this.watches.size === 0) return;

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollingIntervalMs);

    void this.pollOnce();
  }

  stop(): void {
    this.enabled = false;
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  watchTask(taskId: string, type: WatchedBadgeType, owner: string, repo: string, number: number): void {
    const existing = this.watches.get(taskId);
    const otherWatch = existing?.[type === "pr" ? "issue" : "pr"];
    this.replaceTaskWatches(taskId, [
      ...(otherWatch ? [otherWatch] : []),
      { taskId, type, owner, repo, number },
    ]);
  }

  replaceTaskWatches(taskId: string, watches: TaskWatchInput[]): void {
    if (watches.length === 0) {
      this.unwatchTask(taskId);
      return;
    }

    const next: TaskWatchSet = {
      lastCheckedAt: { ...(this.watches.get(taskId)?.lastCheckedAt ?? {}) },
    };

    for (const watch of watches) {
      if (!watch.taskId || !watch.owner || !watch.repo || !Number.isInteger(watch.number) || watch.number < 1) {
        continue;
      }

      next[watch.type] = watch;
    }

    if (!next.pr) {
      delete next.lastCheckedAt.pr;
    }
    if (!next.issue) {
      delete next.lastCheckedAt.issue;
    }

    if (!next.pr && !next.issue) {
      this.unwatchTask(taskId);
      return;
    }

    this.watches.set(taskId, next);

    if (this.enabled && !this.timer) {
      this.start();
    }
  }

  unwatchTask(taskId: string): void {
    this.watches.delete(taskId);

    if (this.watches.size === 0) {
      this.stop();
    }
  }

  unwatchTaskType(taskId: string, type: WatchedBadgeType): void {
    const watchSet = this.watches.get(taskId);
    if (!watchSet) return;

    delete watchSet[type];
    delete watchSet.lastCheckedAt[type];

    if (!watchSet.pr && !watchSet.issue) {
      this.unwatchTask(taskId);
      return;
    }

    this.watches.set(taskId, watchSet);
  }

  reset(): void {
    this.watches.clear();
    this.stop();
  }

  getWatchedTaskIds(): string[] {
    return [...this.watches.keys()];
  }

  getWatch(taskId: string): TaskWatchSet | undefined {
    return this.watches.get(taskId);
  }

  getLastCheckedAt(taskId: string, type: WatchedBadgeType): string | undefined {
    return this.watches.get(taskId)?.lastCheckedAt[type];
  }

  async pollOnce(): Promise<void> {
    if (!this.store || this.isPolling || this.watches.size === 0) {
      return;
    }

    this.isPolling = true;

    try {
      const batches = new Map<string, RepoBatchConsumer[]>();

      for (const watchSet of this.watches.values()) {
        for (const watch of [watchSet.pr, watchSet.issue]) {
          if (!watch) continue;

          const repoKey = `${watch.owner}/${watch.repo}`;
          const alias = toAlias(watch.type, watch.number);
          const consumers = batches.get(repoKey) ?? [];
          consumers.push({ taskId: watch.taskId, type: watch.type, alias });
          batches.set(repoKey, consumers);
        }
      }

      await Promise.allSettled(
        [...batches.entries()].map(async ([repoKey, consumers]) => {
          const [owner, repo] = repoKey.split("/");
          await this.pollRepo(owner, repo, consumers);
        }),
      );
    } finally {
      this.isPolling = false;
    }
  }

  private async pollRepo(owner: string, repo: string, consumers: RepoBatchConsumer[]): Promise<void> {
    const repoKey = `${owner}/${repo}`;
    if (!this.rateLimiter.canMakeRequest(repoKey)) {
      return;
    }

    const resources = new Map<string, { request: BadgeBatchRequest; consumers: RepoBatchConsumer[] }>();

    for (const consumer of consumers) {
      const watch = this.watches.get(consumer.taskId)?.[consumer.type];
      if (!watch) continue;

      const key = `${watch.type}:${watch.number}`;
      const existing = resources.get(key);
      if (existing) {
        existing.consumers.push(consumer);
        continue;
      }

      resources.set(key, {
        request: {
          alias: consumer.alias,
          type: watch.type,
          number: watch.number,
        },
        consumers: [consumer],
      });
    }

    if (resources.size === 0) {
      return;
    }

    const response = await this.fetchRepoBatch(
      owner,
      repo,
      [...resources.values()].map(({ request }) => request),
    );

    await Promise.allSettled(
      [...resources.values()].flatMap(({ request, consumers: requestConsumers }) =>
        requestConsumers.map((consumer) =>
          this.applyFetchedResource(
            consumer.taskId,
            consumer.type,
            response[request.alias] ?? null,
          ),
        ),
      ),
    );
  }

  private async applyFetchedResource(
    taskId: string,
    type: WatchedBadgeType,
    resource: BadgeBatchResponse[string] | null,
  ): Promise<void> {
    if (!this.store) return;

    const watchSet = this.watches.get(taskId);
    if (!watchSet) return;

    const checkedAt = new Date().toISOString();

    let task;
    try {
      task = await this.store.getTask(taskId);
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        this.unwatchTask(taskId);
      }
      return;
    }

    if (type === "pr") {
      if (!task.prInfo) {
        this.unwatchTaskType(taskId, "pr");
        return;
      }

      if (!resource || resource.type !== "pr") {
        return;
      }

      watchSet.lastCheckedAt.pr = checkedAt;

      const nextPrInfo: PrInfo = {
        ...resource.prInfo,
        lastCheckedAt: checkedAt,
      };

      if (!hasPrBadgeChanged(task.prInfo, nextPrInfo)) {
        return;
      }

      await this.store.updatePrInfo(taskId, nextPrInfo);
      return;
    }

    if (!task.issueInfo) {
      this.unwatchTaskType(taskId, "issue");
      return;
    }

    if (!resource || resource.type !== "issue") {
      return;
    }

    watchSet.lastCheckedAt.issue = checkedAt;

    const nextIssueInfo: IssueInfo = {
      ...resource.issueInfo,
      lastCheckedAt: checkedAt,
    };

    if (!hasIssueBadgeChanged(task.issueInfo, nextIssueInfo)) {
      return;
    }

    await this.store.updateIssueInfo(taskId, nextIssueInfo);
  }

  private async fetchRepoBatch(
    owner: string,
    repo: string,
    requests: BadgeBatchRequest[],
  ): Promise<BadgeBatchResponse> {
    const client = new GitHubClient(this.token);
    return client.getBadgeStatusesBatch(owner, repo, requests);
  }
}

export const githubPoller = new GitHubPollingService();

function toAlias(type: WatchedBadgeType, number: number): string {
  return `${type}_${number}`;
}

function hasPrBadgeChanged(current: PrInfo | undefined, next: PrInfo): boolean {
  if (!current) return true;

  return current.url !== next.url ||
    current.number !== next.number ||
    current.status !== next.status ||
    current.title !== next.title ||
    current.headBranch !== next.headBranch ||
    current.baseBranch !== next.baseBranch ||
    current.commentCount !== next.commentCount ||
    current.lastCommentAt !== next.lastCommentAt;
}

function hasIssueBadgeChanged(current: IssueInfo | undefined, next: IssueInfo): boolean {
  if (!current) return true;

  return current.url !== next.url ||
    current.number !== next.number ||
    current.state !== next.state ||
    current.title !== next.title ||
    current.stateReason !== next.stateReason;
}

