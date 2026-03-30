import { Folder, File, ChevronRight, Loader2 } from "lucide-react";
import type { FileNode } from "../api";

interface FileBrowserProps {
  entries: FileNode[];
  currentPath: string;
  onSelectFile: (path: string) => void;
  onNavigate: (path: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
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

export function FileBrowser({
  entries,
  currentPath,
  onSelectFile,
  onNavigate,
  loading,
  error,
  onRetry,
}: FileBrowserProps) {
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
          entries.map((entry) => (
            <div
              key={entry.name}
              className={`file-node file-node--${entry.type}`}
              onClick={() => {
                if (entry.type === "directory") {
                  onNavigate(currentPath === "." ? entry.name : `${currentPath}/${entry.name}`);
                } else {
                  onSelectFile(currentPath === "." ? entry.name : `${currentPath}/${entry.name}`);
                }
              }}
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
          ))
        )}
      </div>
    </div>
  );
}
