import { useCallback, useEffect, useState } from "react";
import type { GeneratedCliArtifact } from "../generation/types.js";
import type { ServiceDraft } from "../wizard/types.js";

export interface DraftListItem {
  id: string;
  name: string;
  slug: string;
  updatedAt: string;
}

const BASE_PATH = "/api/plugins/fusion-plugin-cli-printing-press/drafts";

async function parseError(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => ({} as { error?: string }));
  return body.error ?? fallback;
}

export function useDrafts() {
  const [drafts, setDrafts] = useState<DraftListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(BASE_PATH, { signal });
      if (!response.ok) throw new Error(await parseError(response, "Failed to load drafts"));
      setDrafts(await response.json() as DraftListItem[]);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to load drafts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const getDraft = useCallback(async (id: string): Promise<ServiceDraft> => {
    const response = await fetch(`${BASE_PATH}/${id}`);
    if (!response.ok) throw new Error(await parseError(response, "Failed to load draft"));
    return await response.json() as ServiceDraft;
  }, []);

  const updateDraft = useCallback(async (id: string, draft: ServiceDraft): Promise<ServiceDraft> => {
    const response = await fetch(`${BASE_PATH}/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(draft),
    });
    if (!response.ok) throw new Error(await parseError(response, "Failed to update draft"));
    return await response.json() as ServiceDraft;
  }, []);

  const regenerateDraft = useCallback(async (id: string): Promise<{ draft: ServiceDraft; artifact: GeneratedCliArtifact }> => {
    const response = await fetch(`${BASE_PATH}/${id}/regenerate`, { method: "POST" });
    if (!response.ok) throw new Error(await parseError(response, "Failed to regenerate draft"));
    return await response.json() as { draft: ServiceDraft; artifact: GeneratedCliArtifact };
  }, []);

  const deleteDraft = useCallback(async (id: string): Promise<void> => {
    const response = await fetch(`${BASE_PATH}/${id}`, { method: "DELETE" });
    if (!response.ok && response.status !== 204) throw new Error(await parseError(response, "Failed to delete draft"));
  }, []);

  return { drafts, loading, error, refresh, getDraft, updateDraft, regenerateDraft, deleteDraft };
}
