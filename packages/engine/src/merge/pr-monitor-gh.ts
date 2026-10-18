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
 *
 * FNXC:GhAsyncChecks 2026-10-18-01:20: every call is async. The monitor polls each tracked PR every
 * 30 s, and the previous execFileSync calls blocked the daemon's event loop for the whole `gh`
 * round trip (about a fifth of the daemon's busy time in a profile on 2026-10-18).
 */
export function createDefaultPrMonitorGhClient(): PrMonitorGhClient {
  return {
    async checkAuth(): Promise<boolean> {
      try {
        const { isGhAvailableAsync, isGhAuthenticatedAsync } = await import("@fusion/core");
        return (await isGhAvailableAsync()) && (await isGhAuthenticatedAsync());
      } catch {
        return false;
      }
    },

    async fetchComments({ owner, repo, prNumber, since }: FetchPrCommentsInput): Promise<PrComment[]> {
      const { runGhJsonAsync } = await import("@fusion/core");
      const pr = await runGhJsonAsync<GhPrViewJson>([
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
