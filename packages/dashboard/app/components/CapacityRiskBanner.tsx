import type { CapacityRiskSignal } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { Banner } from "./Banner";
import "./CapacityRiskBanner.css";

interface CapacityRiskBannerProps { signal: CapacityRiskSignal | null; onDismiss?: () => void; }

export function CapacityRiskBanner({ signal, onDismiss }: CapacityRiskBannerProps) {
  const { t } = useTranslation("app");
  if (!signal || !signal.atRisk) return null;

  return (
    <Banner
      className={`capacity-risk-banner${onDismiss ? " capacity-risk-banner--dismissible" : ""}`}
      tone="warning"
      role="status"
      aria-live="polite"
      onDismiss={onDismiss}
      dismissLabel={t("capacity.dismiss", "Dismiss capacity warning")}
    >
      <span className="capacity-risk-banner__content">
        <strong>{t("capacity.risk", "Capacity risk:")}</strong>{" "}
        {t("capacity.status", "Todo {{todoCount}} (threshold {{threshold}}) · In Progress {{inProgress}} · In Review {{inReview}} · Idle agents {{idleAgents}}", { todoCount: signal.todoCount, threshold: signal.threshold, inProgress: signal.inProgressCount, inReview: signal.inReviewCount, idleAgents: signal.idleNonEphemeralAgentCount })}
      </span>
    </Banner>
  );
}
