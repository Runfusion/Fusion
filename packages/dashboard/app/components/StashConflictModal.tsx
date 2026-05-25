import { useEffect, useMemo, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { ApiRequestError, api } from "../api";
import { useFileBrowser } from "../context/FileBrowserContext";
import "./StashConflictModal.css";

interface ResolveResponse {
  remainingConflicts: string[];
}

interface DropResponse {
  dropped: boolean;
}

interface RestoreResponse {
  applied: boolean;
  conflict: boolean;
  conflictedFiles: string[];
}

export interface StashConflictModalProps {
  open: boolean;
  onClose: (stashDropped?: boolean) => void;
  worktreePath: string;
  integrationBranch: string;
  stashSha: string;
  stashLabel: string;
  conflictedFiles: string[];
  autostashOutcome: "conflict-needs-manual" | "failed";
  taskId?: string;
}

function shortSha(sha: string): string {
  return sha.length > 7 ? sha.slice(0, 7) : sha;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    return error.message || "Request failed";
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Request failed";
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selectors = [
    "button",
    "[href]",
    "input",
    "select",
    "textarea",
    '[tabindex]:not([tabindex="-1"])',
  ].join(",");
  return Array.from(container.querySelectorAll<HTMLElement>(selectors)).filter((element) => {
    if (element.hasAttribute("disabled")) {
      return false;
    }
    if (element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    return true;
  });
}

export default function StashConflictModal({
  open,
  onClose,
  worktreePath,
  integrationBranch,
  stashSha,
  stashLabel,
  conflictedFiles,
  autostashOutcome,
  taskId,
}: StashConflictModalProps) {
  const fileBrowser = useFileBrowser();
  const modalRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [remainingConflicts, setRemainingConflicts] = useState<string[]>(autostashOutcome === "failed" ? [] : conflictedFiles);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (open) {
      setRemainingConflicts(autostashOutcome === "failed" ? [] : conflictedFiles);
      setError(null);
      setCopyState("idle");
    }
  }, [autostashOutcome, conflictedFiles, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const modalElement = modalRef.current;
    if (modalElement) {
      const focusable = getFocusableElements(modalElement);
      const preferred = focusable.find((element) => element.getAttribute("aria-label") === "Copy stash reference") ?? focusable[0];
      if (preferred) {
        preferred.focus();
      } else {
        modalElement.focus();
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose(false);
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const container = modalRef.current;
      if (!container) {
        return;
      }

      const focusable = getFocusableElements(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const previous = previousFocusRef.current;
      if (previous && previous.isConnected) {
        previous.focus();
      }
      previousFocusRef.current = null;
    };
  }, [open, onClose]);

  const stashDescriptor = useMemo(() => `Stash ref: ${shortSha(stashSha)} (${stashLabel})`, [stashLabel, stashSha]);

  if (!open) {
    return null;
  }

  const resolveFile = async (file: string, choice: "ours" | "theirs") => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await api<ResolveResponse>("/git/stash-resolve", {
        method: "POST",
        body: JSON.stringify({ worktreePath, stashSha, file, choice, taskId }),
      });
      setRemainingConflicts(Array.isArray(response.remainingConflicts) ? response.remainingConflicts : []);
    } catch (resolveError: unknown) {
      setError(getErrorMessage(resolveError));
    } finally {
      setSubmitting(false);
    }
  };

  const dropStash = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await api<DropResponse>("/git/stash-drop", {
        method: "POST",
        body: JSON.stringify({ worktreePath, stashSha, taskId }),
      });
      if (response.dropped) {
        onClose(true);
      }
    } catch (dropError: unknown) {
      setError(getErrorMessage(dropError));
    } finally {
      setSubmitting(false);
    }
  };

  const restoreStash = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const response = await api<RestoreResponse>("/git/stash-apply", {
        method: "POST",
        body: JSON.stringify({ worktreePath, stashSha, taskId }),
      });
      if (response.conflict) {
        setRemainingConflicts(Array.isArray(response.conflictedFiles) ? response.conflictedFiles : []);
      }
    } catch (restoreError: unknown) {
      setError(getErrorMessage(restoreError));
    } finally {
      setSubmitting(false);
    }
  };

  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(stashSha);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return (
    <div className="modal-overlay open" role="dialog" aria-modal="true" aria-labelledby="stash-conflict-modal-title">
      <div className="modal stash-conflict-modal" ref={modalRef} tabIndex={-1}>
        <div className="modal-header">
          <h3 id="stash-conflict-modal-title">Resolve auto-stash conflicts</h3>
        </div>
        <p className="stash-conflict-modal__summary">
          Pulled <strong>{integrationBranch}</strong>, but restoring local edits from stash produced conflicts.
        </p>
        {autostashOutcome === "failed" ? (
          <p className="stash-conflict-modal__warning">
            Automatic restore failed. Your changes are preserved in the stash above; use <code>git stash apply &lt;ref&gt;</code> to recover manually, or use Retry below.
          </p>
        ) : null}
        <div className="stash-conflict-modal__stash-row">
          <span>{stashDescriptor}</span>
          <button type="button" className="btn btn-sm btn-icon" onClick={copyRef} aria-label="Copy stash reference">
            <Copy aria-hidden="true" />
          </button>
        </div>
        {copyState === "copied" ? <p className="stash-conflict-modal__hint" role="status">Stash SHA copied.</p> : null}
        {copyState === "failed" ? <p className="stash-conflict-modal__error" role="alert">Could not copy stash SHA.</p> : null}
        {remainingConflicts.length > 0 ? (
          <div className="stash-conflict-modal__list" role="list">
            {remainingConflicts.map((file) => (
              <div key={file} className="stash-conflict-row" role="listitem">
                <code className="stash-conflict-row__path">{file}</code>
                <div className="stash-conflict-row__actions">
                  <button type="button" className="btn btn-sm" disabled={submitting} onClick={() => void resolveFile(file, "ours")}>
                    Keep mine
                  </button>
                  <button type="button" className="btn btn-sm" disabled={submitting} onClick={() => void resolveFile(file, "theirs")}>
                    Keep incoming
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={submitting}
                    onClick={() => fileBrowser?.openFile(file, { workspace: worktreePath })}
                  >
                    Open in editor
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {error ? <p className="stash-conflict-modal__error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <div className="modal-actions-left">
            <button type="button" className="btn" disabled={submitting} onClick={() => void restoreStash()}>
              Retry restore
            </button>
          </div>
          <div className="modal-actions-right">
            <button type="button" className="btn" disabled={submitting} onClick={() => onClose(false)}>
              Close
            </button>
            <button type="button" className="btn btn-warning" disabled={submitting || remainingConflicts.length > 0} onClick={() => void dropStash()}>
              Drop stash
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
