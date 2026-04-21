import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

export type EmbedStatus = "unknown" | "loading" | "embedded" | "blocked" | "error";

interface UsePreviewEmbedResult {
  embedStatus: EmbedStatus;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  handleIframeLoad: () => void;
  handleIframeError: () => void;
  resetEmbed: () => void;
  isEmbedded: boolean;
  isBlocked: boolean;
}

export function usePreviewEmbed(url: string | null): UsePreviewEmbedResult {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [embedStatus, setEmbedStatus] = useState<EmbedStatus>("unknown");

  useEffect(() => {
    if (!url) {
      setEmbedStatus("unknown");
      return;
    }

    queueMicrotask(() => {
      setEmbedStatus("loading");
    });
  }, [url]);

  const handleIframeLoad = useCallback(() => {
    const iframeEl = iframeRef.current;
    if (!iframeEl) {
      setEmbedStatus("embedded");
      return;
    }

    try {
      const frameHref = iframeEl.contentWindow?.location?.href;
      if (frameHref === "about:blank" && iframeEl.src !== "about:blank") {
        setEmbedStatus("blocked");
        return;
      }
    } catch {
      // Cross-origin access can throw; do not treat it as blocked.
    }

    setEmbedStatus("embedded");
  }, []);

  const handleIframeError = useCallback(() => {
    setEmbedStatus("error");
  }, []);

  const resetEmbed = useCallback(() => {
    setEmbedStatus("unknown");
  }, []);

  const isEmbedded = useMemo(() => embedStatus === "embedded", [embedStatus]);
  const isBlocked = useMemo(
    () => embedStatus === "blocked" || embedStatus === "error",
    [embedStatus],
  );

  return {
    embedStatus,
    iframeRef,
    handleIframeLoad,
    handleIframeError,
    resetEmbed,
    isEmbedded,
    isBlocked,
  };
}
