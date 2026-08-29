import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DockerHostConfig } from "@fusion/core";
import { useDockerTargets } from "../hooks/useDockerTargets";
import { DockerTlsConfig } from "./DockerTlsConfig";
import "./DockerTargetSelector.css";

type TargetMode = "local" | "context" | "host";

interface DockerTargetSelectorProps {
  value?: DockerHostConfig;
  onChange: (config: DockerHostConfig) => void;
  onError?: (error: string) => void;
}

export function DockerTargetSelector({ value, onChange, onError }: DockerTargetSelectorProps) {
  const { t } = useTranslation("app");
  const initialMode: TargetMode = value?.context ? "context" : value?.host ? "host" : "local";
  const [mode, setMode] = useState<TargetMode>(initialMode);
  const [selectedContext, setSelectedContext] = useState(value?.context ?? "");
  const [host, setHost] = useState(value?.host ?? "");
  const [localStatus, setLocalStatus] = useState<string | null>(null);
  const { contexts, isLoadingContexts, contextsError, loadContexts, testConnection, isTestingConnection, lastTestResult, checkLocalDocker, isCheckingLocal } = useDockerTargets();

  const tlsValue = useMemo(
    () => ({
      tlsVerify: value?.tlsVerify,
      tlsCaPath: value?.tlsCaPath,
      tlsCertPath: value?.tlsCertPath,
      tlsKeyPath: value?.tlsKeyPath,
    }),
    [value],
  );

  useEffect(() => {
    if (mode === "local") {
      onChange({});
      return;
    }

    if (mode === "context") {
      void loadContexts().catch((error) => onError?.(error instanceof Error ? error.message : String(error)));
      onChange(selectedContext ? { context: selectedContext } : {});
      return;
    }

    onChange({ host, ...tlsValue });
  }, [mode]);

  const updateTls = useCallback(
    (tls: Pick<DockerHostConfig, "tlsVerify" | "tlsCaPath" | "tlsCertPath" | "tlsKeyPath">) => {
      if (mode !== "host") return;
      onChange({ host, ...tls });
    },
    [host, mode, onChange],
  );

  return (
    <div className="docker-target-selector">
      <div className="docker-target-selector__modes" role="group" aria-label={t("docker.targetMode", "Docker target mode")}>
        <button type="button" className={`btn btn-sm ${mode === "local" ? "docker-target-selector__mode-active" : ""}`} onClick={() => {
          setMode("local");
          void checkLocalDocker()
            .then((result) => {
              if (result.available) {
                const version = result.version ? ` (${result.version})` : "";
                setLocalStatus(t("docker.available", "Docker is available{{version}}", { version }));
              } else {
                const error = result.error ? `: ${result.error}` : "";
                setLocalStatus(t("docker.notFound", "Docker not found{{error}}", { error }));
              }
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              setLocalStatus(t("docker.notFoundError", "Docker not found: {{message}}", { message }));
              onError?.(message);
            });
        }}>{t("docker.local", "Local Docker")}</button>
        <button type="button" className={`btn btn-sm ${mode === "context" ? "docker-target-selector__mode-active" : ""}`} onClick={() => setMode("context")}>{t("docker.context", "Docker Context")}</button>
        <button type="button" className={`btn btn-sm ${mode === "host" ? "docker-target-selector__mode-active" : ""}`} onClick={() => setMode("host")}>{t("docker.remote", "Remote Host")}</button>
      </div>

      {mode === "local" && localStatus && <div className="docker-target-selector__status">{localStatus}</div>}

      {mode === "context" && (
        <div className="docker-target-selector__panel">
          <div className="docker-target-selector__context-row">
            <select className="select" value={selectedContext} onChange={(event) => {
              const next = event.target.value;
              setSelectedContext(next);
              onChange(next ? { context: next } : {});
            }}>
              <option value="">{t("docker.selectContext", "Select context")}</option>
              {contexts.map((context) => (
                <option key={context.name} value={context.name}>{context.name}{context.isCurrentContext ? " (current)" : ""}{context.dockerHost ? ` — ${context.dockerHost}` : ""}</option>
              ))}
            </select>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => void loadContexts()} disabled={isLoadingContexts} aria-label={t("docker.refreshContexts", "Refresh contexts")}><RefreshCw size={14} /></button>
          </div>
          {contextsError && <div className="docker-target-selector__error">{contextsError}</div>}
        </div>
      )}

      {mode === "host" && (
        <div className="docker-target-selector__panel">
          <div className="docker-target-selector__field">
            <label htmlFor="docker-target-selector-host">{t("docker.host", "Docker Host")}</label>
            <input
              id="docker-target-selector-host"
              className="input"
              placeholder={t("docker.hostPlaceholder", "tcp://host:2376")}
              value={host}
              onChange={(event) => {
                const next = event.target.value;
                setHost(next);
                onChange({ host: next, ...tlsValue });
              }}
            />
          </div>
          <DockerTlsConfig value={tlsValue} onChange={updateTls} />
        </div>
      )}

      <button type="button" className="btn btn-sm" onClick={() => void testConnection(mode === "local" ? undefined : mode === "context" ? { context: selectedContext } : { host, ...tlsValue })} disabled={isTestingConnection || isCheckingLocal}>
        {isTestingConnection ? t("docker.testing", "Testing...") : t("docker.testConnection", "Test Connection")}
      </button>

      {lastTestResult && (
        <div className={lastTestResult.success ? "docker-target-selector__success" : "docker-target-selector__error"}>
          {lastTestResult.success
            ? t("docker.connected", "Connected{{version}}", { version: lastTestResult.dockerVersion ? ` (Docker ${lastTestResult.dockerVersion})` : "" })
            : lastTestResult.error ?? t("docker.connectionFailed", "Connection failed")}
        </div>
      )}
    </div>
  );
}
