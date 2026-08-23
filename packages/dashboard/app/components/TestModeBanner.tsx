import { useTranslation } from "react-i18next";
import { FlaskConical } from "lucide-react";
import { Banner } from "./Banner";
import "./TestModeBanner.css";

interface TestModeBannerProps {
  isActive: boolean;
}

export function TestModeBanner({ isActive }: TestModeBannerProps) {
  const { t } = useTranslation("app");
  if (!isActive) return null;

  return (
    <Banner className="test-mode-banner" tone="warning" icon={<FlaskConical aria-hidden="true" />} role="status" aria-live="polite">
      {t("app.testMode", "Test mode — no real AI calls")}
    </Banner>
  );
}
