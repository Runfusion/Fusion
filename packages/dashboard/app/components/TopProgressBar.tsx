import "./TopProgressBar.css";
import { useTranslation } from "react-i18next";

interface TopProgressBarProps {
  visible: boolean;
}

export function TopProgressBar({ visible }: TopProgressBarProps) {
  const { t } = useTranslation("app");
  return (
    <div
      className="top-progress-bar"
      data-visible={visible ? "true" : "false"}
      role="progressbar"
      aria-busy={visible}
      aria-label={t("common.loading", "Loading")}
    >
      <div className="top-progress-bar__indicator" />
    </div>
  );
}
