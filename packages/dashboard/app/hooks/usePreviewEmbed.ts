import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type EmbedStatus = "unknown" | "loading" | "embedded" | "blocked" | "error";
export type EmbedDetectionMethod = "auto" | "manual" | null;

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
  // Legacy alias for backward compatibility
  embedContext: string | null;
  handleIframeLoad: () => void;
  handleIframeError: () => void;
}

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

const BLOCKED_CONTEXT = "This preview appears to block iframe embedding. Open it in a new tab instead.";
const ERROR_CONTEXT = "The preview URL could not be loaded. Verify the server is running and the URL is correct.";
const TIMEOUT_CONTEXT = "Preview is taking longer than expected and may block iframe embedding.";

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
  const { loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS, detectionMethod: initialDetectionMethod = null } = options;

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const [embedStatus, setEmbedStatusState] = useState<EmbedStatus>("unknown");
  const [blockReason, setBlockReason] = useState<string | null>(null);
  const [detectionMethod] = useState<EmbedDetectionMethod>(initialDetectionMethod);

  const clearLoadingTimeout = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const setEmbedStatus = useCallback(
    (status: EmbedStatus) => {
      clearLoadingTimeout();
      setEmbedStatusState(status);
      setBlockReason(getContextForStatus(status));
    },
    [clearLoadingTimeout],
  );

  const resetEmbedStatus = useCallback(() => {
    clearLoadingTimeout();
    setEmbedStatusState("unknown");
    setBlockReason(null);
  }, [clearLoadingTimeout]);

  const retry = useCallback(() => {
    resetEmbedStatus();
  }, [resetEmbedStatus]);

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
    if (!url || embedStatus !== "loading") {
      clearLoadingTimeout();
      return;
    }

    const timer = window.setTimeout(() => {
      timeoutRef.current = null;
      setEmbedStatusState("blocked");
      setBlockReason(TIMEOUT_CONTEXT);
    }, loadTimeoutMs);

    timeoutRef.current = timer;

    return () => {
      window.clearTimeout(timer);
      if (timeoutRef.current === timer) {
        timeoutRef.current = null;
      }
    };
  }, [clearLoadingTimeout, embedStatus, loadTimeoutMs, url]);

  useEffect(() => {
    return clearLoadingTimeout;
  }, [clearLoadingTimeout]);

  const isEmbedded = embedStatus === "embedded";
  const isBlocked = embedStatus === "blocked" || embedStatus === "error";

  return {
    embedStatus,
    isEmbedded,
    isBlocked,
    blockReason,
    detectionMethod,
    iframeRef,
    resetEmbedStatus,
    setEmbedStatus,
    retry,
    embedContext: blockReason,
    handleIframeLoad,
    handleIframeError,
  };
}
