import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchDevServerConfig,
  saveDevServerConfig,
  type DevServerConfig,
} from "../api";

interface SelectableDevServerScript {
  name: string;
  command: string;
  source: string;
}

export interface UseDevServerConfigResult {
  config: DevServerConfig | null;
  loading: boolean;
  error: string | null;
  selectScript: (script: SelectableDevServerScript) => Promise<void>;
  clearSelection: () => Promise<void>;
  setPreviewUrlOverride: (url: string | null) => Promise<void>;
  refresh: () => Promise<void>;
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useDevServerConfig(projectId?: string): UseDevServerConfigResult {
  const [config, setConfig] = useState<DevServerConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);

  const refresh = useCallback(async () => {
    const version = versionRef.current + 1;
    versionRef.current = version;
    setLoading(true);

    try {
      const nextConfig = await fetchDevServerConfig(projectId);
      if (versionRef.current !== version) {
        return;
      }

      setConfig(nextConfig);
      setError(null);
    } catch (refreshError) {
      if (versionRef.current !== version) {
        return;
      }

      setError(normalizeError(refreshError));
    } finally {
      if (versionRef.current === version) {
        setLoading(false);
      }
    }
  }, [projectId]);

  const savePartial = useCallback(async (partial: Partial<DevServerConfig>) => {
    const version = versionRef.current + 1;
    versionRef.current = version;
    setLoading(true);
    setError(null);

    try {
      const updated = await saveDevServerConfig(partial, projectId);
      if (versionRef.current !== version) {
        return;
      }

      setConfig(updated);
    } catch (saveError) {
      if (versionRef.current !== version) {
        return;
      }

      const message = normalizeError(saveError);
      setError(message);
      throw saveError;
    } finally {
      if (versionRef.current === version) {
        setLoading(false);
      }
    }
  }, [projectId]);

  const selectScript = useCallback(async (script: SelectableDevServerScript) => {
    await savePartial({
      selectedScript: script.name,
      selectedSource: script.source,
      selectedCommand: script.command,
      selectedAt: new Date().toISOString(),
    });
  }, [savePartial]);

  const clearSelection = useCallback(async () => {
    await savePartial({
      selectedScript: null,
      selectedSource: null,
      selectedCommand: null,
      selectedAt: null,
    });
  }, [savePartial]);

  const setPreviewUrlOverride = useCallback(async (url: string | null) => {
    await savePartial({
      previewUrlOverride: url,
    });
  }, [savePartial]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    config,
    loading,
    error,
    selectScript,
    clearSelection,
    setPreviewUrlOverride,
    refresh,
  };
}
