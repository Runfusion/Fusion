import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { fetchOmpCliStatus, setOmpCliBinaryPath, setOmpCliEnabled, type OmpCliStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./OmpCliProviderCard.css";

interface OmpCliProviderCardProps {
  authenticated: boolean;
  compact?: boolean;
  onToggled?: (nextEnabled: boolean) => void;
}

/*
FNXC:OmpAcp 2026-07-13-22:50:
Settings → Authentication card for Oh My Pi (omp) ACP. Ready = enabled + binary
available; omp owns auth under ~/.omp. Mirrors GrokCliProviderCard enable/path UX.
*/
export function OmpCliProviderCard({ authenticated, compact = false, onToggled }: OmpCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<OmpCliStatus | null>(null);
  const [busy, setBusy] = useState<"enabling" | "disabling" | "testing" | "saving-path" | null>(null);
  const [binaryPathInput, setBinaryPathInput] = useState("");
  const [pathMessage, setPathMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const pathDirtyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchOmpCliStatus();
      if (mountedRef.current) {
        setStatus(next);
        setBinaryPathInput((current) => (pathDirtyRef.current ? current : (next.binaryPath ?? "")));
        setStatusMessage(null);
      }
      return next;
    } catch (error) {
      if (mountedRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setStatusMessage({
          tone: "error",
          text: message || t("setup.ompCli.probeFailed", "Failed to probe local omp CLI."),
        });
      }
      return null;
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(next ? "enabling" : "disabling");
      setStatusMessage(null);
      try {
        const result = await setOmpCliEnabled(next);
        onToggled?.(result.enabled);
        await refresh();
      } catch (error) {
        if (mountedRef.current) {
          const message = error instanceof Error ? error.message : String(error);
          setStatusMessage({
            tone: "error",
            text: message || t("setup.ompCli.toggleFailed", "Failed to update OMP CLI enable state."),
          });
        }
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [onToggled, refresh, t],
  );

  const currentlyEnabled = status?.enabled ?? authenticated;
  const binaryAvailable = status?.binary.available ?? false;
  const trimmedBinaryPath = binaryPathInput.trim();
  const savedBinaryPath = status?.binaryPath ?? "";
  const binaryPathChanged = trimmedBinaryPath !== savedBinaryPath;

  const handleBinaryPathChange = useCallback((value: string) => {
    setBinaryPathInput(value);
    pathDirtyRef.current = true;
    setPathMessage(null);
  }, []);

  const handleSaveBinaryPath = useCallback(async () => {
    setBusy("saving-path");
    setPathMessage(null);
    try {
      await setOmpCliBinaryPath(trimmedBinaryPath || null);
      if (!mountedRef.current) return;
      pathDirtyRef.current = false;
      const refreshed = await fetchOmpCliStatus();
      if (mountedRef.current) {
        setStatus(refreshed);
        setBinaryPathInput(refreshed.binaryPath ?? "");
        setPathMessage({
          tone: "success",
          text: trimmedBinaryPath
            ? t("setup.ompCli.pathSaved", "Binary path saved and tested.")
            : t("setup.ompCli.pathCleared", "Binary path cleared; PATH auto-detection is active."),
        });
      }
    } catch (error) {
      if (mountedRef.current) {
        const message = error instanceof Error ? error.message : String(error);
        setPathMessage({ tone: "error", text: message });
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [t, trimmedBinaryPath]);

  const binaryPathControl = compact ? (
    <div className="omp-cli-binary-path-control">
      <label className="omp-cli-binary-path-label" htmlFor="omp-cli-binary-path">
        {t("setup.ompCli.binaryPathLabel", "OMP CLI binary path")}
      </label>
      <div className="omp-cli-binary-path-row">
        <input
          id="omp-cli-binary-path"
          className="omp-cli-binary-path-input"
          type="text"
          value={binaryPathInput}
          onChange={(event) => handleBinaryPathChange(event.target.value)}
          placeholder={t("setup.ompCli.binaryPathPlaceholder", "/usr/local/bin/omp")}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-sm" onClick={() => void handleSaveBinaryPath()} disabled={busy !== null || !binaryPathChanged}>
          {busy === "saving-path" ? t("setup.ompCli.savingPath", "Saving…") : t("setup.ompCli.saveAndTestPath", "Save & Test")}
        </button>
      </div>
      <small className="settings-muted">{t("setup.ompCli.binaryPathHelp", "Leave blank to use PATH auto-detection (`omp`).")}</small>
      {pathMessage ? <small className={pathMessage.tone === "error" ? "form-error" : "text-muted"}>{pathMessage.text}</small> : null}
    </div>
  ) : null;

  const actions = (
    <>
      <button type="button" className="btn btn-sm" onClick={() => {
        setBusy("testing");
        void refresh().finally(() => {
          if (mountedRef.current) setBusy(null);
        });
      }} disabled={busy !== null}>
        {busy === "testing" ? <><Loader2 size={12} className="animate-spin" /> {t("setup.ompCli.testing", "Testing…")}</> : t("setup.ompCli.test", "Test")}
      </button>
      {currentlyEnabled ? (
        <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
          {busy === "disabling" ? t("setup.ompCli.disabling", "Disabling…") : t("setup.ompCli.disable", "Disable")}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleToggle(true)} disabled={busy !== null || !binaryAvailable}>
          {busy === "enabling" ? t("setup.ompCli.enabling", "Enabling…") : t("setup.ompCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  const statusText = !status
    ? t("setup.ompCli.probing", "Probing local CLI…")
    : !status.binary.available
      ? status.binary.reason ?? t("setup.ompCli.binaryNotFound", "`omp` not found on PATH")
      : currentlyEnabled
        ? t("setup.ompCli.connected", "Connected{{version}}", { version: status.binary.version ? ` — ${status.binary.version}` : "" })
        : t("setup.ompCli.detectedPrompt", "Detected. Click Enable to route through omp ACP.");

  if (compact) {
    return (
      <div className={`omp-cli-provider-card auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`} data-testid="omp-cli-provider-card">
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="omp-cli" size="sm" />
            <strong>{t("setup.ompCli.providerName", "Oh My Pi — via omp ACP")}</strong>
            <span className={`auth-status-badge ${currentlyEnabled ? "authenticated" : "not-authenticated"}`}>{currentlyEnabled ? t("setup.ompCli.active", "✓ Active") : t("setup.ompCli.notConnected", "✗ Not connected")}</span>
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        <div className="omp-cli-provider-card__body" data-testid="omp-cli-provider-card-body">
          <small className="settings-muted">{statusText}</small>
          {statusMessage ? (
            <small className={statusMessage.tone === "error" ? "form-error" : "text-muted"}>{statusMessage.text}</small>
          ) : null}
          <small className="settings-muted omp-cli-provider-card__hint">
            {t("setup.ompCli.authHint", "Credentials live under ~/.omp (agent auth). Fusion does not store omp API keys.")}
          </small>
          {binaryPathControl}
        </div>
      </div>
    );
  }

  return (
    <div className={`omp-cli-provider-card onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`} data-testid="omp-cli-provider-card">
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="omp-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">{t("setup.ompCli.providerName", "Oh My Pi — via omp ACP")}</strong>
        <span className="onboarding-provider-card__description">{t("setup.ompCli.description", "Drive sessions through your local omp ACP server (`omp acp`).")}</span>
        <small className="settings-muted">{statusText}</small>
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
    </div>
  );
}
