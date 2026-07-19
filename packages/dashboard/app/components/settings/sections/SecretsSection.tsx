/**
 * Secrets section (U9 / KTD-10).
 *
 * Thin Project-group wrapper around the self-contained SecretsView card. Carries
 * no modal form state — the shell owns persistence; this section only titles and
 * mounts the relocated card (mirrors the RuntimesSections convention).
 */
import { useTranslation } from "react-i18next";
import { SecretsView } from "../../SecretsView";
import type { ToastType } from "../../../hooks/useToast";

export interface SecretsSectionProps {
  addToast: (message: string, type?: ToastType) => void;
}

export function SecretsSection({ addToast }: SecretsSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      <h4 className="settings-section-heading">{t("settings.nav.secrets", "Secrets")}</h4>
      <SecretsView addToast={addToast} />
    </>
  );
}

export default SecretsSection;
