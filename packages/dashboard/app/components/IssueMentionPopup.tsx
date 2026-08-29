import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { IssueMentionItem } from "../api";
import "./IssueMentionPopup.css";

export interface IssueMentionPopupProps {
  visible: boolean;
  position: { top: number; left: number };
  issues: IssueMentionItem[];
  selectedIndex: number;
  onSelect: (issue: IssueMentionItem) => void;
  loading: boolean;
}

export function IssueMentionPopup({
  visible,
  position,
  issues,
  selectedIndex,
  onSelect,
  loading,
}: IssueMentionPopupProps): ReactNode | null {
  const { t } = useTranslation("app");

  if (!visible) return null;

  return (
    <div
      className="issue-mention-popup"
      style={{ top: position.top, left: position.left }}
      data-testid="issue-mention-popup"
      onMouseDown={(event) => {
        event.preventDefault();
      }}
    >
      {loading && (
        <div className="issue-mention-popup-loading" data-testid="issue-mention-loading">
          <span className="spinner" />
        </div>
      )}

      {!loading && issues.length === 0 && (
        <div className="issue-mention-popup-empty" data-testid="issue-mention-empty">
          {t("issues.noIssuesFound", "No issues found")}
        </div>
      )}

      {!loading && issues.length > 0 && (
        <ul className="issue-mention-popup-list" role="listbox">
          {issues.map((issue, index) => (
            <li
              key={`${issue.repository}#${issue.number}`}
              className={`issue-mention-popup-item${index === selectedIndex ? " issue-mention-popup-item--selected" : ""}`}
              role="option"
              aria-selected={index === selectedIndex}
              onClick={() => onSelect(issue)}
              data-testid={`issue-mention-item-${index}`}
            >
              <div className="issue-mention-popup-item-main">
                <span className="issue-mention-popup-number">#{issue.number}</span>
                <span className="issue-mention-popup-title">{issue.title}</span>
              </div>
              <div className="issue-mention-popup-meta">
                <span
                  className="status-dot"
                  style={{
                    backgroundColor: issue.state === "open" ? "var(--color-success)" : "var(--color-muted)",
                  }}
                />
                <span className="issue-mention-popup-repository">{issue.repository}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
