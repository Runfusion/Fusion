import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchLlamaCppStatus, setLlamaCppEnabled, type LlamaCppStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./LlamaCppProviderCard.css";

interface LlamaCppProviderCardProps {
  authenticated: boolean;
  onToggled?: (nextEnabled: boolean) => void;
  compact?: boolean;
}

export function LlamaCppProviderCard({ authenticated, onToggled, compact = false }: LlamaCppProviderCardProps) {
  const { t } = useTranslation("app");
  const [status, setStatus] = useState<LlamaCppStatus | null>(null);
  const [busy, setBusy] = useState<"enabling" | "disabling" | "testing" | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const next = await fetchLlamaCppStatus();
    if (mountedRef.current) setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = useCallback(async (next: boolean) => {
    setBusy(next ? "enabling" : "disabling");
    try {
      const result = await setLlamaCppEnabled(next);
      onToggled?.(result.enabled);
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [onToggled, refresh]);

  const handleTest = useCallback(async () => {
    setBusy("testing");
    try {
      await refresh();
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [refresh]);

  const enabled = status?.enabled ?? authenticated;
  const serverAvailable = status?.server.available ?? false;

  const statusText = !status
    ? t("providers.llamaCpp.probing", "Probing llama.cpp server…")
    : status.server.available
      ? t("providers.llamaCpp.reachable", "Server reachable at {{url}}", { url: status.server.url })
      : t("providers.llamaCpp.unavailable", "Server unavailable: {{reason}}", { reason: status.server.reason ?? "not reachable" });

  const actions = (
    <div className="auth-provider-cli-actions">
      <button type="button" className="btn btn-sm" onClick={() => void handleTest()} disabled={busy !== null}>
        {busy === "testing" ? <><Loader2 size={12} className="animate-spin" />{t("providers.llamaCpp.testing", "Testing…")}</> : t("providers.llamaCpp.test", "Test")}
      </button>
      {enabled ? (
        <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
          {busy === "disabling" ? t("providers.llamaCpp.disabling", "Disabling…") : t("providers.llamaCpp.disable", "Disable")}
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void handleToggle(true)}
          disabled={busy !== null || !serverAvailable}
        >
          {busy === "enabling" ? t("providers.llamaCpp.enabling", "Enabling…") : t("providers.llamaCpp.enable", "Enable")}
        </button>
      )}
    </div>
  );

  if (compact) {
    return (
      <div
        className={`auth-provider-card auth-provider-card--cli llama-cpp-provider-card llama-cpp-provider-card--compact${enabled ? " auth-provider-card--authenticated" : ""}`}
        data-testid="llama-cpp-provider-card"
      >
        <div className="auth-provider-header">
          <div className="auth-provider-info">
            <ProviderIcon provider="llama-cpp" size="sm" />
            <strong>{t("providers.llamaCpp.title", "llama.cpp — via HTTP server")}</strong>
          </div>
          {actions}
        </div>
        <small className={`auth-hint llama-cpp-status${status?.ready ? " llama-cpp-status--ok" : ""}`}>{statusText}</small>
      </div>
    );
  }

  return (
    <div className="onboarding-provider-card llama-cpp-provider-card llama-cpp-provider-card--full" data-testid="llama-cpp-provider-card">
      <div className="auth-provider-info">
        <ProviderIcon provider="llama-cpp" size="md" />
        <strong>{t("providers.llamaCpp.title", "llama.cpp — via HTTP server")}</strong>
      </div>
      <small className={`llama-cpp-status${status?.ready ? " llama-cpp-status--ok" : ""}`}>{statusText}</small>
      {actions}
    </div>
  );
}
