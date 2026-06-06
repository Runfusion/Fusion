/**
 * Plugins section (U9 / KTD-10).
 *
 * Project-scoped plugin manager with the Fusion-plugins / Pi-extensions subsection
 * tab pair. The active-subsection state lives in the shell (its initial value is
 * derived from the modal's entry section) and is relayed as props. The lazy
 * managers and the plugin slot are co-located here. Markup, ARIA wiring, and the
 * lazy-load Suspense boundaries are preserved verbatim from the original inline
 * JSX.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { PluginSlot } from "../../PluginSlot";
import type { ToastType } from "../../../hooks/useToast";

const PluginManager = lazy(() => import("../../PluginManager").then((m) => ({ default: m.PluginManager })));
const PiExtensionsManager = lazy(() => import("../../PiExtensionsManager").then((m) => ({ default: m.PiExtensionsManager })));

export type PluginsSubsectionId = "fusion-plugins" | "pi-extensions";

export interface PluginsSectionProps {
  scopeBanner: ReactNode;
  projectId?: string;
  addToast: (message: string, type?: ToastType) => void;
  activePluginsSubsection: PluginsSubsectionId;
  setActivePluginsSubsection: (id: PluginsSubsectionId) => void;
}

export function PluginsSection({
  scopeBanner,
  projectId,
  addToast,
  activePluginsSubsection,
  setActivePluginsSubsection,
}: PluginsSectionProps) {
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Plugins</h4>
      <div className="settings-plugins-subsection-toggle" role="tablist" aria-label="Plugin manager type">
        <button
          type="button"
          id="plugins-tab-fusion-plugins"
          role="tab"
          aria-controls="plugins-panel-fusion-plugins"
          aria-selected={activePluginsSubsection === "fusion-plugins"}
          tabIndex={activePluginsSubsection === "fusion-plugins" ? 0 : -1}
          className={`settings-plugins-subsection-btn${activePluginsSubsection === "fusion-plugins" ? " active" : ""}`}
          onClick={() => setActivePluginsSubsection("fusion-plugins")}
        >
          Fusion Plugins
        </button>
        <button
          type="button"
          id="plugins-tab-pi-extensions"
          role="tab"
          aria-controls="plugins-panel-pi-extensions"
          aria-selected={activePluginsSubsection === "pi-extensions"}
          tabIndex={activePluginsSubsection === "pi-extensions" ? 0 : -1}
          className={`settings-plugins-subsection-btn${activePluginsSubsection === "pi-extensions" ? " active" : ""}`}
          onClick={() => setActivePluginsSubsection("pi-extensions")}
        >
          Pi Extensions
        </button>
      </div>
      <div
        id="plugins-panel-fusion-plugins"
        role="tabpanel"
        aria-labelledby="plugins-tab-fusion-plugins"
        className="settings-plugins-subsection-panel"
        hidden={activePluginsSubsection !== "fusion-plugins"}
      >
        {activePluginsSubsection === "fusion-plugins" && (
          <>
            <Suspense fallback={null}>
              <PluginManager addToast={addToast} projectId={projectId} />
            </Suspense>
            <PluginSlot slotId="settings-section" projectId={projectId} />
          </>
        )}
      </div>
      <div
        id="plugins-panel-pi-extensions"
        role="tabpanel"
        aria-labelledby="plugins-tab-pi-extensions"
        className="settings-plugins-subsection-panel"
        hidden={activePluginsSubsection !== "pi-extensions"}
      >
        {activePluginsSubsection === "pi-extensions" && (
          <Suspense fallback={null}>
            <PiExtensionsManager addToast={addToast} projectId={projectId} />
          </Suspense>
        )}
      </div>
    </>
  );
}

export default PluginsSection;
