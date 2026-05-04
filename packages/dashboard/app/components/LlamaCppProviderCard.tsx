import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { fetchLlamaCppStatus, setLlamaCppEnabled, type LlamaCppStatus } from "../api";
import { ProviderIcon } from "./ProviderIcon";
import "./LlamaCppProviderCard.css";

interface LlamaCppProviderCardProps {
  authenticated: boolean;
  onToggled?: (nextEnabled: boolean) => void;
  compact?: boolean;
}

export function LlamaCppProviderCard({ authenticated, onToggled, compact = false }: LlamaCppProviderCardProps) {
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

  const content = (
    <>
      <div className="auth-provider-info">
        <ProviderIcon provider="llama-cpp" size={compact ? "sm" : "md"} />
        <strong>llama.cpp — via HTTP server</strong>
      </div>
      <small className={`llama-cpp-status${status?.ready ? " llama-cpp-status--ok" : ""}`}>
        {!status
          ? "Probing llama.cpp server…"
          : status.server.available
            ? `Server reachable at ${status.server.url}`
            : `Server unavailable: ${status.server.reason ?? "not reachable"}`}
      </small>
      <div className="auth-provider-cli-actions">
        <button type="button" className="btn btn-sm" onClick={() => void handleTest()} disabled={busy !== null}>
          {busy === "testing" ? <><Loader2 size={12} className="animate-spin" />Testing…</> : "Test"}
        </button>
        {enabled ? (
          <button type="button" className="btn btn-sm" onClick={() => void handleToggle(false)} disabled={busy !== null}>
            {busy === "disabling" ? "Disabling…" : "Disable"}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleToggle(true)}
            disabled={busy !== null || !serverAvailable}
          >
            {busy === "enabling" ? "Enabling…" : "Enable"}
          </button>
        )}
      </div>
    </>
  );

  if (compact) {
    return <div className="auth-provider-card auth-provider-card--cli llama-cpp-provider-card" data-testid="llama-cpp-provider-card">{content}</div>;
  }

  return <div className="onboarding-provider-card llama-cpp-provider-card" data-testid="llama-cpp-provider-card">{content}</div>;
}
