import { useState, useCallback, useEffect } from "react";
import { Folder, FolderOpen, ChevronRight, ChevronUp, Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { browseDirectory, type BrowseDirectoryResult } from "../api";
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
}

export function DirectoryPicker({ value, onChange, placeholder, onInputKeyDown, nodeId, localNodeId }: DirectoryPickerProps) {
  const [browser, setBrowser] = useState<BrowserState>({
    isOpen: false,
    loading: false,
    error: null,
    currentPath: "",
    parentPath: null,
    entries: [],
    showHidden: false,
  });

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

  // Fetch when browser opens
  useEffect(() => {
    if (browser.isOpen && !browser.loading && browser.entries.length === 0 && !browser.error) {
      fetchEntries(value || undefined, browser.showHidden);
    }
  }, [browser.isOpen, browser.loading, browser.entries.length, browser.error, value, browser.showHidden, fetchEntries, nodeId, localNodeId]);

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
  }, [browser.showHidden]);

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
          placeholder={placeholder || "/path/to/your/project"}
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm directory-picker-browse-btn"
          onClick={handleToggleBrowser}
          aria-label={browser.isOpen ? "Close directory browser" : "Browse directories"}
        >
          {browser.isOpen ? <FolderOpen size={16} /> : <Folder size={16} />}
          <span>Browse</span>
        </button>
      </div>

      {browser.isOpen && (
        <div className="directory-picker-browser" role="tree" aria-label="Directory browser">
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
                aria-label="Go to parent directory"
                title="Parent directory"
              >
                <ChevronUp size={14} />
                <span>Up</span>
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm btn-secondary directory-picker-hidden-toggle"
              onClick={handleToggleHidden}
              aria-label={browser.showHidden ? "Hide hidden directories" : "Show hidden directories"}
              title={browser.showHidden ? "Hide hidden" : "Show hidden"}
            >
              {browser.showHidden ? <EyeOff size={14} /> : <Eye size={14} />}
              <span>{browser.showHidden ? "Hide hidden" : "Show hidden"}</span>
            </button>
          </div>

          {/* Content */}
          {browser.loading ? (
            <div className="directory-picker-loading">
              <Loader2 size={20} className="animate-spin" />
              <span>Loading…</span>
            </div>
          ) : browser.error ? (
            <div className="directory-picker-error">
              <AlertCircle size={16} />
              <span>{browser.error}</span>
            </div>
          ) : (
            <div className="directory-picker-entries">
              {browser.entries.length === 0 ? (
                <div className="directory-picker-empty">No subdirectories</div>
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
              Select
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
