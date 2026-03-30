import { useState, useEffect, useCallback } from "react";
import type { FileContentResponse, SaveFileResponse } from "../api";
import { fetchFileContent, saveFileContent } from "../api";

interface UseFileEditorReturn {
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
 * Hook for editing a file in a task directory.
 *
 * @param taskId - The task ID
 * @param filePath - The file path to edit (null if no file selected)
 * @param enabled - Whether to enable loading (e.g., when editor is visible)
 * @returns File editor state and controls
 */
export function useFileEditor(
  taskId: string,
  filePath: string | null,
  enabled: boolean
): UseFileEditorReturn {
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
    if (!enabled || !taskId || !filePath) {
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
        const response: FileContentResponse = await fetchFileContent(taskId, filePath!);

        if (!cancelled) {
          setContentState(response.content);
          setOriginalContent(response.content);
          setMtime(response.mtime);
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || "Failed to load file");
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
  }, [taskId, filePath, enabled]);

  const hasChanges = content !== originalContent;

  const save = useCallback(async () => {
    if (!taskId || !filePath || !hasChanges) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response: SaveFileResponse = await saveFileContent(taskId, filePath, content);
      setOriginalContent(content);
      setMtime(response.mtime);
    } catch (err: any) {
      setError(err.message || "Failed to save file");
      throw err;
    } finally {
      setSaving(false);
    }
  }, [taskId, filePath, content, hasChanges]);

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
