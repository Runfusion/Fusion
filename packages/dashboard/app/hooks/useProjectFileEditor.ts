import { useState, useEffect, useCallback } from "react";
import type { FileContentResponse, SaveFileResponse } from "../api";
import { fetchWorkspaceFileContent, saveWorkspaceFileContent } from "../api";

interface UseProjectFileEditorReturn {
  content: string;
  setContent: (content: string) => void;
  originalContent: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  save: () => Promise<void>;
  hasChanges: boolean;
  mtime: string | null;
}

/**
 * Hook for editing a file in the project directory.
 *
 * @param rootPath - The project root directory path (from config/store)
 * @param filePath - The file path to edit (null if no file selected)
 * @param enabled - Whether to enable loading (e.g., when editor is visible)
 * @returns File editor state and controls
 */
export function useProjectFileEditor(
  rootPath: string,
  filePath: string | null,
  enabled: boolean
): UseProjectFileEditorReturn {
  const [content, setContentState] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [mtime, setMtime] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setContent = useCallback((newContent: string) => {
    setContentState(newContent);
    setError(null);
  }, []);

  // Load file content when filePath changes
  useEffect(() => {
    if (!enabled || !filePath) {
      setContentState("");
      setOriginalContent("");
      setMtime(null);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadFile() {
      setLoading(true);
      setError(null);

      try {
        const response: FileContentResponse = await fetchWorkspaceFileContent("project", filePath!);

        if (!cancelled) {
          setContentState(response.content);
          setOriginalContent(response.content);
          setMtime(response.mtime);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message || "Failed to load file");
          setContentState("");
          setOriginalContent("");
          setMtime(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadFile();

    return () => {
      cancelled = true;
    };
  }, [filePath, enabled]);

  const hasChanges = content !== originalContent;

  const save = useCallback(async () => {
    if (!filePath || !hasChanges) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response: SaveFileResponse = await saveWorkspaceFileContent("project", filePath, content);
      setOriginalContent(content);
      setMtime(response.mtime);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || "Failed to save file");
      throw err;
    } finally {
      setSaving(false);
    }
  }, [filePath, content, hasChanges]);

  return {
    content,
    setContent,
    originalContent,
    loading,
    saving,
    error,
    save,
    hasChanges,
    mtime,
  };
}
