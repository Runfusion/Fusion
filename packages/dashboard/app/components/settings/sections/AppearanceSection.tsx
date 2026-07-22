import { useTranslation } from "react-i18next";
import type { ThemeMode, ColorTheme } from "@fusion/core";
import { ThemeSelector } from "../../ThemeSelector";
import { LanguageSelector } from "../../LanguageSelector";
import { SettingsToggleRow } from "../SettingsToggleRow";
import type { SectionBaseProps } from "./context";
export interface AppearanceSectionProps extends SectionBaseProps {
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
/*
FNXC:SettingsStyling 2026-07-15-17:35:
Rows render through the shared settings primitives rather than hand-rolled `form-group` + `checkbox-label` markup, so this section's labels, help copy, and padding come from the one type scale instead of the three competing label idioms the modal carried before.
`.form-group` itself is untouched and still global: 35 non-settings files style forms with it, so the fix is to migrate settings off it, not to restyle it underneath the rest of the dashboard.

FNXC:SettingsScope 2026-07-15-17:35:
Scope badges are per-row because this section genuinely mixes authority levels: theme, color, and font scale are global (DEFAULT_GLOBAL_SETTINGS), while every task-presentation toggle below is project-scoped (DEFAULT_PROJECT_SETTINGS). The nav labels the whole section "global", which is true only of the theme controls, so the badges are what tell an operator which of these travels between projects.
*/
export function AppearanceSection({ form, setForm, themeMode, colorTheme, dashboardFontScalePct, shadcnCustomColors = {}, resolvedThemeMode, onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, onShadcnCustomColorsChange, sessionBannersHidden, setSessionBannersHidden, }: AppearanceSectionProps) {
    const { t } = useTranslation("app");
    return (<>
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
      <SettingsToggleRow
        descriptor={{
          key: "openTasksInRightSidebar",
          label: t("settings.appearance.openTasksInRightSidebar", "Open tasks in the right sidebar"),
          help: t("settings.appearance.openTasksInRightSidebarHelp", "When enabled, board task cards open detail in the right sidebar when it is available; mobile and hidden-sidebar states keep the full task panel. Default: disabled."),
          scope: "project",
        }}
        value={form.openTasksInRightSidebar === true}
        onChange={(v) => setForm((f) => ({ ...f, openTasksInRightSidebar: v === true }))}
      />
      {/* FNXC:MobileTaskPopups 2026-07-21-00:00 (FN-8478): Keep the stored openMobileTasksInPopup key for compatibility and explain that board-card deep-tab chips now use the same popup routing, preserving the board behind Changes, Retries, or Workflow detail. */}
      <SettingsToggleRow
        descriptor={{
          key: "openMobileTasksInPopup",
          label: t("settings.appearance.openMobileTasksInPopup", "Open tasks as popups"),
          help: t("settings.appearance.openMobileTasksInPopupHelp", "When enabled, board task-card clicks including Changes, Retries, and Workflow chips, plus ordinary List row/card and right-dock Tasks-list clicks, open the existing movable task popup so the board or list remains visible. Other task opens keep their current behavior. Default: disabled."),
          scope: "project",
        }}
        value={form.openMobileTasksInPopup === true}
        onChange={(v) => setForm((f) => ({ ...f, openMobileTasksInPopup: v === true }))}
      />
      {/* FNXC:TaskPopupViewGating 2026-07-15-15:20: FN-8016 scopes task popups to their opening dashboard view by default. Operators may explicitly disable it for legacy globally shared popups; hidden scoped entries retain geometry and reopen on return. */}
      <SettingsToggleRow
        descriptor={{
          key: "taskPopupsBoardListOnly",
          label: t("settings.appearance.taskPopupsBoardListOnly", "Keep task popups on the view where they were opened"),
          help: t("settings.appearance.taskPopupsBoardListOnlyHelp", "When enabled, each open task-detail popup appears only on the view where it was opened. Switching views hides it without closing; returning restores it in the same position. Default: enabled."),
          scope: "project",
        }}
        value={form.taskPopupsBoardListOnly === true}
        onChange={(v) => setForm((f) => ({ ...f, taskPopupsBoardListOnly: v === true }))}
      />
      {/* FNXC:TaskCardCostBadge 2026-07-11-12:15: This project setting is opt-in because board cards are already dense; when enabled, only tasks with recorded positive token usage render a read-time derived spend badge. */}
      <SettingsToggleRow
        descriptor={{
          key: "showCostBadgeOnCards",
          label: t("settings.appearance.showCostBadgeOnCards", "Show cost badges on task cards"),
          help: t("settings.appearance.showCostBadgeOnCardsHelp", "Default: disabled. When enabled, board cards show derived model cost next to execution time; unavailable pricing displays — and tasks without token usage show no badge."),
          scope: "project",
        }}
        value={form.showCostBadgeOnCards === true}
        onChange={(v) => setForm((f) => ({ ...f, showCostBadgeOnCards: v === true }))}
      />
      {/* FNXC:TaskDetailActivityFirst 2026-06-30-23:59: The project setting is opt-in because task details now default to Activity-first; explicit Activity/Chat/Logs links keep their destination regardless of this checkbox. */}
      <SettingsToggleRow
        descriptor={{
          key: "taskDetailChatFirst",
          label: t("settings.appearance.taskDetailChatFirst", "Open task details with Chat first"),
          help: t("settings.appearance.taskDetailChatFirstHelp", "Off by default: task details list Activity first and omitted non-done opens land on Activity. Turn on to restore Chat-first order/default; explicit Chat links still work either way."),
          scope: "project",
        }}
        value={form.taskDetailChatFirst === true}
        onChange={(v) => setForm((f) => ({ ...f, taskDetailChatFirst: v === true }))}
      />
      {/*
      FNXC:SettingsScope 2026-07-15-17:35:
      This one carries no scope badge on purpose: it is a browser-local display preference held outside the settings blob (hence the dedicated prop rather than `form`), so it is neither global nor project state and must not claim to travel with either.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "sessionBannersHidden",
          label: t("settings.appearance.hideAISessionNotificationBanners", "Hide AI session notification banners"),
          /*
          FNXC:SettingsCopy 2026-07-15-17:35:
          Real typographic quotes, not `&ldquo;`/`&rdquo;`: React renders this string as text, so the HTML entities printed verbatim on screen. The i18n key name still spells out the old entities — renaming it would churn key parity across six locales for no user-visible gain.
          */
          help: t("settings.appearance.suppressTheLdquoNeedsYourInputRdquoBanner", "Suppress the “needs your input” banner that appears when AI sessions are awaiting input or have failed."),
        }}
        value={sessionBannersHidden}
        onChange={(v) => setSessionBannersHidden(v === true)}
      />
    </>);
}
export default AppearanceSection;
