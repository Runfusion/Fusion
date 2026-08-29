import type { GeneratedCliArtifact, RunRequest, RunResult } from "../generation/types.js";
import type { ServiceDraft } from "../wizard/types.js";

const BASE_PATH = "/api/plugins/cli-printing-press/drafts";

async function parseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = (body as { error?: string }).error ?? "Request failed";
    throw new Error(error);
  }
  return body as T;
}

export function useRunGeneratedCli() {
  async function regenerate(id: string, signal?: AbortSignal): Promise<{ draft: ServiceDraft; artifact: GeneratedCliArtifact }> {
    const response = await fetch(`${BASE_PATH}/${id}/regenerate`, { method: "POST", signal });
    return parseJson<{ draft: ServiceDraft; artifact: GeneratedCliArtifact }>(response);
  }

  async function run(id: string, payload: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const response = await fetch(`${BASE_PATH}/${id}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    return parseJson<RunResult>(response);
  }

  async function getArtifact(id: string, signal?: AbortSignal): Promise<{ artifact: GeneratedCliArtifact }> {
    const response = await fetch(`${BASE_PATH}/${id}/artifact`, { signal });
    return parseJson<{ artifact: GeneratedCliArtifact }>(response);
  }

  return { regenerate, run, getArtifact };
}
