import "./FileBrowser.css";
import { useState, useCallback, useEffect, useRef } from "react";
import { Folder, File, ChevronRight, Loader2, Copy, Move, Trash2, Pencil, Download, Archive } from "lucide-react";
import type { FileNode } from "../api";
import { copyFile, moveFile, deleteFile, renameFile, downloadFileUrl, downloadZipUrl } from "../api";
import { appendTokenQuery } from "../auth";
import { getErrorMessage } from "@fusion/core";

interface FileBrowserProps {
  entries: FileNode[];
  currentPath: string;
  onSelectFile: (path: string) => void;
  onNavigate: (path: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Workspace identifier for file operations ("project" or task ID) */
  workspace?: string;
  /** Callback to refresh the file list after an operation */
  onRefresh?: () => void;
  /** Optional project ID for multi-project scoping */
  projectId?: string;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(mtime?: string): string {
  if (!mtime) return "";
  const date = new Date(mtime);
  return date.toLocaleDateString();
}

/** Build the full relative path for a file/directory entry */
function entryPath(currentPath: string, name: string): string {
  return currentPath === "." ? name : `${currentPath}/${name}`;
}

// ── Context Menu State ──────────────────────────────────────────────────

interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  entry: FileNode | null;
  entryFullPath: string;
}

const INITIAL_CONTEXT_MENU: ContextMenuState = {
  visible: false,
  x: 0,
  y: 0,
  entry: null,
  entryFullPath: "",
};

// ── Operation Dialog Types ──────────────────────────────────────────────

type DialogType = "copy" | "move" | "rename" | "delete" | null;

interface DialogState {
  type: DialogType;
  entry: FileNode | null;
  entryFullPath: string;
}

const INITIAL_DIALOG: DialogState = { type: null, entry: null, entryFullPath: "" };

const LONG_PRESS_FEEDBACK_MS = 200;
const LONG_PRESS_DURATION_MS = 500;
const TOUCH_MOVE_THRESHOLD = 10;

interface TouchPoint {
  x: number;
  y: number;
}

// ── Context Menu Component ──────────────────────────────────────────────

interface ContextMenuItem {
  id: string;
  label: string;
  icon: typeof Copy;
  disabled: boolean;
}

interface FileContextMenuProps {
  x: number;
  y: number;
  entry: FileNode;
  onAction: (action: string) => void;
  onClose: () => void;
}

function FileContextMenu({ x, y, entry, onAction, onClose }: FileContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState({ x, y });

  // Adjust position to prevent viewport overflow
  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    const rect = menu.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewportWidth = vv?.width && vv.width > 0 ? vv.width : window.innerWidth;
    const viewportHeight = vv?.height && vv.height > 0 ? vv.height : window.innerHeight;
    const offsetLeft = vv?.offsetLeft ?? 0;
    const offsetTop = vv?.offsetTop ?? 0;

    const pad = 8;
    let ax = x - offsetLeft;
    let ay = y - offsetTop;

    if (ax + rect.width > viewportWidth - pad) {
      ax = viewportWidth - pad - rect.width;
    }
    if (ay + rect.height > viewportHeight - pad) {
      ay = viewportHeight - pad - rect.height;
    }

    if (ax < pad) ax = pad;
    if (ay < pad) ay = pad;

    setAdjustedPos({ x: ax + offsetLeft, y: ay + offsetTop });
  }, [x, y]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const isDir = entry.type === "directory";

  const items: ContextMenuItem[] = [
    { id: "copy", label: "Copy", icon: Copy, disabled: false },
    { id: "move", label: "Move", icon: Move, disabled: false },
    { id: "rename", label: "Rename", icon: Pencil, disabled: false },
    ...(isDir
      ? [{ id: "download-zip" as string, label: "Download as ZIP", icon: Archive, disabled: false }]
      : [{ id: "download" as string, label: "Download", icon: Download, disabled: false }]
    ),
    { id: "divider", label: "", icon: Copy, disabled: true },
    { id: "delete", label: "Delete", icon: Trash2, disabled: false },
  ];

