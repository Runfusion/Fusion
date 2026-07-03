import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import {
  fetchFnBinaryStatus,
  installFnBinary,
  type FnBinaryStatus,
} from "../api/legacy";
import "./CliBinaryInstallBanner.css";

interface Props {
  /** Open Settings → General so the user can manage manually. */
  onOpenSettings: () => void;
}

/** localStorage key for permanent dismissal. */
const DISMISS_KEY = "fusion:cli-binary-banner-dismissed";

/*
 * FNXC:CliBanner 2026-07-03-09:25:
 * Delay the CLI-install nudge so it does not clutter the first-run experience. We stamp the first time
 * the banner becomes eligible (binary missing / version-mismatch) and suppress it until a grace period
 * elapses. The Settings → General → CLI Binary panel still installs on demand in the meantime, so this
 * only defers the passive nudge — it never hides the capability. Re-evaluated on each launch, so once
 * the grace period passes the banner appears on a later run rather than immediately after onboarding.
 */
const FIRST_SEEN_KEY = "fusion:cli-binary-banner-first-seen";
const SHOW_DELAY_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function persistDismissal(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Ignore quota / private-mode errors — dismissal lasts the session only.
  }
}

/** Returns the ms timestamp the banner first became eligible, or null if never stamped. */
function readFirstSeen(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(FIRST_SEEN_KEY);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Records the first-eligible timestamp once; later calls are no-ops so the grace window is stable. */
function stampFirstSeen(now: number): void {
  if (typeof window === "undefined") return;
  try {
    if (!window.localStorage.getItem(FIRST_SEEN_KEY)) {
      window.localStorage.setItem(FIRST_SEEN_KEY, String(now));
    }
  } catch {
    // Ignore quota / private-mode errors — without a stamp the banner simply stays deferred.
  }
}

/** The banner is eligible to show only for a missing / mismatched binary that isn't opt-out-skipped. */
function bannerEligible(status: FnBinaryStatus | null): boolean {
  if (!status) return false;
  if (status.state === "installed") return false;
  if (status.state === "skipped") return false;
  return true;
}

/**
 * One-time banner that nudges users to install the global `fn`/`fusion`
 * CLI binary. Renders only when:
 *
 *   - Status probe completes successfully
 *   - The binary is not on PATH
 *   - User has not previously dismissed the banner
 *
 * Dismissal is permanent (localStorage). The Settings → General → CLI
 * Binary panel always lets the user reinstall later.
 */
export function CliBinaryInstallBanner({ onOpenSettings }: Props) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<FnBinaryStatus | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => isDismissed());
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  useEffect(() => {
    if (dismissed) return;
    let cancelled = false;
    void fetchFnBinaryStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        // Start the grace window the first time the banner would otherwise be eligible.
        if (bannerEligible(next)) stampFirstSeen(Date.now());
      })
      .catch(() => {
        // Treat probe failure as "don't show banner" — better silent than
        // bothering the user with infrastructure errors on first load.
      });
    return () => {
      cancelled = true;
    };
  }, [dismissed]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const response = await installFnBinary();
      setStatus({
        binary: response.binary,
        expectedVersion: response.expectedVersion,
        state: response.state,
        install: response.install,
      });
      if (!response.installResult.success) {
        setInstallError(
          response.installResult.permissionsHint ||
            response.installResult.stderr ||
            `Install failed (exit ${response.installResult.exitCode ?? "n/a"})`,
        );
      }
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    persistDismissal();
    setDismissed(true);
  }, []);

  if (dismissed) return null;
  if (!status) return null;
  if (status.state === "installed") return null;
  // Honour the global `fnBinaryCheckEnabled` opt-out — when checks are
  // disabled the install banner would be misleading.
  if (status.state === "skipped") return null;

  // FNXC:CliBanner 2026-07-03-09:25: defer the nudge until the grace period after first eligibility.
  const firstSeen = readFirstSeen();
  if (firstSeen === null || Date.now() - firstSeen < SHOW_DELAY_MS) return null;

  const isMismatch = status.state === "version-mismatch";
  const installedVersion = status.binary.version;
  const targetVersion = status.expectedVersion;
  const title = isMismatch ? t("cli.updateTitle", "Update the Fusion CLI") : t("cli.installTitle", "Install the Fusion CLI");
  const body = isMismatch ? (
    <>
      {t("cli.versionMismatchPrefix", "Your installed")} <code>fn</code>/<code>fusion</code> CLI is{" "}
      <strong>v{installedVersion ?? "unknown"}</strong> {t("cli.versionMismatchInfix", "but this dashboard expects")} {" "}
      <strong>v{targetVersion}</strong>. {t("cli.versionMismatchSuffix", "Update to stay in sync.")}
    </>
  ) : (
    <>
      {t("cli.installBody", "Get the {{fn}} and {{fusion}} commands on your terminal so you can drive Fusion from anywhere. One click below or copy the command into your shell.", { fn: "fn", fusion: "fusion" })}
    </>
  );
  const idleLabel = isMismatch ? t("cli.updateButton", "Update with npm") : t("cli.installButton", "Install with npm");
  const busyLabel = isMismatch ? t("cli.updating", "Updating…") : t("cli.installing", "Installing…");

  return (
    <div className="cli-binary-banner" role="status">
      <div className="cli-binary-banner__body">
        <div className="cli-binary-banner__title">{title}</div>
        <div className="cli-binary-banner__text">{body}</div>
        <div className="cli-binary-banner__actions">
          <button
            type="button"
            className="cli-binary-banner__primary"
            onClick={() => void handleInstall()}
            disabled={installing}
          >
            {installing ? busyLabel : idleLabel}
          </button>
          <button
            type="button"
            className="cli-binary-banner__secondary"
            onClick={onOpenSettings}
          >
            {t("cli.openSettings", "Open Settings")}
          </button>
        </div>
        {installError && (
          <div className="cli-binary-banner__error">{installError}</div>
        )}
      </div>
      <button
        type="button"
        className="cli-binary-banner__dismiss"
        aria-label={t("actions.dismiss", "Dismiss")}
        onClick={handleDismiss}
      >
        <X size={16} />
      </button>
    </div>
  );
}
