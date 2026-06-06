import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Folder, FolderOpen, ChevronRight, ChevronUp, Loader2, Eye, EyeOff, AlertCircle, Plus } from "lucide-react";
import { browseDirectory, createDirectory, type BrowseDirectoryResult } from "../api";
import { getPathBreadcrumbs } from "../utils/pathDisplay";
import "./DirectoryPicker.css";

export interface DirectoryPickerProps {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  /** Optional keydown handler forwarded to the text input (e.g. Enter-to-submit). */
  onInputKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  /** Node ID of the target node for browsing. */
  nodeId?: string;
  /** Node ID of the local node (used to determine when to route through proxy). */
  localNodeId?: string;
}

interface BrowserState {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  currentPath: string;
  parentPath: string | null;
  entries: BrowseDirectoryResult["entries"];
  showHidden: boolean;
  createFolderOpen: boolean;
  createFolderError: string | null;
}

export function DirectoryPicker({ value, onChange, placeholder, onInputKeyDown, nodeId, localNodeId }: DirectoryPickerProps) {
  const { t } = useTranslation("app");
  const [browser, setBrowser] = useState<BrowserState>({
    isOpen: false,
    loading: false,
    error: null,
    currentPath: "",
    parentPath: null,
    entries: [],
    showHidden: false,
    createFolderOpen: false,
    createFolderError: null,
  });
  const [newFolderName, setNewFolderName] = useState("");

  const fetchEntries = useCallback(async (path?: string, showHidden = false) => {
    setBrowser((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const result = await browseDirectory(path, showHidden, nodeId, localNodeId);
      setBrowser((prev) => ({
        ...prev,
        loading: false,
        currentPath: result.currentPath,
        parentPath: result.parentPath,
        entries: result.entries,
      }));
    } catch (err) {
      setBrowser((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to browse directory",
      }));
    }
  }, [nodeId, localNodeId]);

  const handleToggleBrowser = useCallback(() => {
    setBrowser((prev) => {
      if (!prev.isOpen) {
        // Opening — fetch entries
        return { ...prev, isOpen: true };
      }
      return { ...prev, isOpen: false };
    });
  }, []);

  // Fetch when browser opens (only for the initial open before any path has been fetched)
  useEffect(() => {
    if (browser.isOpen && !browser.loading && !browser.currentPath && !browser.error) {
      fetchEntries(value || undefined, browser.showHidden);
    }
  }, [browser.isOpen, browser.loading, browser.currentPath, browser.error, value, browser.showHidden, fetchEntries, nodeId, localNodeId]);

  const handleNavigate = useCallback(
    (path: string) => {
      fetchEntries(path, browser.showHidden);
    },
    [fetchEntries, browser.showHidden]
  );

  const handleSelect = useCallback(() => {
    onChange(browser.currentPath);
    setBrowser((prev) => ({ ...prev, isOpen: false }));
  }, [browser.currentPath, onChange]);

  const handleToggleHidden = useCallback(() => {
    setBrowser((prev) => {
      const next = !prev.showHidden;
      return { ...prev, showHidden: next };
    });
  }, []);

  // Refetch when showHidden changes while browser is open
  useEffect(() => {
    if (browser.isOpen && browser.currentPath) {
      fetchEntries(browser.currentPath, browser.showHidden);
    }
  }, [browser.showHidden, fetchEntries]);

  const handleToggleCreateFolder = useCallback(() => {
    setBrowser((prev) => ({
      ...prev,
      createFolderOpen: !prev.createFolderOpen,
      createFolderError: null,
    }));
    setNewFolderName("");
  }, []);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim() || !browser.currentPath) return;

    // Validate folder name doesn't contain path separators or traversal
    const trimmedName = newFolderName.trim();
    if (trimmedName.includes("/") || trimmedName.includes("\\") || trimmedName.includes("..")) {
      setBrowser((prev) => ({
        ...prev,
        createFolderError: t("dirPicker.createFolderError", "Folder name cannot contain path separators or '..'"),
      }));
      return;
    }

    // Normalize path separator for the current platform by using the same
    // separator already present in currentPath
    const sep = browser.currentPath.includes("\\") ? "\\" : "/";
    const folderPath = browser.currentPath.endsWith(sep)
      ? browser.currentPath + trimmedName
      : browser.currentPath + sep + trimmedName;

    setBrowser((prev) => ({ ...prev, loading: true, createFolderError: null }));
    try {
      await createDirectory(folderPath);
      setNewFolderName("");
      setBrowser((prev) => ({ ...prev, createFolderOpen: false }));
      // Refresh entries to show the new folder
      await fetchEntries(browser.currentPath, browser.showHidden);
    } catch (err) {
      setBrowser((prev) => ({
        ...prev,
        loading: false,
        createFolderError: err instanceof Error ? err.message : "Failed to create folder",
      }));
    }
  }, [newFolderName, browser.currentPath, browser.showHidden, fetchEntries]);

  const handleCreateFolderKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleCreateFolder();
    } else if (e.key === "Escape") {
      setBrowser((prev) => ({ ...prev, createFolderOpen: false, createFolderError: null }));
      setNewFolderName("");
    }
  }, [handleCreateFolder]);

  const breadcrumbs = browser.currentPath ? getPathBreadcrumbs(browser.currentPath) : [];

  return (
    <div className="directory-picker">
      <div className="directory-picker-input-row">
        <input
          type="text"
          className="input directory-picker-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={placeholder || t("dirPicker.defaultPlaceholder", "/path/to/your/project")}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm directory-picker-browse-btn"
          onClick={handleToggleBrowser}
          aria-label={browser.isOpen ? t("dirPicker.closeBrowser", "Close directory browser") : t("dirPicker.openBrowser", "Browse directories")}
        >
          {browser.isOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
          <span>{t("dirPicker.browse", "Browse")}</span>
        </button>
      </div>

      {browser.isOpen && (
        <div className="directory-picker-browser" role="tree" aria-label={t("dirPicker.ariaLabel", "Directory browser")}>
          {/* Breadcrumbs */}
          <div className="directory-picker-breadcrumbs">
            {breadcrumbs.map((breadcrumb, index) => {
              return (
                <span key={breadcrumb.path} className="directory-picker-breadcrumb-item">
                  {index > 0 && <ChevronRight size={12} className="directory-picker-breadcrumb-sep" />}
                  <button
                    type="button"
                    className="directory-picker-breadcrumb"
                    onClick={() => handleNavigate(breadcrumb.path)}
                    title={breadcrumb.path}
                  >
                    {breadcrumb.label}
                  </button>
                </span>
              );
            })}
          </div>

          {/* Toolbar */}
          <div className="directory-picker-toolbar">
            {browser.parentPath && (
              <button
                type="button"
                className="btn btn-sm btn-secondary directory-picker-up-btn"
                onClick={() => handleNavigate(browser.parentPath!)}
                aria-label={t("dirPicker.parentDir", "Go to parent directory")}
                title={t("dirPicker.parentDirTitle", "Parent directory")}
              >
                <ChevronUp size={14} />
                <span>{t("dirPicker.up", "Up")}</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-secondary directory-picker-hidden-toggle"
              onClick={handleToggleHidden}
              aria-label={browser.showHidden ? t("dirPicker.hideHiddenAria", "Hide hidden directories") : t("dirPicker.showHiddenAria", "Show hidden directories")}
              title={browser.showHidden ? t("dirPicker.hideHiddenTitle", "Hide hidden") : t("dirPicker.showHiddenTitle", "Show hidden")}
            >
              {browser.showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
              <span>{browser.showHidden ? t("dirPicker.hideHidden", "Hide hidden") : t("dirPicker.showHidden", "Show hidden")}</span>
            </button>
            <button
              type="button"
              className="btn btn-sm btn-secondary directory-picker-create-folder-toggle"
              onClick={handleToggleCreateFolder}
              aria-label={t("dirPicker.createFolderAria", "Create new folder")}
              title={t("dirPicker.createFolderTitle", "Create folder")}
            >
              <Plus size={14} />
              <span>{t("dirPicker.createFolder", "New folder")}</span>
            </button>
          </div>

          {/* Content */}
          {browser.loading ? (
            <div className="directory-picker-loading">
              <Loader2 size={20} className="animate-spin" />
              <span>{t("dirPicker.loading", "Loading…")}</span>
            </div>
          ) : browser.error ? (
            <div className="directory-picker-error">
              <AlertCircle size={16} />
              <span>{browser.error}</span>
            </div>
          ) : (
            <div className="directory-picker-entries">
              {browser.entries.length === 0 ? (
                <div className="directory-picker-empty">{t("dirPicker.noSubdirs", "No subdirectories")}</div>
              ) : (
                browser.entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    className="directory-picker-entry"
                    onClick={() => handleNavigate(entry.path)}
                    role="treeitem"
                    title={entry.path}
                  >
                    <Folder size={16} className="directory-picker-entry-icon" />
                    <span className="directory-picker-entry-name">{entry.name}</span>
                    {entry.hasChildren && (
                      <ChevronRight size={14} className="directory-picker-entry-arrow" />
                    )}
                  </button>
                ))
              )}
            </div>
          )}

          {/* Create folder input */}
          {browser.createFolderOpen && (
            <div className="directory-picker-create-folder">
              <input
                type="text"
                className="input directory-picker-create-folder-input"
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={handleCreateFolderKeyDown}
                placeholder={t("dirPicker.newFolderPlaceholder", "Folder name")}
                autoFocus
              />
              <div className="directory-picker-create-folder-actions">
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleCreateFolder}
                  disabled={!newFolderName.trim() || browser.loading || !browser.currentPath}
                >
                  {t("dirPicker.createFolderConfirm", "Create")}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={handleToggleCreateFolder}
                >
                  {t("dirPicker.cancel", "Cancel")}
                </button>
              </div>
              {browser.createFolderError && (
                <div className="directory-picker-create-folder-error">
                  <AlertCircle size={14} />
                  <span>{browser.createFolderError}</span>
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="directory-picker-actions">
            <span className="directory-picker-selected-path" title={browser.currentPath}>
              {browser.currentPath}
            </span>
            <button
              type="button"
              className="btn btn-primary directory-picker-select-btn"
              onClick={handleSelect}
            >
              {t("dirPicker.select", "Select")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
