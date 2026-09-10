import "./AuthTokenRecoveryPage.css";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { clearAuthToken, setAuthToken } from "../auth";

export interface AuthTokenRecoveryPageProps {
  open: boolean;
}

/*
FNXC:AuthTokenRecovery 2026-09-10-21:28:
Daemon authentication recovery is a blocking full-screen page, not a dialog layered over the dashboard. The replacement-token button and Enter key must share the native form submission path so both trim, persist, and reload identically while blank values remain inert.
*/
export function AuthTokenRecoveryPage({ open }: AuthTokenRecoveryPageProps) {
  const { t } = useTranslation("app");
  const [tokenInput, setTokenInput] = useState("");
  const tokenInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    tokenInputRef.current?.focus();
  }, [open]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    <main
      className="auth-token-recovery-page"
      aria-labelledby="auth-token-recovery-title"
      aria-describedby="auth-token-recovery-description"
    >
      <div className="auth-token-recovery-page__content">
        <header className="auth-token-recovery-page__header">
          <h1 id="auth-token-recovery-title">{t("auth.tokenRequired", "Authentication token required")}</h1>
          <p id="auth-token-recovery-description">
            {t("auth.tokenRecoveryDescription", "This dashboard session can't authenticate with the daemon. Set a replacement token or clear the current token and retry.")}
          </p>
        </header>

        <form className="auth-token-recovery-page__form" onSubmit={handleSubmit}>
          <div className="auth-token-recovery-page__field">
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

          <div className="auth-token-recovery-page__actions">
            <button type="button" className="btn" onClick={handleClearAndRetry}>
              {t("auth.clearAndRetry", "Clear token and retry")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={tokenInput.trim().length === 0}>
              {t("auth.setAndReload", "Set token and reload")}
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
