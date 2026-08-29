import type { PrComment } from "./pr-monitor.js";

interface GhPrViewJson {
  comments: Array<{
    id: string;
    body: string;
    author: { login: string };
    createdAt: string;
    updatedAt: string;
    url: string;
  }>;
}

export interface FetchPrCommentsInput {
  owner: string;
  repo: string;
  prNumber: number;
  since?: string;
}

export interface PrMonitorGhClient {
  checkAuth(): Promise<boolean>;
  fetchComments(input: FetchPrCommentsInput): Promise<PrComment[]>;
}

/**
 * Default gh-backed implementation used in production runtime.
 */
export function createDefaultPrMonitorGhClient(): PrMonitorGhClient {
  return {
    async checkAuth(): Promise<boolean> {
      try {
        const { isGhAvailable, isGhAuthenticated } = await import("@fusion/core");
        return isGhAvailable() && isGhAuthenticated();
      } catch {
        return false;
      }
    },

    async fetchComments({ owner, repo, prNumber, since }: FetchPrCommentsInput): Promise<PrComment[]> {
      const { runGhJson } = await import("@fusion/core");
      const pr = runGhJson<GhPrViewJson>([
        "pr",
        "view",
        String(prNumber),
        "--repo",
        `${owner}/${repo}`,
        "--json",
        "comments",
      ]);

      let comments = pr.comments.map((c) => ({
        id: parseInt(c.id, 10),
        body: c.body,
        user: { login: c.author.login },
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        html_url: c.url,
      }));

      if (since) {
        const sinceDate = new Date(since);
        comments = comments.filter((c) => new Date(c.created_at) > sinceDate);
      }

      return comments;
    },
  };
}
