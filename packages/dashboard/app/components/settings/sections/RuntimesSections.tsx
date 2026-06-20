import { HermesRuntimeCard } from "../../HermesRuntimeCard";
import { OpenClawRuntimeCard } from "../../OpenClawRuntimeCard";
import { PaperclipRuntimeCard } from "../../PaperclipRuntimeCard";
import { useTranslation } from "react-i18next";
/*
 * FNXC:i18n-Localization 2026-06-20-00:00:
 * Each exported runtime settings section is mounted independently, so each component owns its own translation hook scope.
 */
export function HermesRuntimeSection() {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.runtimesRuntimes.hermesRuntime", "Hermes Runtime")}</h4>
      <HermesRuntimeCard />
    </>);
}
export function OpenClawRuntimeSection() {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.runtimesRuntimes.openClawRuntime", "OpenClaw Runtime")}</h4>
      <OpenClawRuntimeCard />
    </>);
}
export function PaperclipRuntimeSection() {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.runtimesRuntimes.paperclipRuntime", "Paperclip Runtime")}</h4>
      <PaperclipRuntimeCard />
    </>);
}
