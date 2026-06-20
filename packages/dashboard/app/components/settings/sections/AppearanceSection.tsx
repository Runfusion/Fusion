import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ThemeMode, ColorTheme } from "@fusion/core";
import { ThemeSelector } from "../../ThemeSelector";
import { LanguageSelector } from "../../LanguageSelector";
import type { SectionBaseProps } from "./context";
export interface AppearanceSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    themeMode: ThemeMode;
    colorTheme: ColorTheme;
    dashboardFontScalePct: number;
    onThemeModeChange?: (mode: ThemeMode) => void;
    onColorThemeChange?: (theme: ColorTheme) => void;
    onDashboardFontScaleChange?: (scalePct: number) => void;
    sessionBannersHidden: boolean;
    setSessionBannersHidden: (hidden: boolean) => void;
}
export function AppearanceSection({ scopeBanner, setForm, themeMode, colorTheme, dashboardFontScalePct, onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, sessionBannersHidden, setSessionBannersHidden, }: AppearanceSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.appearance.title", "Appearance")}</h4>
      <ThemeSelector themeMode={themeMode} colorTheme={colorTheme} dashboardFontScalePct={dashboardFontScalePct} onThemeModeChange={(mode) => {
            setForm((f) => ({ ...f, themeMode: mode }));
            onThemeModeChange?.(mode);
        }} onColorThemeChange={(theme) => {
            setForm((f) => ({ ...f, colorTheme: theme }));
            onColorThemeChange?.(theme);
        }} onDashboardFontScaleChange={(scalePct) => {
            setForm((f) => ({ ...f, dashboardFontScalePct: scalePct }));
            onDashboardFontScaleChange?.(scalePct);
        }}/>
      <LanguageSelector />
      <div className="form-group">
        <label className="checkbox-label">
          <input type="checkbox" checked={sessionBannersHidden} onChange={(e) => setSessionBannersHidden(e.target.checked)}/>
          <span>{t("settings.appearance.hideAISessionNotificationBanners", "Hide AI session notification banners")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.suppressTheLdquoNeedsYourInputRdquoBanner", " Suppress the &ldquo;needs your input&rdquo; banner that appears when AI sessions are awaiting input or have failed. ")}</small>
      </div>
    </>);
}
export default AppearanceSection;
