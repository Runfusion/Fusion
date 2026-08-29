import { useEffect, useState } from "react";
import { getReportPreviewHtml } from "./api.js";

const cache = new Map<string, string>();

export function useReportPreview(id?: string, projectId?: string) {
  const [html, setHtml] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setHtml("");
      setError(null);
      return;
    }
    const key = `${projectId ?? ""}:${id}`;
    const cached = cache.get(key);
    if (cached) {
      setHtml(cached);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    getReportPreviewHtml(id, projectId)
      .then((nextHtml) => {
        if (controller.signal.aborted) return;
        cache.set(key, nextHtml);
        setHtml(nextHtml);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load preview");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, projectId]);

  return { html, loading, error };
}
