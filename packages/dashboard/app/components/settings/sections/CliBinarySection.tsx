import { useTranslation } from "react-i18next";
import { CliBinaryPanel } from "../../CliBinaryPanel";

/*
FNXC:SettingsNavigation 2026-07-16-01:00:
The `fn` CLI binary panel gets its own advanced-only section at the bottom of the nav instead of sitting at the TOP of "General · Global".
It was the first thing an operator saw when Settings opened — a binary install/version/path panel above the app preferences most people came for. It is machine-level plumbing an operator touches once (or when an install breaks), not a preference, so it belongs behind the Advanced switch with the other specialist surfaces rather than in the default-visible set.
Placed last, in the Advanced group, because "least often needed" is exactly the ordering that group encodes.
*/
export function CliBinarySection() {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.nav.cliBinary", "CLI Binary")}</h4>
      <CliBinaryPanel />
    </>);
}
export default CliBinarySection;
