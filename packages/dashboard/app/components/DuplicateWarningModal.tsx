import "./DuplicateWarningModal.css";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { DuplicateMatch } from "../api";

interface DuplicateWarningModalProps {
  matches: DuplicateMatch[];
  onOpen: (id: string) => void;
  onProceed: () => void;
  onCancel: () => void;
}

function toStatusClass(column: string): string {
  return `card-status-badge--${column}`;
}

export function DuplicateWarningModal({ matches, onOpen, onProceed, onCancel }: DuplicateWarningModalProps) {
  const { t } = useTranslation("app");
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // FNXC:DuplicateWarning 2026-06-22-02:14: Duplicate warnings must show the task description first so users compare the actual requested work, then fall back to title and an explicit empty-state label.
  const getMatchDisplayText = (match: DuplicateMatch) =>
    match.description.trim() || match.title.trim() || t("duplicateWarning.untitledTask", "No description");

  useEffect(() => {
    cancelButtonRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-overlay open" role="presentation">
      <div className="modal duplicate-warning-modal" role="dialog" aria-modal="true" aria-labelledby="duplicate-warning-modal-title">
        <div className="modal-header">
          <h3 id="duplicate-warning-modal-title">{t("duplicateWarning.title", "Possible duplicates")}</h3>
        </div>
        <div className="duplicate-warning-modal-body">
          <p className="duplicate-warning-modal-copy">{t("duplicateWarning.message", "We found similar active tasks. Open an existing task or create this one anyway.")}</p>
          <div className="duplicate-warning-modal-list">
            {matches.map((match) => (
              <article className="card duplicate-warning-modal-item" key={match.id}>
                <div className="duplicate-warning-modal-item-header">
                  <span className="card-id">{match.id}</span>
                  <span className={`card-status-badge ${toStatusClass(match.column)}`}>{match.column}</span>
                  <span className="duplicate-warning-modal-score">{Math.round(match.score * 100)}%</span>
                </div>
                <div className="card-title duplicate-warning-modal-title">{getMatchDisplayText(match)}</div>
                <div className="duplicate-warning-modal-actions">
                  <button className="btn btn-sm" type="button" onClick={() => onOpen(match.id)}>{t("duplicateWarning.open", "Open")}</button>
                </div>
              </article>
            ))}
          </div>
        </div>
        <div className="modal-actions">
          <div className="modal-actions-left">
            <button className="btn" type="button" ref={cancelButtonRef} onClick={onCancel}>{t("duplicateWarning.cancel", "Cancel")}</button>
          </div>
          <div className="modal-actions-right">
            <button className="btn btn-primary" type="button" onClick={onProceed}>{t("duplicateWarning.createAnyway", "Create anyway")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
