import type { ResolvedJiraAuth } from "./jira-auth.js";

const MAX_JIRA_RESPONSE_BYTES = 64 * 1024;

export class JiraApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "JiraApiError";
  }
}

/**
 * FNXC:JiraBranchNaming 2026-08-20-05:18:
 * Reads only the bounded JSON payload required for branch naming. The reader is cancelled before
 * decoding when a JIRA server exceeds the response budget, so an endpoint cannot force an
 * unbounded dashboard allocation through this read-only integration.
 */
async function readJiraResponseBody(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_JIRA_RESPONSE_BYTES) {
        await reader.cancel();
        throw new JiraApiError(0, "network_error");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export class JiraClient {
  constructor(public readonly auth: ResolvedJiraAuth, private readonly fetchImpl: typeof fetch = fetch) {}

  async getIssueSummary(issueKey: string): Promise<{ key: string; summary: string | null }> {
    try {
      const response = await this.fetchImpl(
        `${this.auth.apiBaseUrl.replace(/\/+$/u, "")}/issue/${encodeURIComponent(issueKey)}?fields=summary`,
        {
          headers: { Accept: "application/json", Authorization: this.auth.headerValue },
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      );
      if (!response.ok) {
        throw new JiraApiError(
          response.status,
          response.status === 404 ? "not_found" : response.status === 401 || response.status === 403 ? "unauthorized" : "upstream_error",
        );
      }

      const raw = JSON.parse(await readJiraResponseBody(response)) as { fields?: { summary?: unknown } };
      return { key: issueKey, summary: typeof raw.fields?.summary === "string" ? raw.fields.summary : null };
    } catch (error) {
      if (error instanceof JiraApiError) throw error;
      throw new JiraApiError(0, "network_error");
    }
  }
}
