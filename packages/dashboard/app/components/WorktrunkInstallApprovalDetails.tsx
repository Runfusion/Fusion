import "./WorktrunkInstallApprovalDetails.css";
import { useTranslation } from "react-i18next";
import type { ApprovalRequestDetail } from "../api";

interface WorktrunkInstallApprovalDetailsProps {
  targetAction: ApprovalRequestDetail["targetAction"];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readAsset(context: Record<string, unknown> | undefined): { url: string | null; sha256: string | null } {
  if (!context) return { url: null, sha256: null };
  const assets = context.assets;
  if (!assets || typeof assets !== "object") return { url: null, sha256: null };
  const firstAsset = Object.values(assets as Record<string, unknown>)[0];
  if (!firstAsset || typeof firstAsset !== "object") return { url: null, sha256: null };
  const asset = firstAsset as Record<string, unknown>;
  return {
    url: readString(asset.url),
    sha256: readString(asset.sha256),
  };
}

export function WorktrunkInstallApprovalDetails({ targetAction }: WorktrunkInstallApprovalDetailsProps) {
  const { t } = useTranslation("app");
  const context = targetAction.context as Record<string, unknown> | undefined;
  const version = readString(context?.version);
  const installPath = readString(context?.installPath) ?? targetAction.resourceId;
  const { url, sha256 } = readAsset(context);

  return (
    <section className="card worktrunk-install-approval-details" data-testid="worktrunk-install-approval-details">
      <h4 className="worktrunk-install-approval-details__title">{t("worktrunk.installRequestTitle", "Worktrunk install request")}</h4>
      <dl className="worktrunk-install-approval-details__list">
        <div className="worktrunk-install-approval-details__row">
          <dt>{t("worktrunk.version", "Version")}</dt>
          <dd>{version ?? t("common.unknown", "Unknown")}</dd>
        </div>
        <div className="worktrunk-install-approval-details__row">
          <dt>{t("worktrunk.assetUrl", "Asset URL")}</dt>
          <dd>{url ?? t("common.unknown", "Unknown")}</dd>
        </div>
        <div className="worktrunk-install-approval-details__row">
          <dt>{t("worktrunk.sha256", "SHA-256")}</dt>
          <dd>{sha256 ?? t("common.unknown", "Unknown")}</dd>
        </div>
        <div className="worktrunk-install-approval-details__row">
          <dt>{t("worktrunk.installPath", "Install path")}</dt>
          <dd>{installPath ?? t("common.unknown", "Unknown")}</dd>
        </div>
      </dl>
    </section>
  );
}
