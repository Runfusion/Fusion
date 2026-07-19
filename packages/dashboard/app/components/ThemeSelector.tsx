import "./ThemeSelector.css";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ThemeMode, ColorTheme } from "@fusion/core";
import { THEME_MODES } from "./themeOptions";
import { ThemeDropdown } from "./ThemeDropdown";

interface ThemeSelectorProps {
  themeMode: ThemeMode;
  colorTheme: ColorTheme;
  dashboardFontScalePct?: number;
  shadcnCustomColors?: Record<string, string>;
  resolvedThemeMode?: "dark" | "light";
  onThemeModeChange: (mode: ThemeMode) => void;
  onColorThemeChange: (theme: ColorTheme) => void;
  onDashboardFontScaleChange?: (scalePct: number) => void;
  onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
}

const FONT_SCALE_OPTIONS = [
  { value: 90, label: "Small" },
  { value: 100, label: "Default" },
  { value: 110, label: "Large" },
  { value: 120, label: "Largest" },
] as const;

/**
 * ThemeSelector component for choosing light/dark/system mode and color theme
 */
export function ThemeSelector({
  themeMode,
  colorTheme,
  dashboardFontScalePct = 100,
  shadcnCustomColors = {},
  resolvedThemeMode = themeMode === "light" ? "light" : "dark",
  onThemeModeChange,
  onColorThemeChange,
  onDashboardFontScaleChange = () => {},
  onShadcnCustomColorsChange = () => {},
}: ThemeSelectorProps) {
  const { t } = useTranslation("app");
  const handleReset = useCallback(() => {
    onThemeModeChange("system");
    /*
    FNXC:DashboardTheming 2026-07-03-00:00:
    Reset to defaults must match fresh-install behavior: System mode follows the OS preference while Shadcn Ember stays the default color theme, without migrating explicit Ocean or legacy theme choices.
    */
    onColorThemeChange("shadcn-ember");
    onDashboardFontScaleChange(100);
    onShadcnCustomColorsChange({});
  }, [onThemeModeChange, onColorThemeChange, onDashboardFontScaleChange, onShadcnCustomColorsChange]);

  return (
    <div className="theme-selector">
      {/* Theme Mode Toggle */}
      <div className="theme-mode-toggle" role="radiogroup" aria-label={t("theme.modeLabel", "Theme mode")}>
        {THEME_MODES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            className={`theme-mode-btn${themeMode === value ? " active" : ""}`}
            onClick={() => onThemeModeChange(value)}
            aria-pressed={themeMode === value}
            aria-label={t(`theme.${value}Mode`, `${label} mode`)}
            title={t(`theme.${value}Mode`, `${label} mode`)}
          >
            <Icon size={16} />
            <span>{t(`theme.${value}`, label)}</span>
          </button>
        ))}
      </div>

      {/* FNXC:Theme 2026-07-16-14:30: FN-8146 makes the current-theme row the sole Settings color-theme trigger, replacing the separate static preview and standalone dropdown without adding a second mode control. */}
      <ThemeDropdown
        triggerVariant="current-row"
        colorTheme={colorTheme}
        themeMode={themeMode}
        onColorThemeChange={onColorThemeChange}
        shadcnCustomColors={shadcnCustomColors}
        resolvedThemeMode={resolvedThemeMode}
        onShadcnCustomColorsChange={onShadcnCustomColorsChange}
      />

      <div className="theme-section-title">{t("theme.fontSize", "Font Size")}</div>
      <div className="theme-font-size-toggle" role="radiogroup" aria-label={t("theme.fontSizeLabel", "Dashboard font size")}>
        {FONT_SCALE_OPTIONS.map(({ value, label }) => (
          <button
            key={value}
            className={`theme-font-size-btn${dashboardFontScalePct === value ? " active" : ""}`}
            onClick={() => onDashboardFontScaleChange(value)}
            aria-pressed={dashboardFontScalePct === value}
          >
            <span>{t(`theme.fontSize.${label}`, label)}</span>
          </button>
        ))}
      </div>


      {/* Reset Button */}
      <button
        className="theme-reset-btn"
        onClick={handleReset}
        aria-label={t("theme.resetLabel", "Reset to default theme")}
      >
        <span>{t("theme.resetButton", "Reset to defaults")}</span>
      </button>
    </div>
  );
}
