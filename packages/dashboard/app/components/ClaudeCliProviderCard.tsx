import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  fetchClaudeCliStatus,
  setClaudeCliEnabled,
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

  const binaryAvailable = status?.binary.available ?? false;
  const currentlyEnabled = status?.enabled ?? authenticated;

  const description = (
    <span className="onboarding-provider-card__description">
      Route AI calls through your locally-installed <code>claude</code> CLI.
      Uses your existing Claude subscription / quota instead of an API key.
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
            Testing…
          </>
        ) : (
          "Test"
        )}
      </button>
      {currentlyEnabled ? (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => void handleToggle(false)}
          disabled={busy !== null}
        >
          {busy === "disabling" ? "Disabling…" : "Disable"}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleToggle(true)}
          disabled={busy !== null || !binaryAvailable}
          title={
            !binaryAvailable
              ? "`claude` binary not detected on PATH — install Claude CLI first."
              : undefined
          }
        >
          {busy === "enabling" ? "Enabling…" : "Enable"}
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
            <strong>Anthropic — via Claude CLI</strong>
            <ClaudeCliBadge status={status} authenticated={authenticated} />
          </div>
          <div className="auth-provider-cli-actions">{actions}</div>
        </div>
        <details className="auth-provider-cli-details">
          <summary>Details</summary>
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
          Anthropic — via Claude CLI
        </strong>
        {description}
        <ClaudeCliStatusLine status={status} authenticated={authenticated} />
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
  const enabled = status?.enabled ?? authenticated;
  const available = status?.binary.available ?? false;
  if (enabled) {
    return <span className="auth-status-badge authenticated">✓ Active</span>;
  }
  if (!available && status) {
    return <span className="auth-status-badge not-authenticated">✗ Not installed</span>;
  }
  return <span className="auth-status-badge not-authenticated">✗ Not connected</span>;
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
  if (!status) {
    return (
      <small className="settings-muted">
        <Loader2 size={10} className="animate-spin" /> Probing local CLI…
      </small>
    );
  }
  const { binary, enabled, extension, ready } = status;
  if (!binary.available) {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--error">
        ✗ {binary.reason ?? "`claude` not found on PATH"}
      </small>
    );
  }
  if (!enabled) {
    return (
      <small className="settings-muted">
        <code>claude</code> {binary.version ? `(${binary.version})` : ""} detected
        {binary.binaryPath ? ` at ${binary.binaryPath}` : ""}. Click Enable to
        route AI calls through it.
      </small>
    );
  }
  if (extension && extension.status !== "ok") {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--warning">
        ⚠ Extension load failed: {extension.reason ?? extension.status}
      </small>
    );
  }
  if (ready || authenticated) {
    return (
      <small className="onboarding-provider-card__status onboarding-provider-card__status--connected">
        ✓ Connected{binary.version ? ` — ${binary.version}` : ""}
      </small>
    );
  }
  return (
    <small className="settings-muted">
      Enabled. Restart Fusion to complete activation.
    </small>
  );
}

function ClaudeCliActionToast({
  action,
}: {
  action:
    | { kind: "enabled"; restartRequired: boolean }
    | { kind: "disabled"; restartRequired: boolean }
    | { kind: "error"; message: string };
}) {
  if (action.kind === "error") {
    return (
      <p className="onboarding-helper-text onboarding-helper-text--error">
        {action.message}
      </p>
    );
  }
  const verb = action.kind === "enabled" ? "Enabled" : "Disabled";
  return (
    <p className="onboarding-helper-text">
      {verb}.{" "}
      {action.restartRequired
        ? "Restart Fusion to activate the routing change."
        : "No further action needed."}
    </p>
  );
}
