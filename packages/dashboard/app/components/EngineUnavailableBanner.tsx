import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import "./EngineUnavailableBanner.css";

interface EngineUnavailableBannerProps {
  isVisible: boolean;
}

export function EngineUnavailableBanner({ isVisible }: EngineUnavailableBannerProps) {
  const { t } = useTranslation("app");
  if (!isVisible) {
    return null;
  }

  /*
   * FNXC:EngineAvailability 2026-06-20-22:11:
   * When the dashboard is served without an in-process AI engine, users need an explicit operational banner with the exact restart command because task execution, review, and merge automation cannot run from a UI-only process.
   */
  return (
    <section className="engine-unavailable-banner" role="status" aria-live="polite">
      <AlertTriangle className="engine-unavailable-banner__icon" aria-hidden="true" />
      <div className="engine-unavailable-banner__copy">
        <h2 className="engine-unavailable-banner__title">{t("engineUnavailable.title", "AI engine is not running")}</h2>
        <p className="engine-unavailable-banner__body">
          <Trans
            i18nKey="app:engineUnavailable.body"
            defaults="This dashboard can display project data, but task automation will not run until you restart Fusion with the engine. Stop this server and run <sourceCmd>pnpm local</sourceCmd> from a source checkout, or <cliCmd>fn dashboard</cliCmd> from an installed CLI."
            components={{
              sourceCmd: <code />,
              cliCmd: <code />,
            }}
          />
        </p>
      </div>
    </section>
  );
}
