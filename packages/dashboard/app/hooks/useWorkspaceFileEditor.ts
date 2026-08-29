import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import type { FileContentResponse, SaveFileResponse } from "../api";
import { fetchWorkspaceFileContent, saveWorkspaceFileContent } from "../api";

export const AUTO_SAVE_DEBOUNCE_MS = 800;

interface UseWorkspaceFileEditorReturn {
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
 * Hook for editing a file in a selected workspace.
 *
 * @param workspace - The workspace identifier ("project" or task ID)
 * @param filePath - The selected file path
 * @param enabled - Whether loading is enabled
 * @param projectId - Optional project ID for multi-project scoping
 */
export function useWorkspaceFileEditor(
  workspace: string,
  filePath: string | null,
  enabled: boolean,
  projectId?: string,
  autoSave = false,
): UseWorkspaceFileEditorReturn {
  const { t } = useTranslation("app");
  const [content, setContentState] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [mtime, setMtime] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAutoSaveAttemptRef = useRef<string | null>(null);

  const setContent = useCallback((newContent: string) => {
    setContentState(newContent);
    setError(null);
  }, []);

  useEffect(() => {
    if (!enabled || !workspace || !filePath) {
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
        const response: FileContentResponse = await fetchWorkspaceFileContent(workspace, filePath!, projectId);

        if (!cancelled) {
          setContentState(response.content);
          setOriginalContent(response.content);
          setMtime(response.mtime);
          lastAutoSaveAttemptRef.current = null;
        }
      } catch (err) {
        if (!cancelled) {
          setError(getErrorMessage(err) || t("editor.failedLoadFile", "Failed to load file"));
          setContentState("");
          setOriginalContent("");
          setMtime(null);
          lastAutoSaveAttemptRef.current = null;
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadFile();

    return () => {
      cancelled = true;
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
      lastAutoSaveAttemptRef.current = null;
    };
  }, [workspace, filePath, enabled, projectId]);

  const hasChanges = content !== originalContent;

  const save = useCallback(async () => {
    if (!workspace || !filePath || !hasChanges) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const response: SaveFileResponse = await saveWorkspaceFileContent(workspace, filePath, content, projectId);
      setOriginalContent(content);
      setMtime(response.mtime);
    } catch (err) {
      setError(getErrorMessage(err) || t("editor.failedSaveFile", "Failed to save file"));
      throw err;
    } finally {
      setSaving(false);
    }
  }, [workspace, filePath, content, hasChanges, projectId]);

  /*
  FNXC:FileEditor 2026-07-12-00:00:
  Debounced workspace auto-save may only run for a loaded editable file with real user changes. Clear the pending timer whenever the workspace/file/effective content changes, key attempts by workspace+file+content so a failed write surfaces once without spinning, and rely on hasChanges becoming false after save to prevent originalContent/mtime updates from scheduling a loop.
  */
  useEffect(() => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = null;
    }

    if (!autoSave || !enabled || !workspace || !filePath || !hasChanges || saving || loading) {
      return;
    }

    const attemptKey = JSON.stringify([workspace, filePath, projectId ?? "", content]);
    if (lastAutoSaveAttemptRef.current === attemptKey) {
      return;
    }

    autoSaveTimeoutRef.current = setTimeout(() => {
      autoSaveTimeoutRef.current = null;
      lastAutoSaveAttemptRef.current = attemptKey;
      void save().catch(() => undefined);
    }, AUTO_SAVE_DEBOUNCE_MS);

    return () => {
      if (autoSaveTimeoutRef.current) {
        clearTimeout(autoSaveTimeoutRef.current);
        autoSaveTimeoutRef.current = null;
      }
    };
  }, [autoSave, enabled, workspace, filePath, projectId, content, hasChanges, saving, loading, save]);

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