  return (
    <div className="context-menu-overlay" onClick={onClose}>
      <div
        ref={menuRef}
        className="file-browser-context-menu"
        role="menu"
        aria-label="File operations"
        style={{ left: adjustedPos.x, top: adjustedPos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) =>
          item.id === "divider" ? (
            <div key="divider" className="file-browser-context-menu__divider" role="separator" />
          ) : (
            <button
              key={item.id}
              role="menuitem"
              className={`file-browser-context-menu__item ${
                item.disabled ? "file-browser-context-menu__disabled" : ""
              } ${item.id === "delete" ? "file-browser-context-menu__item--danger" : ""}`}
              disabled={item.disabled}
              onClick={() => onAction(item.id)}
            >
              <item.icon size={14} className="file-browser-context-menu__item-icon" />
              <span>{item.label}</span>
            </button>
          )
        )}
      </div>
    </div>
  );
}

// ── Operation Dialog Component ──────────────────────────────────────────

interface OperationDialogProps {
  type: DialogType;
  entry: FileNode;
  entryFullPath: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
  loading: boolean;
  error: string | null;
}

function OperationDialog({ type, entry, entryFullPath, onConfirm, onCancel, loading, error }: OperationDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultValue = type === "rename" ? entry.name : "";
  const [value, setValue] = useState(defaultValue);

  // Focus input on mount
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // Select filename without extension for rename
  useEffect(() => {
    if (type === "rename" && inputRef.current) {
      const dotIndex = entry.name.lastIndexOf(".");
      if (dotIndex > 0) {
        inputRef.current.setSelectionRange(0, dotIndex);
      } else {
        inputRef.current.select();
      }
    }
  }, [type, entry.name]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && value.trim()) {
      onConfirm(value.trim());
    }
    if (e.key === "Escape") {
      onCancel();
    }
  };

  if (type === "delete") {
    return (
      <div className="context-menu-overlay" onClick={onCancel}>
        <div className="file-browser-dialog" onClick={(e) => e.stopPropagation()}>
          <div className="file-browser-dialog-title">Delete {entry.type === "directory" ? "Folder" : "File"}</div>
          <div className="file-browser-dialog-message">
            Are you sure you want to delete <strong>{entry.name}</strong>?
            {entry.type === "directory" && " This will delete all contents recursively."}
          </div>
          {error && <div className="file-browser-dialog-error">{error}</div>}
          <div className="file-browser-dialog-actions">
            <button className="btn btn-sm" onClick={onCancel} disabled={loading}>
              Cancel
            </button>
            <button
              className="btn btn-danger btn-sm"
              onClick={() => onConfirm("")}
              disabled={loading}
            >
              {loading ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const labels: Record<string, { title: string; placeholder: string; confirm: string }> = {
    copy: { title: "Copy", placeholder: "Destination path", confirm: "Copy" },
    move: { title: "Move", placeholder: "Destination path", confirm: "Move" },
    rename: { title: "Rename", placeholder: "New name", confirm: "Rename" },
  };

  const config = labels[type!];

  return (
    <div className="context-menu-overlay" onClick={onCancel}>
      <div className="file-browser-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="file-browser-dialog-title">{config.title}</div>
        <div className="file-browser-dialog-info">
          {type === "rename" ? entry.name : entryFullPath}
        </div>
        <input
          ref={inputRef}
          className="file-browser-dialog-input"
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={config.placeholder}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        {error && <div className="file-browser-dialog-error">{error}</div>}
        <div className="file-browser-dialog-actions">
          <button className="btn btn-sm" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onConfirm(value.trim())}
            disabled={loading || !value.trim()}
          >
            {loading ? `${config.confirm}ing...` : config.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main FileBrowser Component ──────────────────────────────────────────

export function FileBrowser({
  entries,
  currentPath,
  onSelectFile,
  onNavigate,
  loading,
  error,
  onRetry,
  workspace,
  onRefresh,
  projectId,
}: FileBrowserProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(INITIAL_CONTEXT_MENU);
  const [dialog, setDialog] = useState<DialogState>(INITIAL_DIALOG);
  const [operationLoading, setOperationLoading] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [isLongPressing, setIsLongPressing] = useState(false);
  const [longPressTargetPath, setLongPressTargetPath] = useState<string | null>(null);

  const longPressTimerRef = useRef<number | null>(null);
  const longPressFeedbackTimerRef = useRef<number | null>(null);
  const touchStartRef = useRef<TouchPoint | null>(null);
  const touchOpenHandledRef = useRef(false);

  const clearLongPressTimers = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (longPressFeedbackTimerRef.current !== null) {
      window.clearTimeout(longPressFeedbackTimerRef.current);
      longPressFeedbackTimerRef.current = null;
    }
  }, []);

  const cancelLongPress = useCallback(() => {
    clearLongPressTimers();
    touchStartRef.current = null;
    setIsLongPressing(false);
    setLongPressTargetPath(null);
  }, [clearLongPressTimers]);

  useEffect(() => {
    return () => {
      clearLongPressTimers();
    };
  }, [clearLongPressTimers]);

  const openContextMenuAt = useCallback((x: number, y: number, entry: FileNode, fullPath: string) => {
    setContextMenu({
      visible: true,
      x,
      y,
      entry,
      entryFullPath: fullPath,
    });
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent, entry: FileNode, fullPath: string) => {
    if (e.touches.length !== 1) return;

    const touch = e.touches[0];
    if (!touch) return;

    cancelLongPress();
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };

    longPressFeedbackTimerRef.current = window.setTimeout(() => {
      setIsLongPressing(true);
      setLongPressTargetPath(fullPath);
    }, LONG_PRESS_FEEDBACK_MS);

    longPressTimerRef.current = window.setTimeout(() => {
      const point = touchStartRef.current;
      if (!point) return;

      touchOpenHandledRef.current = true;
      setIsLongPressing(false);
      setLongPressTargetPath(null);
      clearLongPressTimers();

      openContextMenuAt(point.x, point.y, entry, fullPath);
    }, LONG_PRESS_DURATION_MS);
  }, [cancelLongPress, clearLongPressTimers, openContextMenuAt]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const start = touchStartRef.current;
    const touch = e.touches[0];
    if (!start || !touch) return;

    if (
      Math.abs(touch.clientX - start.x) > TOUCH_MOVE_THRESHOLD ||
      Math.abs(touch.clientY - start.y) > TOUCH_MOVE_THRESHOLD
    ) {
      cancelLongPress();
    }
  }, [cancelLongPress]);

  const handleTouchEnd = useCallback(() => {
    cancelLongPress();
  }, [cancelLongPress]);

  // Close context menu on scroll within the file browser
  useEffect(() => {
    if (!contextMenu.visible) return;
    const browserList = document.querySelector(".file-browser-list");
    const handleClose = () => {
      touchOpenHandledRef.current = false;
      cancelLongPress();
      setContextMenu(INITIAL_CONTEXT_MENU);
    };
    browserList?.addEventListener("scroll", handleClose);
    return () => browserList?.removeEventListener("scroll", handleClose);
  }, [cancelLongPress, contextMenu.visible]);

  // Close context menu on click outside or Escape
  useEffect(() => {
    if (!contextMenu.visible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        touchOpenHandledRef.current = false;
        setContextMenu(INITIAL_CONTEXT_MENU);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [contextMenu.visible]);

  const handleContextMenu = useCallback((e: React.MouseEvent, entry: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    cancelLongPress();
    touchOpenHandledRef.current = false;
    openContextMenuAt(e.clientX, e.clientY, entry, entryPath(currentPath, entry.name));
  }, [cancelLongPress, currentPath, openContextMenuAt]);

  const handleContextAction = useCallback((action: string) => {
    if (!contextMenu.entry) return;

    touchOpenHandledRef.current = false;

    const entry = contextMenu.entry;
    const fullPath = contextMenu.entryFullPath;

    setContextMenu(INITIAL_CONTEXT_MENU);

    // Download actions trigger directly (no dialog)
    if (action === "download") {
      if (!workspace) return;
      const url = downloadFileUrl(workspace, fullPath, projectId);
      window.open(appendTokenQuery(url), "_blank");
      return;
    }

    if (action === "download-zip") {
      if (!workspace) return;
      const url = downloadZipUrl(workspace, fullPath, projectId);
      window.open(appendTokenQuery(url), "_blank");
      return;
    }

    // Other actions open a dialog
    setDialog({
      type: action as DialogType,
      entry,
      entryFullPath: fullPath,
    });
    setOperationError(null);
  }, [contextMenu, workspace, projectId]);

  const handleDialogConfirm = useCallback(async (value: string) => {
    if (!dialog.type || !dialog.entry || !workspace) return;

    setOperationLoading(true);
    setOperationError(null);

    try {
      switch (dialog.type) {
        case "copy":
          await copyFile(workspace, dialog.entryFullPath, value, projectId);
          break;
        case "move":
          await moveFile(workspace, dialog.entryFullPath, value, projectId);
          break;
        case "rename":
          await renameFile(workspace, dialog.entryFullPath, value, projectId);
          break;
        case "delete":
          await deleteFile(workspace, dialog.entryFullPath, projectId);
          break;
      }

      setDialog(INITIAL_DIALOG);
      onRefresh?.();
    } catch (err) {
      setOperationError(getErrorMessage(err) || "Operation failed");
    } finally {
      setOperationLoading(false);
    }
  }, [dialog, workspace, onRefresh, projectId]);

  const handleDialogCancel = useCallback(() => {
    setDialog(INITIAL_DIALOG);
    setOperationError(null);
  }, []);

  const handleFileNodeClick = useCallback((entry: FileNode, fullPath: string) => {
    if (touchOpenHandledRef.current) {
      touchOpenHandledRef.current = false;
      return;
    }

    if (contextMenu.visible) return;

    if (entry.type === "directory") {
      onNavigate(fullPath);
    } else {
      onSelectFile(fullPath);
    }
  }, [contextMenu.visible, onNavigate, onSelectFile]);

  if (loading) {
    return (
      <div className="file-browser-loading">
        <Loader2 className="spin" size={24} />
        <span>Loading files...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="file-browser-error">
        <p>Error: {error}</p>
        {onRetry && (
          <button className="btn btn-sm" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="file-browser">
      <div className="file-browser-header">
        {currentPath !== "." && (
          <button
            className="file-browser-up"
            onClick={() => {
              const parts = currentPath.split("/").filter(Boolean);
              parts.pop();
              onNavigate(parts.length === 0 ? "." : parts.join("/"));
            }}
          >
            <ChevronRight size={16} style={{ transform: "rotate(-90deg)" }} />
            Up one level
          </button>
        )}
        <span className="file-browser-path">{currentPath === "." ? "Root" : currentPath}</span>
      </div>

      <div className="file-browser-list">
        {entries.length === 0 ? (
          <div className="file-browser-empty">(empty directory)</div>
        ) : (
          entries.map((entry) => {
            const fullPath = entryPath(currentPath, entry.name);
            const isLongPressTarget = isLongPressing && longPressTargetPath === fullPath;

            return (
              <div
                key={entry.name}
                className={`file-node file-node--${entry.type} ${isLongPressTarget ? "file-node--long-pressing" : ""}`}
                onClick={() => handleFileNodeClick(entry, fullPath)}
                onContextMenu={(e) => handleContextMenu(e, entry)}
                onTouchStart={(e) => handleTouchStart(e, entry, fullPath)}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTouchCancel={handleTouchEnd}
              >
                <div className="file-node-icon">
                  {entry.type === "directory" ? (
                    <Folder size={16} />
                  ) : (
                    <File size={16} />
                  )}
                </div>
                <div className="file-node-name">{entry.name}</div>
                {entry.type === "file" && entry.size !== undefined && (
                  <div className="file-node-size">{formatBytes(entry.size)}</div>
                )}
                {entry.mtime && (
                  <div className="file-node-time">{formatTime(entry.mtime)}</div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Context Menu */}
      {contextMenu.visible && contextMenu.entry && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          onAction={handleContextAction}
          onClose={() => {
            touchOpenHandledRef.current = false;
            setContextMenu(INITIAL_CONTEXT_MENU);
          }}
        />
      )}

      {/* Operation Dialog */}
      {dialog.type && dialog.entry && (
        <OperationDialog
          type={dialog.type}
          entry={dialog.entry}
          entryFullPath={dialog.entryFullPath}
          onConfirm={handleDialogConfirm}
          onCancel={handleDialogCancel}
          loading={operationLoading}
          error={operationError}
        />
      )}
    </div>
  );
}
