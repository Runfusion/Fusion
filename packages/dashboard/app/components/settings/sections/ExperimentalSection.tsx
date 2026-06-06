/**
 * Experimental Features section (U9 / KTD-10).
 *
 * Renders the union of well-known experimental flags (always shown) and any
 * custom flags present in settings, canonicalizing legacy aliases so each
 * feature renders exactly one row. Toggling writes the canonical key and clears
 * its legacy alias. The known-feature catalog and alias helpers live in the
 * shell module and are passed in so this section stays presentational.
 */
import type { ReactNode } from "react";
import type { SectionBaseProps } from "./context";

export interface ExperimentalSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  /** Display labels for well-known features (always rendered). */
  knownFeatures: Record<string, string>;
  /** Map of legacy alias key -> canonical key. */
  legacyAliases: Record<string, string>;
  /** Canonicalize a possibly-legacy feature key. */
  getCanonicalKey: (key: string) => string;
  /** Whether a feature is enabled, honoring legacy aliases. */
  isFeatureEnabled: (features: Record<string, boolean>, key: string) => boolean;
}

export function ExperimentalSection({
  scopeBanner,
  form,
  setForm,
  knownFeatures,
  legacyAliases,
  getCanonicalKey,
  isFeatureEnabled,
}: ExperimentalSectionProps) {
  const experimentalFeatures = form.experimentalFeatures ?? {};
  const allFeatureKeys = Array.from(
    new Set([
      ...Object.keys(knownFeatures),
      ...Object.keys(experimentalFeatures).map(getCanonicalKey),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  const featureFlags = allFeatureKeys.map(
    (key) => [key, isFeatureEnabled(experimentalFeatures, key)] as const,
  );

  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Experimental Features</h4>
      <div className="form-group">
        <small>
          Experimental features are early capabilities that are not yet fully stable.
          Enable them to test new functionality, but be aware they may change or be removed.
        </small>
      </div>

      <div className="form-group">
        <label>Feature Flags</label>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-sm)" }}>
          {featureFlags.map(([key, enabled]) => (
            <label key={key} htmlFor={`experimental-${key}`} className="checkbox-label">
              <input
                id={`experimental-${key}`}
                type="checkbox"
                checked={enabled}
                onChange={(e) => {
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
                }}
              />
              <span>{knownFeatures[key] ?? key}</span>
            </label>
          ))}
        </div>
      </div>
    </>
  );
}

export default ExperimentalSection;
