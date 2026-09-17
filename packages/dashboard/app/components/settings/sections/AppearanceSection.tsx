import { useTranslation } from "react-i18next";
import type { ThemeMode, ColorTheme, UiStyle } from "@fusion/core";
import { ThemeSelector } from "../../ThemeSelector";
import { LanguageSelector } from "../../LanguageSelector";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import type { SectionBaseProps } from "./context";
import { normalizeChatMessageLayout, normalizeTaskDetailDefaultTab, type ChatMessageLayout, type TaskDetailDefaultTab } from "../../../hooks/useAppSettings";
import { normalizeNavigationPlacement, type NavigationPlacement } from "../../../utils/navigationPlacement";
export interface AppearanceSectionProps extends SectionBaseProps {
    themeMode: ThemeMode;
    colorTheme: ColorTheme;
    /* FNXC:UiStyleAxis 2026-09-15-00:20: the interface style is global like themeMode/colorTheme and independent of them. */
    uiStyle?: UiStyle;
    onUiStyleChange?: (style: UiStyle) => void;
    dashboardFontScalePct: number;
    shadcnCustomColors?: Record<string, string>;
    resolvedThemeMode?: "dark" | "light";
    onThemeModeChange?: (mode: ThemeMode) => void;
    onColorThemeChange?: (theme: ColorTheme) => void;
    onDashboardFontScaleChange?: (scalePct: number) => void;
    onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
    chatMessageLayout?: ChatMessageLayout;
    onChatMessageLayoutChange?: (layout: ChatMessageLayout) => void;
    /* FNXC:Navigation 2026-09-15-14:41: FN-419 — project choice of the single primary navigation surface. */
    navigationPlacement?: NavigationPlacement;
    onNavigationPlacementChange?: (placement: NavigationPlacement) => void;
    /* FNXC:RightSidebarOptional 2026-09-15-16:04: FN-426 — project opt-in for the otherwise-absent right tool dock. */
    rightSidebarEnabled?: boolean;
    onRightSidebarEnabledChange?: (enabled: boolean) => void;
    showCostBadgeOnCards?: boolean;
    onShowCostBadgeOnCardsChange?: (enabled: boolean) => void;
    /* FNXC:TaskDetailDefaultTab 2026-09-16-02:53: FN-442 — three-value project choice replacing the Chat-first opt-in. */
    taskDetailDefaultTab?: TaskDetailDefaultTab;
    onTaskDetailDefaultTabChange?: (tab: TaskDetailDefaultTab) => void;
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
export function AppearanceSection({ form, setForm, themeMode, colorTheme, uiStyle, onUiStyleChange, dashboardFontScalePct, shadcnCustomColors = {}, resolvedThemeMode, onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, onShadcnCustomColorsChange, chatMessageLayout = "bubbles", onChatMessageLayoutChange, navigationPlacement = "footer", onNavigationPlacementChange, rightSidebarEnabled, onRightSidebarEnabledChange, showCostBadgeOnCards, onShowCostBadgeOnCardsChange, taskDetailDefaultTab, onTaskDetailDefaultTabChange, sessionBannersHidden, setSessionBannersHidden, }: AppearanceSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.appearance.title", "Appearance")}</h4>
      <ThemeSelector themeMode={themeMode} colorTheme={colorTheme} uiStyle={uiStyle} onUiStyleChange={onUiStyleChange ? (style) => {
            /*
            FNXC:UiStyleAxis 2026-09-15-00:20:
            Mirror the chosen style into the settings form so an open Settings form saved later cannot write
            back a stale value over a choice made meanwhile from the Command Center, then hand the choice to
            the single useTheme owner that actually persists it.
            */
            setForm((f) => ({ ...f, uiStyle: style }));
            onUiStyleChange(style);
        } : undefined} dashboardFontScalePct={dashboardFontScalePct} onThemeModeChange={(mode) => {
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
      {/*
      FNXC:Navigation 2026-09-15-14:41:
      FN-419: one project choice decides WHERE the primary menu lives. The two surfaces are mutually exclusive by
      construction, so this control can never produce the historical double-navigation state.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "navigationPlacement",
          label: t("settings.appearance.navigationPlacement", "Navigation menu placement"),
          help: t("settings.appearance.navigationPlacementHelp", "Choose whether the main menu sits in the bottom bar or in a left sidebar. Only one is ever shown. Project-scoped; default: Bottom bar."),
          scope: "project",
          options: [
            { value: "footer", label: t("settings.appearance.navigationPlacementFooter", "Bottom bar") },
            { value: "sidebar", label: t("settings.appearance.navigationPlacementSidebar", "Left sidebar") },
          ],
        }}
        value={normalizeNavigationPlacement(form.navigationPlacement ?? navigationPlacement)}
        onChange={(value) => {
          const nextPlacement = normalizeNavigationPlacement(value);
          setForm((f) => ({ ...f, navigationPlacement: nextPlacement }));
          onNavigationPlacementChange?.(nextPlacement);
        }}
      />
      <SettingsSelectRow
        descriptor={{
          key: "chatMessageLayout",
          label: t("settings.appearance.chatMessageLayout", "Conversation layout"),
          help: t("settings.appearance.chatMessageLayoutHelp", "Choose Bubbles or Full width for Chat, task Activity, and Planner Chat. Project-scoped; default: Bubbles."),
          scope: "project",
          options: [
            { value: "bubbles", label: t("settings.appearance.chatMessageLayoutBubbles", "Bubbles") },
            { value: "full-width", label: t("settings.appearance.chatMessageLayoutFullWidth", "Full width") },
          ],
        }}
        value={normalizeChatMessageLayout(form.chatMessageLayout ?? chatMessageLayout)}
        onChange={(value) => {
          const nextLayout = normalizeChatMessageLayout(value);
          setForm((f) => ({ ...f, chatMessageLayout: nextLayout }));
          onChatMessageLayoutChange?.(nextLayout);
        }}
      />
      {/*
      FNXC:RightSidebarOptional 2026-09-15-16:04:
      FN-426: availability of the right tool dock, not its open/closed state. Off by default because every tool it
      hosts is reachable from the header, footer, or a dedicated page; switching it on restores a Files/Chat/List/Notes
      shortcut panel without removing any of those accesses.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "rightSidebarEnabled",
          label: t("settings.appearance.rightSidebarEnabled", "Show the right tool sidebar"),
          help: t("settings.appearance.rightSidebarEnabledHelp", "When enabled, tablet and desktop show an optional right sidebar with Files, Chat, List, and Notes shortcuts. Every tool stays reachable without it. Project-scoped; default: disabled."),
          scope: "project",
        }}
        value={(form.rightSidebarEnabled ?? rightSidebarEnabled) === true}
        onChange={(v) => {
          const next = v === true;
          setForm((f) => ({ ...f, rightSidebarEnabled: next }));
          onRightSidebarEnabledChange?.(next);
        }}
      />
      {/* FNXC:TaskCardCostBadge 2026-07-11-12:15: This project setting is opt-in because board cards are already dense; when enabled, only tasks with recorded positive token usage render a read-time derived spend badge. */}
      <SettingsToggleRow
        descriptor={{
          key: "showCostBadgeOnCards",
          label: t("settings.appearance.showCostBadgeOnCards", "Show cost badges on task cards"),
          help: t("settings.appearance.showCostBadgeOnCardsHelp", "Default: disabled. When enabled, board cards show derived model cost next to execution time; unavailable pricing displays — and tasks without token usage show no badge."),
          scope: "project",
        }}
        value={form.showCostBadgeOnCards ?? showCostBadgeOnCards === true}
        onChange={(v) => {
          const enabled = v === true;
          setForm((f) => ({ ...f, showCostBadgeOnCards: enabled }));
          onShowCostBadgeOnCardsChange?.(enabled);
        }}
      />
      {/*
      FNXC:TaskDetailDefaultTab 2026-09-16-02:53:
      FN-442: one three-value project choice replaces the Chat-first checkbox. It names the tab a task opens on when no
      tab is requested AND the tab that leads the task-detail tab bar. `activity` is the historical default; explicit
      Activity/Chat/Logs deep links keep their destination regardless of this choice.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "taskDetailDefaultTab",
          label: t("settings.appearance.taskDetailDefaultTab", "Open task details on"),
          help: t("settings.appearance.taskDetailDefaultTabHelp", "Choose which tab a task opens on and leads the task detail tab bar: Definition, Chat, or Activity. Explicit task links keep their destination. Project-scoped; default: Activity."),
          scope: "project",
          options: [
            { value: "definition", label: t("settings.appearance.taskDetailDefaultTabDefinition", "Definition") },
            { value: "chat", label: t("settings.appearance.taskDetailDefaultTabChat", "Chat") },
            { value: "activity", label: t("settings.appearance.taskDetailDefaultTabActivity", "Activity") },
          ],
        }}
        value={normalizeTaskDetailDefaultTab(form.taskDetailDefaultTab ?? taskDetailDefaultTab)}
        onChange={(value) => {
          const nextTab = normalizeTaskDetailDefaultTab(value);
          setForm((f) => ({ ...f, taskDetailDefaultTab: nextTab }));
          onTaskDetailDefaultTabChange?.(nextTab);
        }}
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
