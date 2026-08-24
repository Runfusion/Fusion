import { useCallback, useEffect, useState } from "react";
import { artifactMediaUrl } from "../api";
import { withTokenHeader } from "../auth";

export interface ArtifactImageBlobState {
  url: string | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * FNXC:ArtifactImageSecurity 2026-08-19-18:08:
 * Registered images must never hand browser elements a tokenized media URL. Fetch through the
 * existing header-authenticated endpoint and expose only a short-lived object URL, revoking it
 * whenever its artifact view is replaced or closed so credentials cannot enter DOM URLs.
 */
export function useArtifactImageBlob(artifactId?: string, projectId?: string): ArtifactImageBlobState {
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((current) => current + 1), []);
  const [state, setState] = useState<Omit<ArtifactImageBlobState, "reload">>({ url: null, loading: Boolean(artifactId), error: null });

  useEffect(() => {
    if (!artifactId) {
      setState({ url: null, loading: false, error: null });
      return;
    }

    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ url: null, loading: true, error: null });

    void fetch(artifactMediaUrl(artifactId, projectId), {
      headers: withTokenHeader(),
      signal: controller.signal,
    }).then(async (response) => {
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.toLowerCase().startsWith("image/")) {
        throw new Error("Artifact media is unavailable or is not an image.");
      }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      if (!blob.type.toLowerCase().startsWith("image/")) {
        throw new Error("Artifact media is not an image.");
      }
      objectUrl = URL.createObjectURL(blob);
      if (!controller.signal.aborted) setState({ url: objectUrl, loading: false, error: null });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ url: null, loading: false, error: "Failed to load image artifact." });
    });

    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, projectId, reloadKey]);

  return { ...state, reload };
}
