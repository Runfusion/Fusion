import { lazy, Suspense, type ReactNode } from "react";
import { PluginSlot } from "../../PluginSlot";
import type { ToastType } from "../../../hooks/useToast";
import { useTranslation } from "react-i18next";
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
export function PluginsSection({ scopeBanner, projectId, addToast, activePluginsSubsection, setActivePluginsSubsection, }: PluginsSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.plugins.plugins", "Plugins")}</h4>
      <div className="settings-plugins-subsection-toggle" role="tablist" aria-label={t("settings.plugins.pluginManagerType", "Plugin manager type")}>
        <button type="button" id="plugins-tab-fusion-plugins" role="tab" aria-controls="plugins-panel-fusion-plugins" aria-selected={activePluginsSubsection === "fusion-plugins"} tabIndex={activePluginsSubsection === "fusion-plugins" ? 0 : -1} className={`settings-plugins-subsection-btn${activePluginsSubsection === "fusion-plugins" ? " active" : ""}`} onClick={() => setActivePluginsSubsection("fusion-plugins")}>{t("settings.plugins.fusionPlugins", " Fusion Plugins ")}</button>
        <button type="button" id="plugins-tab-pi-extensions" role="tab" aria-controls="plugins-panel-pi-extensions" aria-selected={activePluginsSubsection === "pi-extensions"} tabIndex={activePluginsSubsection === "pi-extensions" ? 0 : -1} className={`settings-plugins-subsection-btn${activePluginsSubsection === "pi-extensions" ? " active" : ""}`} onClick={() => setActivePluginsSubsection("pi-extensions")}>{t("settings.plugins.piExtensions", " Pi Extensions ")}</button>
      </div>
      <div id="plugins-panel-fusion-plugins" role="tabpanel" aria-labelledby="plugins-tab-fusion-plugins" className="settings-plugins-subsection-panel" hidden={activePluginsSubsection !== "fusion-plugins"}>
        {activePluginsSubsection === "fusion-plugins" && (<>
            <Suspense fallback={null}>
              <PluginManager addToast={addToast} projectId={projectId}/>
            </Suspense>
            <PluginSlot slotId="settings-section" projectId={projectId}/>
          </>)}
      </div>
      <div id="plugins-panel-pi-extensions" role="tabpanel" aria-labelledby="plugins-tab-pi-extensions" className="settings-plugins-subsection-panel" hidden={activePluginsSubsection !== "pi-extensions"}>
        {activePluginsSubsection === "pi-extensions" && (<Suspense fallback={null}>
            <PiExtensionsManager addToast={addToast} projectId={projectId}/>
          </Suspense>)}
      </div>
    </>);
}
export default PluginsSection;
