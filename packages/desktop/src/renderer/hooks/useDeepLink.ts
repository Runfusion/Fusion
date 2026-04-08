import { useEffect, useState } from "react";
import { useElectron } from "./useElectron";

export function parseDeepLink(rawLink: string): string | null {
  try {
    const parsed = new URL(rawLink);
    if (parsed.protocol !== "fusion:") {
      return null;
    }

    const segments = parsed.pathname.split("/").filter(Boolean);
    const resource = parsed.hostname || segments[0];
    const identifier = parsed.hostname ? segments[0] : segments[1];

    if (!identifier) {
      return null;
    }

    if (resource === "task" || resource === "project") {
      return `fusion://${resource}/${decodeURIComponent(identifier)}`;
    }

    return null;
  } catch {
    return null;
  }
}

export interface UseDeepLinkResult {
  lastDeepLink: string | null;
}

export function useDeepLink(): UseDeepLinkResult {
  const { isElectron, electronAPI } = useElectron();
  const [lastDeepLink, setLastDeepLink] = useState<string | null>(null);

  useEffect(() => {
    if (!isElectron || !electronAPI?.onDeepLink) {
      return;
    }

    const unsubscribe = electronAPI.onDeepLink((rawLink: string) => {
      const parsed = parseDeepLink(rawLink);
      if (parsed) {
        setLastDeepLink(parsed);
      }
    });

    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
    };
  }, [isElectron, electronAPI]);

  return { lastDeepLink };
}
