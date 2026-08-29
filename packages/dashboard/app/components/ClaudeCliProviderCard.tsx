import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import {
  fetchClaudeCliStatus,
  setClaudeCliEnabled,
  fetchGlobalSettings,
  updateGlobalSettings,
  type ClaudeCliStatus,
} from "../api";
import { ProviderIcon } from "./ProviderIcon";

/**
 * "Anthropic — via Claude CLI" provider card.
 *
 * Shown alongside the OAuth + API-key provider cards in onboarding and
 * settings. Wraps three actions:
 *
 *   1. **Test** — polls GET /providers/claude-cli/status to re-probe the
 *      claude binary. Surfaces the binary path, version, and any reason
 *      it's unreachable.
 *   2. **Enable / Disable** — POST /auth/claude-cli to flip
 *      GlobalSettings.useClaudeCli. Refused server-side if the binary is
 *      missing. On transition the server fires the same hook PUT
 *      /settings/global fires, so skills get backfilled into every
 *      registered project immediately.
 *   3. **Surface "restart required"** — pi extension registrations can't
 *      be swapped mid-process, so the model-routing change only takes
 *      effect on next Fusion restart. We show that explicitly rather
 *      than letting users wonder why their model picker still shows
 *      non-Anthropic entries right after clicking Enable.
 *
 * The card avoids rendering as "authenticated" on its own — that state
 * comes from the AuthProvider entry in the parent component's list so
 * every consumer (onboarding, settings) shows the same truth.
 */
interface ClaudeCliProviderCardProps {
  /** Authenticated flag from the parent AuthProvider entry. */
  authenticated: boolean;
  /** Optional callback fired after Enable/Disable to let the parent refetch the provider list. */
  onToggled?: (nextEnabled: boolean) => void;
  /** Render a smaller card with the description and status tucked behind a disclosure triangle. */
  compact?: boolean;
}

export function ClaudeCliProviderCard({
  authenticated,
  onToggled,
  compact = false,
}: ClaudeCliProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<ClaudeCliStatus | null>(null);
  const [busy, setBusy] = useState<"enabling" | "disabling" | "testing" | null>(
    null,
  );
  const [lastAction, setLastAction] = useState<
    | { kind: "enabled"; restartRequired: boolean }
    | { kind: "disabled"; restartRequired: boolean }
    | { kind: "error"; message: string }
    | null
  >(null);
  // Guard against state updates after unmount — React complains otherwise.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchClaudeCliStatus();
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

  // Initial probe — cheap, happens once per mount.
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
        const result = await setClaudeCliEnabled(next);
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

  // R17 fallback: the bridge can't authenticate Claude. Turn the ACP transport
  // off (experimentalFeatures.claudeCliAcp=false) so Claude CLI uses `claude -p`.
  const handleFallbackToDashP = useCallback(async () => {
    setBusy("disabling");
    setLastAction(null);
    try {
      const gs = await fetchGlobalSettings();
      await updateGlobalSettings({
        experimentalFeatures: { ...(gs.experimentalFeatures ?? {}), claudeCliAcp: false },
      });
      if (mountedRef.current) {
        setLastAction({ kind: "disabled", restartRequired: false });
      }
      await refresh();
    } catch (err) {
      if (mountedRef.current) {
        setLastAction({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [refresh]);

  const binaryAvailable = status?.binary.available ?? false;
  const currentlyEnabled = status?.enabled ?? authenticated;

  const description = (
    <span className="onboarding-provider-card__description">
      {t("setup.claudeCli.description", "Route AI calls through your locally-installed claude CLI. Uses your existing Claude subscription / quota instead of an API key.")}
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
            {t("setup.claudeCli.testing", "Testing…")}
          </>
        ) : (
          t("setup.claudeCli.test", "Test")
        )}
      </button>
      {currentlyEnabled ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void handleToggle(false)}
          disabled={busy !== null}
        >
          {busy === "disabling" ? t("setup.claudeCli.disabling", "Disabling…") : t("setup.claudeCli.disable", "Disable")}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleToggle(true)}
          disabled={busy !== null || !binaryAvailable}
          title={
            !binaryAvailable
              ? t("setup.claudeCli.binaryNotFound", "`claude` binary not detected on PATH — install Claude CLI first.")
              : undefined
          }
        >
          {busy === "enabling" ? t("setup.claudeCli.enabling", "Enabling…") : t("setup.claudeCli.enable", "Enable")}
        </button>
      )}
    </>
  );

  // Compact layout mirrors `.auth-provider-card` so it slots cleanly into
  // the Settings > Authentication list and picks up the shared mobile rules.
  if (compact) {
    return (
      <div
        className={`auth-provider-card auth-provider-card--cli${authenticated ? " auth-provider-card--authenticated" : ""}`}
        data-testid="claude-cli-provider-card"
      >
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="claude-cli" size="sm" />
            <strong>{t("setup.claudeCli.name", "Anthropic — via Claude CLI")}</strong>
            <ClaudeCliBadge status={status} authenticated={authenticated} />
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        <details className="auth-provider-cli-details">
          <summary>{t("setup.claudeCli.details", "Details")}</summary>
          <div className="auth-provider-cli-details-body">
            {description}
            <ClaudeCliStatusLine status={status} authenticated={authenticated} />
            {lastAction && <ClaudeCliActionToast action={lastAction} />}
          </div>
        </details>
      </div>
    );
  }

  return (
    <div
      className={`onboarding-provider-card${authenticated ? " onboarding-provider-card--connected" : ""}`}
      data-testid="claude-cli-provider-card"
    >
      <div className="onboarding-provider-card__icon">
        <ProviderIcon provider="claude-cli" size="md" />
      </div>
      <div className="onboarding-provider-card__body">
        <strong className="onboarding-provider-card__name">
          {t("setup.claudeCli.name", "Anthropic — via Claude CLI")}
        </strong>
        {description}
        <ClaudeCliStatusLine status={status} authenticated={authenticated} />
        {status?.acp?.authFailed && (
          <div
            className="onboarding-provider-card__alert"
            role="alert"
            data-testid="claude-cli-acp-auth-banner"
          >
            <strong>
              {t("setup.claudeCli.acpAuthFailedTitle", "Claude CLI bridge can't authenticate")}
            </strong>
            <p>
              {status.acp.authReason ??
                t(
                  "setup.claudeCli.acpAuthFailed",
                  "The ACP bridge reached a Claude session that isn't logged in. Fall back to `claude -p`, or fix authentication and re-test.",
                )}
            </p>
            <div className="onboarding-provider-card__actions">
              <button type="button" onClick={handleFallbackToDashP} disabled={busy !== null}>
                {busy === "disabling" && <Loader2 className="animate-spin" size={14} />}
                {t("setup.claudeCli.useDashP", "Use claude -p")}
              </button>
              <button type="button" onClick={handleTest} disabled={busy !== null}>
                {t("setup.claudeCli.recheckAuth", "I fixed auth — re-test")}
              </button>
            </div>
            <p className="onboarding-provider-card__hint">
              {t(
                "setup.claudeCli.fixAuthHint",
                "To fix: run `claude` in a terminal and complete login, then re-test.",
              )}
            </p>
          </div>
        )}
      </div>
      <div className="onboarding-provider-card__actions">{actions}</div>
      {lastAction && <ClaudeCliActionToast action={lastAction} />}
    </div>
  );
}

