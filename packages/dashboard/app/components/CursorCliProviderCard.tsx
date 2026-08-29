import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { fetchCursorCliStatus, setCursorCliBinaryPath, setCursorCliEnabled, type CursorCliStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./CursorCliProviderCard.css";

interface CursorCliProviderCardProps {
  authenticated: boolean;
  compact?: boolean;
  onToggled?: (nextEnabled: boolean) => void;
}

export function CursorCliProviderCard({ authenticated, compact = false, onToggled }: CursorCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<CursorCliStatus | null>(null);
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
      const next = await fetchCursorCliStatus();
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
        const result = await setCursorCliEnabled(next);
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
      await setCursorCliBinaryPath(trimmedBinaryPath || null);
      if (!mountedRef.current) return;
      pathDirtyRef.current = false;
      const refreshed = await fetchCursorCliStatus();
      if (mountedRef.current) {
        setStatus(refreshed);
        setBinaryPathInput(refreshed.binaryPath ?? "");
        setPathMessage({
          tone: "success",
          text: trimmedBinaryPath
            ? t("setup.cursorCli.pathSaved", "Binary path saved and tested.")
            : t("setup.cursorCli.pathCleared", "Binary path cleared; PATH auto-detection is active."),
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

  /*
  FNXC:CursorCli 2026-07-02-00:00:
  Settings Authentication owns the manual binary override because onboarding should stay a compact enable/test surface. Send the trimmed value as one string so Windows paths with spaces and .cmd/.bat shims are not quoted or split in the browser.
  */
  const binaryPathControl = compact ? (
    <div className="cursor-cli-binary-path-control">
      <label className="cursor-cli-binary-path-label" htmlFor="cursor-cli-binary-path">
        {t("setup.cursorCli.binaryPathLabel", "Cursor CLI binary path")}
      </label>
      <div className="cursor-cli-binary-path-row">
        <input
          id="cursor-cli-binary-path"
          className="cursor-cli-binary-path-input"
          type="text"
          value={binaryPathInput}
          onChange={(event) => handleBinaryPathChange(event.target.value)}
          placeholder={t("setup.cursorCli.binaryPathPlaceholder", "/usr/local/bin/cursor-agent")}
          disabled={busy !== null}
        />
        <button type="button" className="btn btn-sm" onClick={() => void handleSaveBinaryPath()} disabled={busy !== null || !binaryPathChanged}>
          {busy === "saving-path" ? t("setup.cursorCli.savingPath", "Saving…") : t("setup.cursorCli.saveAndTestPath", "Save & Test")}
        </button>
      </div>
      <small className="settings-muted">{t("setup.cursorCli.binaryPathHelp", "Leave blank to use PATH auto-detection (`cursor-agent`, then `cursor`).")}</small>
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
        {busy === "testing" ? <><Loader2 size={12} className="animate-spin" /> {t("setup.cursorCli.testing", "Testing…")}</> : t("setup.cursorCli.test", "Test")}
      </button>
      {currentlyEnabled ? (
        <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
          {busy === "disabling" ? t("setup.cursorCli.disabling", "Disabling…") : t("setup.cursorCli.disable", "Disable")}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => void handleToggle(true)} disabled={busy !== null || !binaryAvailable}>
          {busy === "enabling" ? t("setup.cursorCli.enabling", "Enabling…") : t("setup.cursorCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  const statusText = !status
    ? t("setup.cursorCli.probing", "Probing local CLI…")
    : !status.binary.available
      ? status.binary.reason ?? t("setup.cursorCli.binaryNotFound", "`cursor-agent` not found on PATH")
      : currentlyEnabled
        ? t("setup.cursorCli.connected", "Connected{{version}}", { version: status.binary.version ? ` — ${status.binary.version}` : "" })
        : t("setup.cursorCli.detectedPrompt", "Detected. Click Enable to route calls through Cursor CLI.");

  if (compact) {
    return (
      <div className={`cursor-cli-provider-card auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`} data-testid="cursor-cli-provider-card">
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="cursor-cli" size="sm" />
            <strong>{t("setup.cursorCli.providerName", "Cursor — via Cursor CLI")}</strong>
            <span className={`auth-status-badge ${currentlyEnabled ? "authenticated" : "not-authenticated"}`}>{currentlyEnabled ? t("setup.cursorCli.active", "✓ Active") : t("setup.cursorCli.notConnected", "✗ Not connected")}</span>
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        {/*
        FNXC:CursorCli 2026-07-08-00:00:
        `.auth-provider-card` has no padding of its own (padding:0; overflow:hidden) — only
        `.auth-provider-header` supplies the horizontal inset via `padding: var(--space-sm) var(--space-md)`.
        The status line and binary-path control below the header must be wrapped in a padded body
        so they line up with the header instead of rendering flush against the card edges,
        mirroring `.auth-provider-cli-details-body` on the Claude CLI card. See FN-7695.
        */}
        <div className="cursor-cli-provider-card__body" data-testid="cursor-cli-provider-card-body">
          <small className="settings-muted">{statusText}</small>
          {binaryPathControl}
        </div>
      </div>
    );
  }

  return (
    <div className={`cursor-cli-provider-card onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`} data-testid="cursor-cli-provider-card">
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="cursor-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">{t("setup.cursorCli.providerName", "Cursor — via Cursor CLI")}</strong>
        <span className="onboarding-provider-card__description">{t("setup.cursorCli.description", "Route AI calls through your local Cursor agent runtime.")}</span>
        <small className="settings-muted">{statusText}</small>
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
    </div>
  );
}
