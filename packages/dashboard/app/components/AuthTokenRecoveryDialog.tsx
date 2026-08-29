import "./AuthTokenRecoveryDialog.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { clearAuthToken, setAuthToken } from "../auth";

export interface AuthTokenRecoveryDialogProps {
  open: boolean;
}

export function AuthTokenRecoveryDialog({ open }: AuthTokenRecoveryDialogProps) {
  const { t } = useTranslation("app");
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
        className="modal modal-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-token-recovery-title"
        aria-describedby="auth-token-recovery-description"
      >
        <div className="modal-header auth-token-recovery-header">
          <h3 id="auth-token-recovery-title">{t("auth.tokenRequired", "Authentication token required")}</h3>
        </div>

        <div className="auth-token-recovery-content">
          <p id="auth-token-recovery-description">
            {t("auth.tokenRecoveryDescription", "This dashboard session can't authenticate with the daemon. Set a replacement token or clear the current token and retry.")}
          </p>

          <div className="auth-token-recovery-field">
            <label htmlFor="auth-token-recovery-input">{t("auth.replacementToken", "Replacement token")}</label>
            <input
              ref={tokenInputRef}
              id="auth-token-recovery-input"
              className="input"
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              placeholder={t("auth.pasteToken", "Paste token")}
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
            {t("auth.clearAndRetry", "Clear token and retry")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSetToken}
            disabled={tokenInput.trim().length === 0}
          >
            {t("auth.setAndReload", "Set token and reload")}
          </button>
        </div>
      </div>
    </div>
  );
}
