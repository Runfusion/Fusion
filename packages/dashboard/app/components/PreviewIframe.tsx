import { useCallback, type RefObject, type SyntheticEvent } from "react";

export interface PreviewIframeProps {
  url: string;
  iframeRef: RefObject<HTMLIFrameElement | null>;
  onLoad: () => void;
  onError: () => void;
  className?: string;
}

const DEFAULT_IFRAME_CLASS = "devserver-preview-iframe";

export function PreviewIframe({
  url,
  iframeRef,
  onLoad,
  onError,
  className = DEFAULT_IFRAME_CLASS,
}: PreviewIframeProps) {
  const handleError = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    event.stopPropagation();
    onError();
  }, [onError]);

  return (
    <iframe
      src={url}
      ref={iframeRef}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
      className={className}
      title="Dev server preview"
      onLoad={onLoad}
      onError={handleError}
      onErrorCapture={handleError}
      data-testid="devserver-preview-iframe"
    />
  );
}
