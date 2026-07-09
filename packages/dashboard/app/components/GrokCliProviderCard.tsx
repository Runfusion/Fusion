import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { fetchGrokCliStatus, setGrokCliBinaryPath, setGrokCliEnabled, type GrokCliStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./GrokCliProviderCard.css";

interface GrokCliProviderCardProps {
  authenticated: boolean;
  compact?: boolean;
  onToggled?: (nextEnabled: boolean) => void;
}

/*
FNXC:GrokCli 2026-07-08-00:00:
FN-7705: mirrors CursorCliProviderCard.tsx end to end. The one contract
difference is auth messaging — Grok is API-key auth (GROK_API_KEY env var or
~/.grok/user-settings.json apiKey), not OAuth/session, so the
not-authenticated status text references those setting locations instead of
a login flow.
*/
export function GrokCliProviderCard({ authenticated, compact = false, onToggled }: GrokCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<GrokCliStatus | null>(null);
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
      const next = await fetchGrokCliStatus();
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
        const result = await setGrokCliEnabled(next);
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
  const apiKeyPresent = status?.binary.authenticated ?? false;
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
      await setGrokCliBinaryPath(trimmedBinaryPath || null);
      if (!mountedRef.current) return;
      pathDirtyRef.current = false;
      const refreshed = await fetchGrokCliStatus();
      if (mountedRef.current) {
        setStatus(refreshed);
        setBinaryPathInput(refreshed.binaryPath ?? "");
        setPathMessage({
          tone: "success",
          text: trimmedBinaryPath
            ? t("setup.grokCli.pathSaved", "Binary path saved and tested.")
            : t("setup.grokCli.pathCleared", "Binary path cleared; PATH auto-detection is active."),
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
    <div className="grok-cli-binary-path-control">
      <label className="grok-cli-binary-path-label" htmlFor="grok-cli-binary-path">
        {t("setup.grokCli.binaryPathLabel", "Grok CLI binary path")}
      </label>
      <div className="grok-cli-binary-path-row">
        <input
          id="grok-cli-binary-path"
          className="grok-cli-binary-path-input"
          type="text"
          value={binaryPathInput}
          onChange={(event) => handleBinaryPathChange(event.target.value)}
          placeholder={t("setup.grokCli.binaryPathPlaceholder", "/usr/local/bin/grok")}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-sm" onClick={() => void handleSaveBinaryPath()} disabled={busy !== null || !binaryPathChanged}>
          {busy === "saving-path" ? t("setup.grokCli.savingPath", "Saving…") : t("setup.grokCli.saveAndTestPath", "Save & Test")}
        </button>
      </div>
      <small className="settings-muted">{t("setup.grokCli.binaryPathHelp", "Leave blank to use PATH auto-detection (`grok`).")}</small>
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
        {busy === "testing" ? <><Loader2 size={12} className="animate-spin" /> {t("setup.grokCli.testing", "Testing…")}</> : t("setup.grokCli.test", "Test")}
      </button>
      {currentlyEnabled ? (
        <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
          {busy === "disabling" ? t("setup.grokCli.disabling", "Disabling…") : t("setup.grokCli.disable", "Disable")}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleToggle(true)} disabled={busy !== null || !binaryAvailable}>
          {busy === "enabling" ? t("setup.grokCli.enabling", "Enabling…") : t("setup.grokCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  /*
  FNXC:GrokCli 2026-07-08-00:00:
  Grok is API-key auth (no login flow), so a binary-available-but-no-key
  state must guide the operator to GROK_API_KEY / ~/.grok/user-settings.json
  rather than a generic "not connected" message.
  */
  const statusText = !status
    ? t("setup.grokCli.probing", "Probing local CLI…")
    : !status.binary.available
      ? status.binary.reason ?? t("setup.grokCli.binaryNotFound", "`grok` not found on PATH")
      : !apiKeyPresent
        ? t("setup.grokCli.noApiKey", "Binary found, but no API key is configured. Set GROK_API_KEY or ~/.grok/user-settings.json.")
        : currentlyEnabled
          ? t("setup.grokCli.connected", "Connected{{version}}", { version: status.binary.version ? ` — ${status.binary.version}` : "" })
          : t("setup.grokCli.detectedPrompt", "Detected. Click Enable to route calls through Grok CLI.");

  if (compact) {
    return (
      <div className={`grok-cli-provider-card auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`} data-testid="grok-cli-provider-card">
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="grok-cli" size="sm" />
            <strong>{t("setup.grokCli.providerName", "Grok — via Grok CLI")}</strong>
            <span className={`auth-status-badge ${currentlyEnabled ? "authenticated" : "not-authenticated"}`}>{currentlyEnabled ? t("setup.grokCli.active", "✓ Active") : t("setup.grokCli.notConnected", "✗ Not connected")}</span>
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        <div className="grok-cli-provider-card__body" data-testid="grok-cli-provider-card-body">
          <small className="settings-muted">{statusText}</small>
          {binaryPathControl}
        </div>
      </div>
    );
  }

  return (
    <div className={`grok-cli-provider-card onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`} data-testid="grok-cli-provider-card">
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="grok-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">{t("setup.grokCli.providerName", "Grok — via Grok CLI")}</strong>
        <span className="onboarding-provider-card__description">{t("setup.grokCli.description", "Route AI calls through your local Grok CLI runtime.")}</span>
        <small className="settings-muted">{statusText}</small>
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
    </div>
  );
}
