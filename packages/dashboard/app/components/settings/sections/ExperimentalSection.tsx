import type { SectionBaseProps } from "./context";
import { useTranslation } from "react-i18next";
import { SettingsHelpTip } from "../SettingsHelpTip";
export interface ExperimentalSectionProps extends SectionBaseProps {
    /** Display labels for well-known features (always rendered). */
    knownFeatures: Record<string, string>;
    /** Map of legacy alias key -> canonical key. */
    legacyAliases: Record<string, string>;
    /** Canonicalize a possibly-legacy feature key. */
    getCanonicalKey: (key: string) => string;
    /** Whether a feature is enabled, honoring legacy aliases. */
    isFeatureEnabled: (features: Record<string, boolean>, key: string) => boolean;
    /** Feature keys that are supported internally but should not render as user toggles. */
    hiddenFeatureKeys?: ReadonlySet<string>;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
The flag list deliberately stays hand-rolled rather than moving to the shared settings row primitives. A primitive row is addressed by a real settings field name, which doubles as its element id and its search anchor; these rows are sub-keys of the single `experimentalFeatures` record, discovered at runtime from `knownFeatures` plus whatever the stored blob already contains, and labelled from that prop rather than from a fixed `t()` key. There is no stable field name or i18n key to give a descriptor, so the flags are not searchable per-flag and must not pretend to be — the nav's section-level `searchableText` is what finds them.
*/
export function ExperimentalSection({ form, setForm, knownFeatures, legacyAliases, getCanonicalKey, isFeatureEnabled, hiddenFeatureKeys, }: ExperimentalSectionProps) {
    const { t } = useTranslation("app");
    const experimentalFeatures = form.experimentalFeatures ?? {};
    const allFeatureKeys = Array.from(new Set([
        ...Object.keys(knownFeatures),
        ...Object.keys(experimentalFeatures).map(getCanonicalKey),
    ])).filter((key) => !hiddenFeatureKeys?.has(key)).sort((a, b) => a.localeCompare(b));
    const featureFlags = allFeatureKeys.map((key) => [key, isFeatureEnabled(experimentalFeatures, key)] as const);
    return (<>
      {/*
      FNXC:SettingsHelp 2026-07-16-12:45:
      Section intro moved behind the shared "?" beside the heading - operator requirement: no inline description paragraphs in Settings.
      */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading">{t("settings.experimental.experimentalFeatures", "Experimental Features")}</h4>
        <SettingsHelpTip settingKey="experimental-section">{t("settings.experimental.experimentalFeaturesAreEarlyCapabilitiesThatAreNot", " Experimental features are early capabilities that are not yet fully stable. Enable them to test new functionality, but be aware they may change or be removed. Default: disabled for every feature flag below. ")}</SettingsHelpTip>
      </div>

      <div className="form-group">
        <label>{t("settings.experimental.featureFlags", "Feature Flags")}</label>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          {featureFlags.map(([key, enabled]) => (<label key={key} htmlFor={`experimental-${key}`} className="checkbox-label">
              <input id={`experimental-${key}`} type="checkbox" checked={enabled} onChange={(e) => {
                setForm((f) => {
                    const nextExperimentalFeatures = {
                        ...(f.experimentalFeatures ?? {}),
                        [key]: e.target.checked,
                    };
                    for (const [legacyKey, canonicalKey] of Object.entries(legacyAliases)) {
                        if (canonicalKey === key) {
                            delete nextExperimentalFeatures[legacyKey];
                        }
                    }
                    return {
                        ...f,
                        experimentalFeatures: nextExperimentalFeatures,
                    };
                });
            }}/>
              <span>{knownFeatures[key] ?? key}</span>
            </label>))}
        </div>
      </div>
    </>);
}
export default ExperimentalSection;
