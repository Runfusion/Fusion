import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  fetchDroidCliStatus,
  setDroidCliEnabled,
  type DroidCliStatus,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./DroidCliProviderCard.css";

interface DroidCliProviderCardProps {
  authenticated: boolean;
  onToggled?: (nextEnabled: boolean) => void;
  compact?: boolean;
}

export function DroidCliProviderCard({
  authenticated,
  onToggled,
  compact = false,
}: DroidCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<DroidCliStatus | null>(null);
  const [busy, setBusy] = useState<"enabling" | "disabling" | "testing" | null>(
    null,
  );
  const [lastAction, setLastAction] = useState<
    | { kind: "enabled"; restartRequired: boolean }
    | { kind: "disabled"; restartRequired: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchDroidCliStatus();
      if (mountedRef.current) setStatus(next);
      return next;
    } catch (err) {
      if (mountedRef.current) {
        setLastAction({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleTest = useCallback(async () => {
    setBusy("testing");
    setLastAction(null);
    await refresh();
    if (mountedRef.current) setBusy(null);
  }, [refresh]);

  const handleToggle = useCallback(
    async (next: boolean) => {
      setBusy(next ? "enabling" : "disabling");
      setLastAction(null);
      try {
        const result = await setDroidCliEnabled(next);
        if (mountedRef.current) {
          setLastAction({
            kind: result.enabled ? "enabled" : "disabled",
            restartRequired: result.restartRequired,
          });
        }
        onToggled?.(result.enabled);
        await refresh();
      } catch (err) {
        if (mountedRef.current) {
          setLastAction({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (mountedRef.current) setBusy(null);
      }
    },
    [onToggled, refresh],
  );

  const binaryAvailable = status?.binary.available ?? false;
  const currentlyEnabled = status?.enabled ?? authenticated;

  const description = (
    <span className="onboarding-provider-card__description">
      {t("droidCli.description", "Route AI calls through your locally-installed droid CLI. Uses your existing Factory AI subscription / quota instead of an API key.")}
    </span>
  );

  const actions = (
    <>
      <button
        type="button"
        className="btn btn-sm"
        onClick={handleTest}
        disabled={busy !== null}
      >
        {busy === "testing" ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            {t("droidCli.testing", "Testing…")}
          </>
        ) : (
          t("droidCli.test", "Test")
        )}
      </button>
      {currentlyEnabled ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void handleToggle(false)}
          disabled={busy !== null}
        >
          {busy === "disabling" ? t("droidCli.disabling", "Disabling…") : t("droidCli.disable", "Disable")}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleToggle(true)}
          disabled={busy !== null || !binaryAvailable}
          title={
            !binaryAvailable
              ? t("droidCli.notOnPath", "droid binary not detected on PATH — install Droid CLI first.")
              : undefined
          }
        >
          {busy === "enabling" ? t("droidCli.enabling", "Enabling…") : t("droidCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  if (compact) {
    return (
      <div
        className={`auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`}
        data-testid="droid-cli-provider-card"
      >
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="droid-cli" size="sm" />
            <strong>{t("droidCli.cardTitle", "Factory AI — via Droid CLI")}</strong>
            <DroidCliBadge status={status} authenticated={authenticated} />
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        <details className="auth-provider-cli-details">
          <summary>{t("droidCli.details", "Details")}</summary>
          <div className="auth-provider-cli-details-body">
            {description}
            <DroidCliStatusLine status={status} authenticated={authenticated} />
            {lastAction && <DroidCliActionToast action={lastAction} />}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div
      className={`onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`}
      data-testid="droid-cli-provider-card"
    >
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="droid-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">{t("droidCli.cardTitle", "Factory AI — via Droid CLI")}</strong>
        {description}
        <DroidCliStatusLine status={status} authenticated={authenticated} />
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
      {lastAction && <DroidCliActionToast action={lastAction} />}
    </div>
  );
}

function DroidCliBadge({
  status,
  authenticated,
}: {
  status: DroidCliStatus | null;
  authenticated: boolean;
}) {
  const { t } = useTranslation("app");
  const enabled = status?.enabled ?? authenticated;
  const available = status?.binary.available ?? false;
  if (enabled) return <span className="auth-status-badge authenticated">✓ {t("droidCli.active", "Active")}</span>;
  if (!available && status) {
    return <span className="auth-status-badge not-authenticated">✗ {t("droidCli.notInstalled", "Not installed")}</span>;
  }
  return <span className="auth-status-badge not-authenticated">✗ {t("droidCli.notConnected", "Not connected")}</span>;
}

function DroidCliStatusLine({
  status,
  authenticated,
}: {
  status: DroidCliStatus | null;
  authenticated: boolean;
}) {
  const { t } = useTranslation("app");
  if (!status) {
    return (
      <small className="settings-muted">
        <Loader2 size={10} className="animate-spin" /> {t("droidCli.probingCli", "Probing local CLI…")}
      </small>
    );
  }

  const { binary, enabled, extension, ready } = status;
  if (!binary.available) {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--error">
        ✗ {binary.reason ?? t("droidCli.droidNotFound", "droid not found on PATH")}
      </small>
    );
  }

  if (!enabled) {
    return (
      <small className="settings-muted">
        {t("droidCli.detected", "droid {{version}} detected{{path}}. Click Enable to route AI calls through it.", {
          version: binary.version ? `(${binary.version})` : "",
          path: binary.binaryPath ? ` at ${binary.binaryPath}` : ""
        })}
      </small>
    );
  }

  if (extension && extension.status !== "ok") {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--warning">
        ⚠ {t("droidCli.extensionFailed", "Extension load failed: {{reason}}", { reason: extension.reason ?? extension.status })}
      </small>
    );
  }

  if (ready || authenticated) {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--connected">
        ✓ {t("droidCli.connectedVersion", "Connected{{version}}", { version: binary.version ? ` — ${binary.version}` : "" })}
      </small>
    );
  }

  return <small className="settings-muted">{t("droidCli.enabledValidating", "Enabled. Validating…")}</small>;
}

function DroidCliActionToast({
  action,
}: {
  action:
    | { kind: "enabled"; restartRequired: boolean }
    | { kind: "disabled"; restartRequired: boolean }
    | { kind: "error"; message: string };
}) {
  const { t } = useTranslation("app");
  if (action.kind === "error") {
    return (
      <p className="onboarding-helper-text onboarding-helper-text--error">
        {action.message}
      </p>
    );
  }
  const verb = action.kind === "enabled" ? t("droidCli.toastEnabled", "Enabled") : t("droidCli.toastDisabled", "Disabled");
  return (
    <p className="onboarding-helper-text">
      {verb}.{" "}
      {action.kind === "enabled"
        ? t("droidCli.modelsNowVisible", "Factory AI (via Droid CLI) models are now visible in the model picker.")
        : t("droidCli.modelsHidden", "Factory AI (via Droid CLI) models are hidden from the model picker.")}
      {action.restartRequired
        ? " " + t("droidCli.restartRequired", "Restart required: restart your active CLI/chat session for routing changes to take effect.")
        : ""}
    </p>
  );
}
