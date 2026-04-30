import {
  isGhAuthenticated,
  isGhAvailable,
  runGhAsync,
  runGhJsonAsync,
  type GhError,
  type ResearchProviderConfig,
  type ResearchSource,
} from "@fusion/core";
import type { ResearchProvider } from "../../research-step-runner.js";
import { createLogger } from "../../logger.js";
import { ResearchProviderError, type ResearchFetchResult } from "../types.js";

const log = createLogger("research:github");
const DEFAULT_TIMEOUT_MS = 30_000;

type SearchType = "repos" | "issues" | "both";

interface GitHubRepoResult {
  fullName: string;
  description?: string;
  htmlUrl: string;
  stargazersCount?: number;
  language?: string;
  updatedAt?: string;
}

interface GitHubIssueResult {
  title: string;
  body?: string;
  htmlUrl: string;
  state?: string;
  labels?: Array<{ name?: string }>;
}

interface ParsedGitHubUrl {
  owner: string;
  repo: string;
  kind: "repo" | "issue" | "pr" | "file";
  number?: string;
  filePath?: string;
  ref?: string;
}

export class GitHubProvider implements ResearchProvider {
  readonly type = "github";

  async search(query: string, config: ResearchProviderConfig = {}, signal?: AbortSignal): Promise<ResearchSource[]> {
    const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxResults = Number(config.maxResults ?? 10);
    const searchType = ((config.metadata?.searchType as SearchType | undefined) ?? "both");

    const sources: ResearchSource[] = [];

    try {
      if (searchType === "repos" || searchType === "both") {
        const repos = await runGhJsonAsync<GitHubRepoResult[]>(
          [
            "search",
            "repos",
            query,
            "--json",
            "fullName,description,htmlUrl,stargazersCount,language,updatedAt",
            "--limit",
            String(maxResults),
          ],
          { signal, timeoutMs },
        );

        sources.push(
          ...repos.slice(0, maxResults).map((repo, idx) => ({
            id: `github-repo-${idx}-${repo.htmlUrl}`,
            type: "github" as const,
            reference: repo.htmlUrl,
            title: repo.fullName,
            excerpt: repo.description ?? "",
            status: "completed" as const,
            metadata: {
              resultType: "repo",
              stars: repo.stargazersCount ?? 0,
              language: repo.language,
              updatedAt: repo.updatedAt,
              rank: idx + 1,
            },
          })),
        );
      }

      if (searchType === "issues" || searchType === "both") {
        const issues = await runGhJsonAsync<GitHubIssueResult[]>(
          [
            "search",
            "issues",
            query,
            "--json",
            "title,body,htmlUrl,state,labels",
            "--limit",
            String(maxResults),
          ],
          { signal, timeoutMs },
        );

        sources.push(
          ...issues.slice(0, maxResults).map((issue, idx) => ({
            id: `github-issue-${idx}-${issue.htmlUrl}`,
            type: "github" as const,
            reference: issue.htmlUrl,
            title: issue.title,
            excerpt: issue.body?.slice(0, 280) ?? "",
            status: "completed" as const,
            metadata: {
              resultType: "issue",
              state: issue.state,
              labels: (issue.labels ?? []).map((label) => label.name).filter(Boolean),
              rank: idx + 1,
            },
          })),
        );
      }

      return sources;
    } catch (error) {
      throw this.mapGhError(error);
    }
  }

