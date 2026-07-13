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
    shadcnCustomColors?: Record<string, string>;
    resolvedThemeMode?: "dark" | "light";
    onThemeModeChange?: (mode: ThemeMode) => void;
    onColorThemeChange?: (theme: ColorTheme) => void;
    onDashboardFontScaleChange?: (scalePct: number) => void;
    onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
    sessionBannersHidden: boolean;
    setSessionBannersHidden: (hidden: boolean) => void;
}
export function AppearanceSection({ scopeBanner, form, setForm, themeMode, colorTheme, dashboardFontScalePct, shadcnCustomColors = {}, resolvedThemeMode, onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, onShadcnCustomColorsChange, sessionBannersHidden, setSessionBannersHidden, }: AppearanceSectionProps) {
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
        }} shadcnCustomColors={shadcnCustomColors} resolvedThemeMode={resolvedThemeMode} onShadcnCustomColorsChange={(colors) => {
            setForm((f) => ({ ...f, shadcnCustomColors: colors }));
            onShadcnCustomColorsChange?.(colors);
        }}/>
      <LanguageSelector />
      <div className="form-group">
        <label className="checkbox-label">
          <input type="checkbox" checked={form.openTasksInRightSidebar === true} onChange={(e) => setForm((f) => ({ ...f, openTasksInRightSidebar: e.target.checked }))}/>
          <span>{t("settings.appearance.openTasksInRightSidebar", "Open tasks in the right sidebar")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.openTasksInRightSidebarHelp", "When enabled, board task cards open detail in the right sidebar when it is available; mobile and hidden-sidebar states keep the full task panel. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        {/* FNXC:MobileTaskPopups 2026-07-13-00:00 (FN-7945): Keep the stored openMobileTasksInPopup key for compatibility, but present the setting as all-viewport ordinary task popup routing because desktop operators also need the board, List view, or right-dock Tasks list visible behind task detail. */}
        <label className="checkbox-label">
          <input type="checkbox" checked={form.openMobileTasksInPopup === true} onChange={(e) => setForm((f) => ({ ...f, openMobileTasksInPopup: e.target.checked }))}/>
          <span>{t("settings.appearance.openMobileTasksInPopup", "Open tasks as popups")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.openMobileTasksInPopupHelp", "When enabled, ordinary board task-card, List row/card, and right-dock Tasks-list clicks open the existing movable task popup so the board or list remains visible. Deep-tab and other task opens keep their current behavior. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        {/* FNXC:TaskPopupViewGating 2026-07-13-00:00: This project-scoped setting is opt-in because existing task popups float globally by default. When enabled, each popup stays attached to the Board/List view where it was opened, hiding on other views without closing or clearing geometry. */}
        <label className="checkbox-label">
          <input type="checkbox" checked={form.taskPopupsBoardListOnly === true} onChange={(e) => setForm((f) => ({ ...f, taskPopupsBoardListOnly: e.target.checked }))}/>
          <span>{t("settings.appearance.taskPopupsBoardListOnly", "Keep task popups on their Board/List view")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.taskPopupsBoardListOnlyHelp", "When enabled, each open task-detail popup appears only on the Board or List view where it was opened. Switching to another view hides it without closing; returning to that view restores it in the same position. Default: disabled.")}</small>
      </div>
      <div className="form-group">
        {/* FNXC:TaskCardCostBadge 2026-07-11-12:15: This project setting is opt-in because board cards are already dense; when enabled, only tasks with recorded positive token usage render a read-time derived spend badge. */}
        <label className="checkbox-label">
          <input type="checkbox" checked={form.showCostBadgeOnCards === true} onChange={(e) => setForm((f) => ({ ...f, showCostBadgeOnCards: e.target.checked }))}/>
          <span>{t("settings.appearance.showCostBadgeOnCards", "Show cost badges on task cards")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.showCostBadgeOnCardsHelp", "Default: disabled. When enabled, board cards show derived model cost next to execution time; unavailable pricing displays — and tasks without token usage show no badge.")}</small>
      </div>
      <div className="form-group">
        {/* FNXC:TaskDetailActivityFirst 2026-06-30-23:59: The project setting is opt-in because task details now default to Activity-first; explicit Activity/Chat/Logs links keep their destination regardless of this checkbox. */}
        <label className="checkbox-label">
          <input id="taskDetailChatFirst" type="checkbox" checked={form.taskDetailChatFirst === true} onChange={(e) => setForm((f) => ({ ...f, taskDetailChatFirst: e.target.checked }))}/>
          <span>{t("settings.appearance.taskDetailChatFirst", "Open task details with Chat first")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.taskDetailChatFirstHelp", "Off by default: task details list Activity first and omitted non-done opens land on Activity. Turn on to restore Chat-first order/default; explicit Chat links still work either way.")}</small>
      </div>
      <div className="form-group">
        <label className="checkbox-label">
          <input id="sessionBannersHidden" type="checkbox" checked={sessionBannersHidden} onChange={(e) => setSessionBannersHidden(e.target.checked)}/>
          <span>{t("settings.appearance.hideAISessionNotificationBanners", "Hide AI session notification banners")}</span>
        </label>
        <small className="form-text text-muted">{t("settings.appearance.suppressTheLdquoNeedsYourInputRdquoBanner", " Suppress the &ldquo;needs your input&rdquo; banner that appears when AI sessions are awaiting input or have failed. ")}</small>
      </div>
    </>);
}
export default AppearanceSection;
