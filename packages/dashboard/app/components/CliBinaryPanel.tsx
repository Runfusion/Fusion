import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fetchFnBinaryStatus,
  installFnBinary,
  type FnBinaryInstallResult,
  type FnBinaryStatus,
} from "../api/legacy";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import "./CliBinaryPanel.css";

interface Props {
  /**
   * When true, the panel is mounted but should not auto-fetch on render.
   * Used by the first-launch banner so it can show a button without
   * forcing a probe before the user opts in.
   */
  defer?: boolean;
}

// Note: These labels are fetched dynamically in the component via useTranslation
// to support i18n. See below for the actual label rendering.

/**
 * Settings panel for the `fn` / `fusion` global CLI binary.
 *
 * Shows current install state, a one-click install button (runs
 * `npm install -g runfusion.ai` server-side), and two copy-to-clipboard
 * commands so users with non-default npm setups can install themselves.
 */
export function CliBinaryPanel({ defer = false }: Props) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<FnBinaryStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installResult, setInstallResult] = useState<FnBinaryInstallResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const getStateLabel = (state: FnBinaryStatus["state"]): { text: string; tone: "ok" | "warn" | "err" } => {
    switch (state) {
      case "installed":
        return { text: t("cliBinary.stateInstalled", "Installed"), tone: "ok" };
      case "missing":
        return { text: t("cliBinary.stateMissing", "Not installed"), tone: "err" };
      case "version-mismatch":
        return { text: t("cliBinary.stateVersionMismatch", "Version mismatch"), tone: "warn" };
      case "skipped":
        return { text: t("cliBinary.stateCheckDisabled", "Check disabled"), tone: "warn" };
    }
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchFnBinaryStatus();
      setStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (defer) return;
    void refresh();
  }, [defer, refresh]);

  const onInstall = useCallback(async () => {
    setInstalling(true);
    setInstallResult(null);
    setError(null);
    try {
      const response = await installFnBinary();
      setStatus({
        binary: response.binary,
        expectedVersion: response.expectedVersion,
        state: response.state,
        install: response.install,
      });
      setInstallResult(response.installResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, []);

  /*
  FNXC:Clipboard 2026-07-12-00:00:
  Direct navigator.clipboard.writeText crashes or mis-reports on non-secure origins such as mobile http://fusionstudio:4040; copyTextToClipboard centralizes the secure-context guard and execCommand fallback.
  */
  const copy = useCallback(async (label: string, value: string) => {
    const copiedToClipboard = await copyTextToClipboard(value);
    if (!copiedToClipboard) return;
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
  }, []);

  const stateMeta = status ? getStateLabel(status.state) : null;

  return (
    <div className="cli-binary-panel">
      <div className="cli-binary-header">
        <h4 className="settings-section-heading">{t("cliBinary.heading", "CLI Binary")}</h4>
        {stateMeta && (
          <span className={`cli-binary-pill cli-binary-pill--${stateMeta.tone}`}>
            {stateMeta.text}
          </span>
        )}
      </div>
      <small className="cli-binary-help">
        {t("cliBinary.help", "Installing the global CLI lets you run fn and fusion from any terminal. Automations and scripts work without it via npx, but a global install is faster and more convenient.")}
      </small>

      {loading && !status && <p className="cli-binary-status-line">{t("cliBinary.checking", "Checking…")}</p>}

      {status && (
        <div className="cli-binary-detail">
          {status.binary.installed ? (
            <ul className="cli-binary-info-list">
              <li>
                <span>{t("cliBinary.binaryLabel", "Binary:")}</span>
                <code>{status.binary.binary}</code>
              </li>
              {status.binary.path && (
                <li>
                  <span>{t("cliBinary.pathLabel", "Path:")}</span>
                  <code>{status.binary.path}</code>
                </li>
              )}
              <li>
                <span>{t("cliBinary.versionLabel", "Version:")}</span>
                <code>{status.binary.version ?? "unknown"}</code>
                <span className="cli-binary-expected">
                  {t("cliBinary.expectedVersion", "(expected {{version}})", { version: status.expectedVersion })}
                </span>
              </li>
            </ul>
          ) : (
            <p className="cli-binary-status-line">
              {t("cliBinary.notOnPath", "Neither fn nor fusion was found on PATH.")}
            </p>
          )}

          <div className="cli-binary-actions">
            <button
              type="button"
              className="cli-binary-install-btn"
              onClick={onInstall}
              disabled={installing}
            >
              {installing
                ? t("cliBinary.installing", "Installing…")
                : status.binary.installed
                  ? t("cliBinary.reinstall", "Reinstall")
                  : t("cliBinary.installWithNpm", "Install with npm")}
            </button>
            <button
              type="button"
              className="cli-binary-refresh-btn"
              onClick={() => void refresh()}
              disabled={loading || installing}
            >
              {t("cliBinary.refresh", "Refresh")}
            </button>
          </div>

          <div className="cli-binary-commands">
            <label>{t("cliBinary.orCopyLabel", "Or copy and run yourself:")}</label>
            {[
              { label: "npm", command: status.install.npm },
              { label: "curl", command: status.install.curl },
            ].map(({ label, command }) => (
              <div key={label} className="cli-binary-command-row">
                <code>{command}</code>
                <button
                  type="button"
                  onClick={() => void copy(label, command)}
                  className="cli-binary-copy-btn"
                >
                  {copied === label ? t("cliBinary.copied", "Copied") : t("cliBinary.copy", "Copy")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {installResult && (
        <details className="cli-binary-install-log" open={!installResult.success}>
          <summary>
            {installResult.success
              ? t("cliBinary.succeededDuration", "Install succeeded in {{duration}}s", { duration: (installResult.durationMs / 1000).toFixed(1) })
              : t("cliBinary.failedExit", "Install failed (exit {{code}})", { code: installResult.exitCode ?? "n/a" })}
          </summary>
          {installResult.permissionsHint && (
            <p className="cli-binary-permissions-hint">{installResult.permissionsHint}</p>
          )}
          {installResult.stdout && (
            <pre className="cli-binary-install-output">{installResult.stdout}</pre>
          )}
          {installResult.stderr && (
            <pre className="cli-binary-install-output cli-binary-install-output--err">
              {installResult.stderr}
            </pre>
          )}
        </details>
      )}

      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