  async fetchContent(url: string, config: ResearchProviderConfig = {}, signal?: AbortSignal): Promise<ResearchFetchResult> {
    const parsed = parseGitHubUrl(url);
    if (!parsed) {
      throw new ResearchProviderError({
        providerType: "github",
        code: "provider-unavailable",
        message: "Unsupported GitHub URL",
      });
    }

    const timeoutMs = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    try {
      if (parsed.kind === "repo") {
        const readme = await runGhJsonAsync<{ content?: string; encoding?: string; name?: string }>(
          ["api", `repos/${parsed.owner}/${parsed.repo}/readme`],
          { signal, timeoutMs },
        );

        if (readme.encoding !== "base64" || !readme.content) {
          throw new ResearchProviderError({
            providerType: "github",
            code: "provider-unavailable",
            message: "Unsupported README encoding",
          });
        }

        const content = Buffer.from(readme.content.replace(/\n/g, ""), "base64").toString("utf-8");
        return {
          content,
          metadata: {
            url,
            owner: parsed.owner,
            repo: parsed.repo,
            kind: "repo-readme",
            name: readme.name,
          },
          mimeType: "text/markdown",
        };
      }

      if (parsed.kind === "issue") {
        const issue = await runGhAsync(["issue", "view", parsed.number ?? "", "--repo", `${parsed.owner}/${parsed.repo}`, "--comments"], {
          signal,
          timeoutMs,
        });
        return {
          content: issue,
          metadata: { url, owner: parsed.owner, repo: parsed.repo, kind: "issue", number: parsed.number },
          mimeType: "text/plain",
        };
      }

      if (parsed.kind === "pr") {
        const pr = await runGhAsync(["pr", "view", parsed.number ?? "", "--repo", `${parsed.owner}/${parsed.repo}`, "--comments"], {
          signal,
          timeoutMs,
        });
        return {
          content: pr,
          metadata: { url, owner: parsed.owner, repo: parsed.repo, kind: "pr", number: parsed.number },
          mimeType: "text/plain",
        };
      }

      const apiPath = `repos/${parsed.owner}/${parsed.repo}/contents/${parsed.filePath ?? ""}${parsed.ref ? `?ref=${encodeURIComponent(parsed.ref)}` : ""}`;
      const file = await runGhJsonAsync<{ content?: string; encoding?: string; name?: string }>(["api", apiPath], {
        signal,
        timeoutMs,
      });
      const content = file.encoding === "base64" && file.content
        ? Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf-8")
        : (file.content ?? "");

      return {
        content,
        metadata: {
          url,
          owner: parsed.owner,
          repo: parsed.repo,
          kind: "file",
          path: parsed.filePath,
          ref: parsed.ref,
          name: file.name,
        },
        mimeType: "text/plain",
      };
    } catch (error) {
      throw this.mapGhError(error);
    }
  }

  isConfigured(): boolean {
    return isGhAvailable() && isGhAuthenticated();
  }

  private mapGhError(error: unknown): ResearchProviderError {
    if (error instanceof ResearchProviderError) return error;

    if (isGhError(error)) {
      const message = `${error.message}${error.stderr ? `: ${error.stderr}` : ""}`;
      const lowered = message.toLowerCase();

      if (error.code === "ABORT_ERR" || lowered.includes("aborted")) {
        return new ResearchProviderError({ providerType: "github", code: "abort", message, cause: error });
      }
      if (lowered.includes("timed out")) {
        return new ResearchProviderError({
          providerType: "github",
          code: "timeout",
          message,
          retryable: true,
          cause: error,
        });
      }
      if (error.code === 403 || lowered.includes("rate limit")) {
        return new ResearchProviderError({
          providerType: "github",
          code: "rate-limited",
          message,
          retryable: true,
          cause: error,
        });
      }
      if (error.code === 401 || lowered.includes("not logged") || lowered.includes("authentication")) {
        return new ResearchProviderError({
          providerType: "github",
          code: "auth-failed",
          message,
          cause: error,
        });
      }
      if (error.code === 404 || lowered.includes("not found")) {
        return new ResearchProviderError({
          providerType: "github",
          code: "provider-unavailable",
          message,
          cause: error,
        });
      }

      return new ResearchProviderError({
        providerType: "github",
        code: "network-error",
        message,
        retryable: true,
        cause: error,
      });
    }

    log.warn("github provider error", { error });
    return new ResearchProviderError({
      providerType: "github",
      code: "network-error",
      message: error instanceof Error ? error.message : "GitHub provider failed",
      retryable: true,
      cause: error,
    });
  }
}

function isGhError(value: unknown): value is GhError {
  return value instanceof Error && "stderr" in value && "stdout" in value && "code" in value;
}

function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return null;
  }

  if (!/(^|\.)github\.com$/i.test(parsedUrl.hostname)) {
    return null;
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const [owner, repo, section, ...rest] = segments;
  if (!section) {
    return { owner, repo, kind: "repo" };
  }

  if (section === "issues" && rest[0]) {
    return { owner, repo, kind: "issue", number: rest[0] };
  }

  if (section === "pull" && rest[0]) {
    return { owner, repo, kind: "pr", number: rest[0] };
  }

  if (section === "blob" && rest.length >= 2) {
    return { owner, repo, kind: "file", ref: rest[0], filePath: rest.slice(1).join("/") };
  }

  return null;
}

export { parseGitHubUrl };
