import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

export type EmbedStatus = "unknown" | "loading" | "embedded" | "blocked" | "error";
export type EmbedDetectionMethod = "auto" | "manual" | null;

const BLOCKED_CONTEXT = "This preview appears to block iframe embedding. Open it in a new tab instead.";
const ERROR_CONTEXT = "The preview URL could not be loaded. Verify the server is running and the URL is correct.";
const TIMEOUT_CONTEXT = "Preview is taking longer than expected and may block iframe embedding.";

interface UsePreviewEmbedOptions {
  loadTimeoutMs?: number;
  detectionMethod?: EmbedDetectionMethod;
}

interface UsePreviewEmbedResult {
  embedStatus: EmbedStatus;
  isEmbedded: boolean;
  isBlocked: boolean;
  blockReason: string | null;
  detectionMethod: EmbedDetectionMethod;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  resetEmbedStatus: () => void;
  // Extended API for direct status control (backward compatibility)
  setEmbedStatus: (status: EmbedStatus) => void;
  retry: () => void;
  // Legacy aliases for backward compatibility
  embedContext: string | null;
  handleIframeLoad: () => void;
  handleIframeError: () => void;
}

function getContextForStatus(status: EmbedStatus): string | null {
  if (status === "blocked") {
    return BLOCKED_CONTEXT;
  }

  if (status === "error") {
    return ERROR_CONTEXT;
  }

  return null;
}

export function usePreviewEmbed(url: string | null, options: UsePreviewEmbedOptions = {}): UsePreviewEmbedResult {
  const { loadTimeoutMs = 10000, detectionMethod: initialDetectionMethod = null } = options;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [embedStatus, setEmbedStatusState] = useState<EmbedStatus>("unknown");
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [detectionMethod] = useState<EmbedDetectionMethod>(initialDetectionMethod);

  const clearLoadingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const setEmbedStatus = useCallback((status: EmbedStatus) => {
    setEmbedStatusState(status);
    setBlockReason(getContextForStatus(status));
  }, []);

  const setBlockedByTimeout = useCallback(() => {
    setEmbedStatusState("blocked");
    setBlockReason(TIMEOUT_CONTEXT);
  }, []);

  useEffect(() => {
    clearLoadingTimeout();

    if (!url) {
      setEmbedStatusState("unknown");
      setBlockReason(null);
      return;
    }

    setEmbedStatusState("unknown");
    setBlockReason(null);

    let canceled = false;
    queueMicrotask(() => {
      if (canceled) {
        return;
      }
      setEmbedStatusState("loading");
      setBlockReason(null);
    });

    return () => {
      canceled = true;
      clearLoadingTimeout();
    };
  }, [clearLoadingTimeout, url]);

  useEffect(() => {
    if (embedStatus !== "loading") {
      clearLoadingTimeout();
      return;
    }

    const timer = setTimeout(() => {
      timeoutRef.current = null;
      setBlockedByTimeout();
    }, loadTimeoutMs);

    timeoutRef.current = timer;

    return () => {
      clearTimeout(timer);
      if (timeoutRef.current === timer) {
        timeoutRef.current = null;
      }
    };
  }, [clearLoadingTimeout, embedStatus, loadTimeoutMs, setBlockedByTimeout]);

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
      // Cross-origin access can throw; assume successful embed.
    }

    setEmbedStatus("embedded");
  }, [setEmbedStatus]);

  const handleIframeError = useCallback(() => {
    setEmbedStatus("error");
  }, [setEmbedStatus]);

  useEffect(() => {
    clearLoadingTimeout();

    if (!url) {
      setEmbedStatusState("unknown");
      setBlockReason(null);
      return;
    }

    setEmbedStatusState("unknown");
    setBlockReason(null);
  }, [clearLoadingTimeout]);

  const resetEmbedStatus = useCallback(() => {
    clearLoadingTimeout();
    setEmbedStatusState("unknown");
    setBlockReason(null);
  }, [clearLoadingTimeout]);

  const retry = resetEmbedStatus;

  const isEmbedded = useMemo(() => embedStatus === "embedded", [embedStatus]);
  const isBlocked = useMemo(
    () => embedStatus === "blocked" || embedStatus === "error",
    [embedStatus],
  );

  return {
    embedStatus,
    isEmbedded,
    isBlocked,
    blockReason,
    detectionMethod,
    iframeRef,
    resetEmbedStatus,
    // Legacy aliases
    setEmbedStatus,
    retry,
    embedContext: blockReason,
    handleIframeLoad,
    handleIframeError,
  };
}
