import "./AuthTokenRecoveryDialog.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearAuthToken, setAuthToken } from "../auth";

export interface AuthTokenRecoveryDialogProps {
  open: boolean;
}

export function AuthTokenRecoveryDialog({ open }: AuthTokenRecoveryDialogProps) {
  const [tokenInput, setTokenInput] = useState("");
  const tokenInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    tokenInputRef.current?.focus();
  }, [open]);

  const handleSetToken = useCallback(() => {
    const token = tokenInput.trim();
    if (!token) return;

    setAuthToken(token);
    window.location.reload();
  }, [tokenInput]);

  const handleClearAndRetry = useCallback(() => {
    clearAuthToken();
    window.location.reload();
  }, []);

  if (!open) {
    return null;
  }

  return (
    <div
      className="modal-overlay open auth-token-recovery-overlay"
      role="presentation"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <div
        className="modal auth-token-recovery-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-token-recovery-title"
        aria-describedby="auth-token-recovery-description"
      >
        <div className="modal-header auth-token-recovery-header">
          <h2 id="auth-token-recovery-title">Authentication token required</h2>
        </div>

        <div className="auth-token-recovery-content">
          <p id="auth-token-recovery-description">
            This dashboard session can&apos;t authenticate with the daemon. Set a replacement token or clear the
            current token and retry.
          </p>

          <div className="auth-token-recovery-field">
            <label htmlFor="auth-token-recovery-input">Replacement token</label>
            <input
              ref={tokenInputRef}
              id="auth-token-recovery-input"
              className="input"
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder="Paste token"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        <div className="modal-actions auth-token-recovery-actions">
          <button
            type="button"
            className="btn"
            onClick={handleClearAndRetry}
          >
            Clear token and retry
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSetToken}
            disabled={tokenInput.trim().length === 0}
          >
            Set token and reload
          </button>
        </div>
      </div>
    </div>
  );
}
