import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { fetchAuthStatus, type AuthProvider } from "../api";
import { OAUTH_RELOGIN_SUCCESS_EVENT } from "../auth";
import "./OAuthReloginBanner.css";

const DISMISS_STORAGE_KEY = "fusion:oauth-relogin-dismissed";
const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";
const ANTHROPIC_FALLBACK_PROVIDER_IDS = new Set(["anthropic-api-key"]);

type ExpiredBannerProvider = { id: string; name: string };

function isAuthenticatedAnthropicFallback(provider: AuthProvider): boolean {
  return ANTHROPIC_FALLBACK_PROVIDER_IDS.has(provider.id) && provider.authenticated === true;
}

function getVisibleExpiredOAuthProvidersForGlobalBanner(providers: AuthProvider[]): ExpiredBannerProvider[] {
  const hasAuthenticatedAnthropicFallback = providers.some(isAuthenticatedAnthropicFallback);

  return providers
    .filter((provider) => provider.type === "oauth" && provider.expired === true)
    .filter((provider) => {
      /*
      FNXC:ProviderAuth 2026-07-14-15:46:
      An active Anthropic API key can execute direct `anthropic/*` models, but Claude CLI authentication cannot: the execution surfaces intentionally do not reroute. Therefore only a raw API key may suppress the global subscription-expiry banner; a logged-in CLI must not hide the re-auth action while direct-model tasks fail.
      */
      return !(provider.id === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID && hasAuthenticatedAnthropicFallback);
    })
    .map((provider) => ({ id: provider.id, name: provider.name }));
}

function loadDismissedProviderIds(): Set<string> {
  if (typeof window === "undefined") {
    return new Set();
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(DISMISS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return new Set();
  }
}

function persistDismissedProviderIds(providerIds: Set<string>): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify(Array.from(providerIds)));
}

export function OAuthReloginBanner({
  onReLogin,
  pollIntervalMs,
}: {
  onReLogin: (providerId?: string) => void;
  pollIntervalMs?: number;
}): JSX.Element | null {
  const { t } = useTranslation("app");
  const [expiredProviders, setExpiredProviders] = useState<ExpiredBannerProvider[]>([]);
  const [dismissedProviderIds, setDismissedProviderIds] = useState<Set<string>>(() => loadDismissedProviderIds());

  const refreshAuthStatus = useCallback(async () => {
    try {
      const { providers } = await fetchAuthStatus();
      const nextExpiredProviders = getVisibleExpiredOAuthProvidersForGlobalBanner(providers);

      setExpiredProviders(nextExpiredProviders);
    } catch {
      // Non-blocking banner; ignore transient status fetch failures.
    }
  }, []);

  useEffect(() => {
    void refreshAuthStatus();
    const interval = window.setInterval(refreshAuthStatus, pollIntervalMs ?? 60 * 60 * 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [pollIntervalMs, refreshAuthStatus]);

  useEffect(() => {
    const handleOAuthReloginSuccess = (event: Event) => {
      const { detail } = event as CustomEvent<{ providerId?: string }>;
      const providerId = detail?.providerId;
      if (providerId) {
        setExpiredProviders((current) => current.filter((provider) => provider.id !== providerId));
        setDismissedProviderIds((currentDismissed) => {
          if (!currentDismissed.has(providerId)) {
            return currentDismissed;
          }

          /*
          FNXC:ProviderAuth 2026-07-20-12:00:
          FN-8446 — A manual dismissal must survive an expired→refreshed→expired flicker from short-lived OAuth tokens such as GitHub Copilot. Re-arm only this provider after its successful re-login event; polling a healthy status must never prune its browser preference.
          */
          const nextDismissed = new Set(currentDismissed);
          nextDismissed.delete(providerId);
          persistDismissedProviderIds(nextDismissed);
          return nextDismissed;
        });
      }
      void refreshAuthStatus();
    };

    window.addEventListener(OAUTH_RELOGIN_SUCCESS_EVENT, handleOAuthReloginSuccess);
    return () => {
      window.removeEventListener(OAUTH_RELOGIN_SUCCESS_EVENT, handleOAuthReloginSuccess);
    };
  }, [refreshAuthStatus]);

  const visibleExpiredProviders = useMemo(
    () => expiredProviders.filter((provider) => !dismissedProviderIds.has(provider.id)),
    [dismissedProviderIds, expiredProviders],
  );

  if (visibleExpiredProviders.length === 0) {
    return null;
  }

  const isSingleProvider = visibleExpiredProviders.length === 1;
  const providerList = visibleExpiredProviders.map((provider) => provider.name).join(", ");

  const handleDismiss = () => {
    const nextDismissed = new Set(dismissedProviderIds);
    for (const provider of visibleExpiredProviders) {
      nextDismissed.add(provider.id);
    }
    setDismissedProviderIds(nextDismissed);
    persistDismissedProviderIds(nextDismissed);
  };

  return (
    <section className="oauth-relogin-banner" role="status" aria-live="polite">
      <div className="oauth-relogin-banner__content">
        <AlertTriangle aria-hidden="true" />
        <p className="oauth-relogin-banner__message">
          {isSingleProvider
            ? t("auth.reloginRequired", "Re-login required: {{provider}}. Your {{provider}} session expired — sign in again to keep agents running.", { provider: providerList })
            : t("auth.reloginRequiredMultiple", "Re-login required: {{providers}}", { providers: providerList })}
        </p>
      </div>
      <div className="oauth-relogin-banner__actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onReLogin(isSingleProvider ? visibleExpiredProviders[0]?.id : undefined)}
        >
          {t("auth.relogin", "Re-login")}
        </button>
        <button
          type="button"
          className="btn-icon oauth-relogin-banner__dismiss"
          aria-label={t("actions.dismissOAuth", "Dismiss OAuth re-login banner")}
          onClick={handleDismiss}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