function ClaudeCliBadge({
  status,
  authenticated,
}: {
  status: ClaudeCliStatus | null;
  authenticated: boolean;
}) {
  const { t } = useTranslation("app");
  const enabled = status?.enabled ?? authenticated;
  const available = status?.binary.available ?? false;
  if (enabled) {
    return <span className="auth-status-badge authenticated">{t("setup.claudeCli.active", "✓ Active")}</span>;
  }
  if (!available && status) {
    return <span className="auth-status-badge not-authenticated">{t("setup.claudeCli.notInstalled", "✗ Not installed")}</span>;
  }
  return <span className="auth-status-badge not-authenticated">{t("setup.claudeCli.notConnected", "✗ Not connected")}</span>;
}

/**
 * One-line health summary. Renders different text for "binary missing"
 * vs "binary ok but disabled" vs "fully ready" so the user can quickly
 * see why the provider is or isn't working.
 */
function ClaudeCliStatusLine({
  status,
  authenticated,
}: {
  status: ClaudeCliStatus | null;
  authenticated: boolean;
}) {
  const { t } = useTranslation("app");
  if (!status) {
    return (
      <small className="settings-muted">
        <Loader2 size={10} className="animate-spin" /> {t("setup.claudeCli.probing", "Probing local CLI…")}
      </small>
    );
  }
  const { binary, enabled, extension, ready } = status;
  if (!binary.available) {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--error">
        ✗ {binary.reason ?? t("setup.claudeCli.binaryNotFoundPath", "`claude` not found on PATH")}
      </small>
    );
  }
  if (!enabled) {
    return (
      <small className="settings-muted">
        <code>claude</code> {binary.version ? `(${binary.version})` : ""} {t("setup.claudeCli.detectedPrompt", "detected{{path}}. Click Enable to route AI calls through it.", { path: binary.binaryPath ? ` at ${binary.binaryPath}` : "" })}
      </small>
    );
  }
  if (extension && extension.status !== "ok") {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--warning">
        ⚠ {t("setup.claudeCli.extensionFailed", "Extension load failed: {{reason}}", { reason: extension.reason ?? extension.status })}
      </small>
    );
  }
  if (ready || authenticated) {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--connected">
        {t("setup.claudeCli.connected", "✓ Connected{{version}}", { version: binary.version ? ` — ${binary.version}` : "" })}
      </small>
    );
  }
  // Enabled but `ready` is false and we have no specific reason — usually a
  // transient state after flipping the toggle before the first probe
  // completes.
  return <small className="settings-muted">{t("setup.claudeCli.validating", "Enabled. Validating…")}</small>;
}

function ClaudeCliActionToast({
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
  const verb = action.kind === "enabled" ? t("setup.claudeCli.enabledVerb", "Enabled") : t("setup.claudeCli.disabledVerb", "Disabled");
  return (
    <p className="onboarding-helper-text">
      {verb}.{" "}
      {action.kind === "enabled"
        ? t("setup.claudeCli.enabledMessage", "Claude-CLI-routed models are now visible in the model picker.")
        : t("setup.claudeCli.disabledMessage", "Claude-CLI-routed models are hidden from the model picker.")}
    </p>
  );
}
