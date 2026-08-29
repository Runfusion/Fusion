/**
 * FNXC:CodeOrganization 2026-07-20-14:00:
 * AI title summarization client API peeled from legacy.ts.
 */

import { withTokenHeader } from "../../auth";
import {
  ApiRequestError,
  SERVER_UNAVAILABLE_MESSAGE,
  isGatewayUnavailableStatus,
} from "../client/client.js";

// --- AI Summarization API ---

/** Response from title summarization endpoint */
export interface SummarizeTitleResponse {
  title: string;
}

/** Summarize a task description into a concise title using AI.
 * @param description - The non-empty task description to summarize; model input is truncated
 * @param provider - Optional AI model provider (e.g., "anthropic")
 * @param modelId - Optional AI model ID (e.g., "claude-sonnet-4-5")
 * @param projectId - Optional project ID for scoped settings resolution
 * @returns The generated title (guaranteed ≤60 characters)
 * @throws Error with descriptive message for 400/429/503 errors
 */
export async function summarizeTitle(
  description: string,
  provider?: string,
  modelId?: string,
  projectId?: string
): Promise<string> {
  const url = projectId
    ? `/api/ai/summarize-title?projectId=${encodeURIComponent(projectId)}`
    : "/api/ai/summarize-title";
  const res = await fetch(url, {
    method: "POST",
    headers: withTokenHeader({ "Content-Type": "application/json" }),
    body: JSON.stringify({ description, provider, modelId }),
  });

  const contentType = res.headers.get("content-type") ?? "";
  const bodyText = await res.text();
  const isJson = contentType.includes("application/json");

  if (!isJson) {
    // FNXC:DashboardApi 2026-08-16-03:09: title summarize has its own fetch parser; gateway 5xx must match `api()`.
    if (isGatewayUnavailableStatus(res.status)) {
      throw new ApiRequestError(SERVER_UNAVAILABLE_MESSAGE, res.status);
    }
    throw new Error(`API returned non-JSON response: ${bodyText.slice(0, 100)}`);
  }

  const data = JSON.parse(bodyText) as { title?: string; error?: string };

  if (!res.ok) {
    const errorMessage = data.error || "Request failed";
    if (res.status === 400) {
      throw new Error(`Invalid request: ${errorMessage}`);
    } else if (res.status === 429) {
      throw new Error(`Rate limit exceeded: ${errorMessage}`);
    } else if (res.status === 503) {
      throw new Error(`AI service temporarily unavailable: ${errorMessage}`);
    } else {
      throw new Error(errorMessage);
    }
  }

  if (!data.title) {
    throw new Error("API returned empty title");
  }

  return data.title;
}

