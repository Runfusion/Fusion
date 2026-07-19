import { useTranslation } from "react-i18next";
import { CliBinaryPanel } from "../../CliBinaryPanel";

/*
FNXC:SettingsNavigation 2026-07-16-12:00:
FN-8128 keeps the `fn` CLI binary panel in its own dedicated, default-visible Settings section. It must not be re-inlined at the top of "General · Global", but operators need install, version, path, and diagnostic controls available in Basic mode when setup or repair is needed.
*/
export function CliBinarySection() {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.nav.cliBinary", "CLI Binary")}</h4>
      <CliBinaryPanel />
    </>);
}
export default CliBinarySection;
