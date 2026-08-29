import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle, AlertCircle, ExternalLink, RefreshCw, Terminal } from "lucide-react";
import type { DockerProvisionResult } from "@fusion/core";
import "./DockerProvisioningStatus.css";

const STAGE_KEYS = [
  "docker.stage.pullingImage",
  "docker.stage.creatingContainer",
  "docker.stage.startingContainer",
  "docker.stage.registeringNode",
];

const STAGE_INTERVAL_MS = 2000;

export interface DockerProvisioningStatusProps {
  result?: DockerProvisionResult;
  isProvisioning: boolean;
  error?: string | null;
  onRetry?: () => void;
  onViewNode?: (nodeId: string) => void;
}

export function DockerProvisioningStatus({
  result,
  isProvisioning,
  error,
  onRetry,
  onViewNode,
}: DockerProvisioningStatusProps) {
  const { t } = useTranslation("app");
  const [stageIndex, setStageIndex] = useState(0);
  const STAGES = [
    t("docker.stage.pullingImage", "Pulling image..."),
    t("docker.stage.creatingContainer", "Creating container..."),
    t("docker.stage.startingContainer", "Starting container..."),
    t("docker.stage.registeringNode", "Registering node..."),
  ];

  // Animate stages during provisioning
  useEffect(() => {
    if (!isProvisioning || result) {
      return;
    }

    setStageIndex(0);
    const timer = setInterval(() => {
      setStageIndex((prev) => (prev < STAGE_KEYS.length - 1 ? prev + 1 : prev));
    }, STAGE_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isProvisioning, result]);

  // Provisioning state
  if (isProvisioning && !result) {
    return (
      <div className="provisioning-status provisioning-status--loading">
        <div className="provisioning-status__spinner">
          <span className="provisioning-status__dot" />
          <span className="provisioning-status__dot" />
          <span className="provisioning-status__dot" />
        </div>
        <div className="provisioning-status__text">{t("docker.creatingNode", "Creating Docker node...")}</div>
        <div className="provisioning-status__stage">{STAGES[stageIndex]}</div>
      </div>
    );
  }

  // Success state
  if (result?.success) {
    const durationSec = result.durationMs ? (result.durationMs / 1000).toFixed(1) : null;

    return (
      <div className="provisioning-status provisioning-status--success">
        <div className="provisioning-status__icon provisioning-status__icon--success">
          <CheckCircle size={24} />
        </div>
        <div className="provisioning-status__text">{t("docker.successMessage", "Node created successfully!")}</div>
        {result.containerId && (
          <div className="provisioning-status__detail">
            {t("docker.container", "Container:")} <code>{result.containerId.slice(0, 12)}</code>
          </div>
        )}
        {durationSec && (
          <div className="provisioning-status__detail">
            {t("docker.provisionedIn", "Provisioned in {{durationSec}}s", { durationSec })}
          </div>
        )}
        {result.nodeId && onViewNode && (
          <button
            className="btn btn-primary btn-sm"
            onClick={() => onViewNode(result.nodeId!)}
          >
            <ExternalLink size={14} />
            {t("docker.viewNode", "View Node")}
          </button>
        )}
      </div>
    );
  }

  // Failure state
  const displayError = error ?? result?.error;
  const failedStage = result?.failedStage;

  return (
    <div className="provisioning-status provisioning-status--error">
      <div className="provisioning-status__icon provisioning-status__icon--error">
        <AlertCircle size={24} />
      </div>
      <div className="provisioning-status__text">
        {displayError ?? t("docker.failedMessage", "Provisioning failed")}
      </div>
      {failedStage && (
        <div className="provisioning-status__detail">
          {t("docker.failedAt", "Failed at: {{stage}}", { stage: failedStage })}
        </div>
      )}
      {result?.containerName && (
        <div className="provisioning-status__hint">
          <Terminal size={14} />
          <code>docker logs {result.containerName}</code>
        </div>
      )}
      {onRetry && (
        <button className="btn btn-sm" onClick={onRetry}>
          <RefreshCw size={14} />
          {t("docker.retry", "Retry")}
        </button>
      )}
    </div>
  );
}
