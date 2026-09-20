import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { fetchAntigravityCliStatus, setAntigravityCliBinaryPath, setAntigravityCliEnabled, type AntigravityCliStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./AntigravityCliProviderCard.css";

interface AntigravityCliProviderCardProps {
  authenticated: boolean;
  compact?: boolean;
  onToggled?: (nextEnabled: boolean) => void;
}

/*
FNXC:AntigravityProvider 2026-09-20-18:32:
The vendor-owned agy login is not read by Fusion. A detected binary may be
configured first; later authentication failures are bounded by the runtime.
*/
export function AntigravityCliProviderCard({ authenticated, compact = false, onToggled }: AntigravityCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<AntigravityCliStatus | null>(null);
  const [busy, setBusy] = useState<"enabling" | "disabling" | "testing" | "saving-path" | null>(null);
  const [binaryPathInput, setBinaryPathInput] = useState("");
  const [pathMessage, setPathMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
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
      const next = await fetchAntigravityCliStatus();
      if (mountedRef.current) {
        setStatus(next);
        setBinaryPathInput((current) => (pathDirtyRef.current ? current : (next.binaryPath ?? "")));
      }
      return next;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(next ? "enabling" : "disabling");
      try {
        const result = await setAntigravityCliEnabled(next);
        onToggled?.(result.enabled);
        await refresh();
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [onToggled, refresh],
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
      await setAntigravityCliBinaryPath(trimmedBinaryPath || null);
      if (!mountedRef.current) return;
      pathDirtyRef.current = false;
      const refreshed = await fetchAntigravityCliStatus();
      if (mountedRef.current) {
        setStatus(refreshed);
        setBinaryPathInput(refreshed.binaryPath ?? "");
        setPathMessage({
          tone: "success",
          text: trimmedBinaryPath
            ? t("setup.antigravityCli.pathSaved", "Binary path saved and tested.")
            : t("setup.antigravityCli.pathCleared", "Binary path cleared; PATH auto-detection is active."),
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
    <div className="antigravity-cli-binary-path-control">
      <label className="antigravity-cli-binary-path-label" htmlFor="antigravity-cli-binary-path">
        {t("setup.antigravityCli.binaryPathLabel", "Antigravity CLI binary path")}
      </label>
      <div className="antigravity-cli-binary-path-row">
        <input
          id="antigravity-cli-binary-path"
          className="antigravity-cli-binary-path-input"
          type="text"
          value={binaryPathInput}
          onChange={(event) => handleBinaryPathChange(event.target.value)}
          placeholder={t("setup.antigravityCli.binaryPathPlaceholder", "/usr/local/bin/agy")}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-sm" onClick={() => void handleSaveBinaryPath()} disabled={busy !== null || !binaryPathChanged}>
          {busy === "saving-path" ? t("setup.antigravityCli.savingPath", "Saving…") : t("setup.antigravityCli.saveAndTestPath", "Save & Test")}
        </button>
      </div>
      <small className="settings-muted">{t("setup.antigravityCli.binaryPathHelp", "Leave blank to use PATH auto-detection (`agy`).")}</small>
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
        {busy === "testing" ? <><Loader2 size={12} className="animate-spin" /> {t("setup.antigravityCli.testing", "Testing…")}</> : t("setup.antigravityCli.test", "Test")}
      </button>
      {currentlyEnabled ? (
        <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
          {busy === "disabling" ? t("setup.antigravityCli.disabling", "Disabling…") : t("setup.antigravityCli.disable", "Disable")}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleToggle(true)} disabled={busy !== null || !binaryAvailable}>
          {busy === "enabling" ? t("setup.antigravityCli.enabling", "Enabling…") : t("setup.antigravityCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  const statusText = !status
    ? t("setup.antigravityCli.probing", "Probing local CLI…")
    : !status.binary.available
      ? status.binary.reason ?? t("setup.antigravityCli.binaryNotFound", "`agy` not found on PATH")
      : currentlyEnabled
        ? t("setup.antigravityCli.connected", "Connected{{version}}", { version: status.binary.version ? ` — ${status.binary.version}` : "" })
        : t("setup.antigravityCli.detectedPrompt", "Detected. Click Enable to route calls through Antigravity CLI.");


  if (compact) {
    return (
      <div className={`antigravity-cli-provider-card auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`} data-testid="antigravity-cli-provider-card">
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="antigravity-cli" size="sm" />
            <strong>{t("setup.antigravityCli.providerName", "Google Antigravity — via agy CLI")}</strong>
            <span className={`auth-status-badge ${currentlyEnabled ? "authenticated" : "not-authenticated"}`}>{currentlyEnabled ? t("setup.antigravityCli.active", "✓ Active") : t("setup.antigravityCli.notConnected", "✗ Not connected")}</span>
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        <div className="antigravity-cli-provider-card__body" data-testid="antigravity-cli-provider-card-body">
          <small className="settings-muted">{statusText}</small>
          {binaryPathControl}
        </div>
      </div>
    );
  }

  return (
    <div className={`antigravity-cli-provider-card onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`} data-testid="antigravity-cli-provider-card">
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="antigravity-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">{t("setup.antigravityCli.providerName", "Google Antigravity — via agy CLI")}</strong>
        <span className="onboarding-provider-card__description">{t("setup.antigravityCli.description", "Route AI calls through your local Antigravity CLI runtime.")}</span>
        <small className="settings-muted">{statusText}</small>
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
    </div>
  );
}
