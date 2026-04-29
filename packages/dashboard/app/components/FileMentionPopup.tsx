import { File } from "lucide-react";
import type { FileSearchItem } from "../hooks/useFileMention";
import { getDisplayDirname } from "../utils/pathDisplay";
import "./FileMentionPopup.css";

import type { ReactNode } from "react";

export interface FileMentionPopupProps {
  visible: boolean;
  position: { top: number; left: number };
  files: FileSearchItem[];
  selectedIndex: number;
  onSelect: (file: FileSearchItem) => void;
  loading: boolean;
}

/**
 * File mention popup component.
 * Shows a searchable list of files matching the current # mention query.
 */
export function FileMentionPopup({
  visible,
  position,
  files,
  selectedIndex,
  onSelect,
  loading,
}: FileMentionPopupProps): ReactNode | null {
  if (!visible) {
    return null;
  }

  return (
    <div
      className="file-mention-popup"
      style={{ top: position.top, left: position.left }}
      data-testid="file-mention-popup"
      onMouseDown={(e) => {
        // Prevent losing focus from textarea when clicking popup
        e.preventDefault();
      }}
    >
      {loading && (
        <div className="file-mention-popup-loading" data-testid="file-mention-loading">
          <span className="spinner" />
        </div>
      )}

      {!loading && files.length === 0 && (
        <div className="file-mention-popup-empty" data-testid="file-mention-empty">
          No files found
        </div>
      )}

      {!loading && files.length > 0 && (
        <ul className="file-mention-popup-list" role="listbox">
          {files.map((file, index) => {
            const dirPath = getDisplayDirname(file.path);
            const highlightName = file.name;

            return (
              <li
                key={file.path}
                className={`file-mention-popup-item${index === selectedIndex ? " file-mention-popup-item--selected" : ""}`}
                onClick={() => onSelect(file)}
                onMouseEnter={() => {
                  // This will be handled by parent through selectedIndex prop
                }}
                role="option"
                aria-selected={index === selectedIndex}
                data-testid={`file-mention-item-${index}`}
              >
                <span className="file-mention-popup-icon">
                  <File size={14} />
                </span>
                <div className="file-mention-popup-info">
                  <span className="file-mention-popup-item-name">{highlightName}</span>
                  {dirPath && (
                    <span className="file-mention-popup-item-path">{dirPath}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
