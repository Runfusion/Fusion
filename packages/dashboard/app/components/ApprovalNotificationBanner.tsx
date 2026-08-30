import { AlertTriangle, Inbox, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Banner } from "./Banner";
import "./ApprovalNotificationBanner.css";

interface ApprovalNotificationBannerProps {
  pendingCount: number;
  onOpenMailbox: () => void;
  onDismiss: () => void;
}

export function ApprovalNotificationBanner({
  pendingCount,
  onOpenMailbox,
  onDismiss,
}: ApprovalNotificationBannerProps) {
  const { t } = useTranslation("app");
  const noun = pendingCount === 1 ? t("approval.requestSingular", "request") : t("approval.requestPlural", "requests");

  return (
    <Banner as="section" className="approval-notification-banner" tone="warning" layout="chrome" role="region" aria-live="polite" aria-label={t("approval.requests", "Approval requests")}>
      <div className="approval-notification-banner__content">
        <div className="approval-notification-banner__headline">
          <span className="status-dot" aria-hidden="true" />
          <AlertTriangle aria-hidden="true" />
          <span>{t("approval.needAttention", "{{count}} approval {{noun}} need your attention", { count: pendingCount, noun })}</span>
        </div>
        <div className="approval-notification-banner__actions">
          <button type="button" className="btn btn-sm" onClick={onOpenMailbox}>
            <Inbox aria-hidden="true" />
            <span>{t("approval.openMailbox", "Open Mailbox")}</span>
          </button>
          <button type="button" className="btn-icon approval-notification-banner__dismiss" onClick={onDismiss} aria-label={t("approval.dismissBanner", "Dismiss approval notification banner")}>
            <X aria-hidden="true" />
          </button>
        </div>
      </div>
    </Banner>
  );
}
