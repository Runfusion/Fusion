import "./ThemeSelector.css";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemeMode, ColorTheme } from "@fusion/core";
import { COLOR_THEMES, THEME_MODES } from "./themeOptions";
import { ShadcnColorPicker } from "./ShadcnColorPicker";

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

      {/* Current Theme Preview */}
      <div className="theme-current-preview">
        <div className="theme-preview-icon">
          {themeMode === "light" ? (
            <Sun size={20} />
          ) : themeMode === "dark" ? (
            <Moon size={20} />
          ) : (
            <Monitor size={20} />
          )}
        </div>
        <div className="theme-preview-info">
          <div className="theme-preview-label">{t("theme.currentTheme", "Current theme")}</div>
          <div className="theme-preview-value">
            {themeMode === "system" ? "System" : `${themeMode.charAt(0).toUpperCase() + themeMode.slice(1)}`}
            {" / "}
            {COLOR_THEMES.find((t) => t.value === colorTheme)?.label}
          </div>
        </div>
      </div>

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

      {/* Color Theme Grid */}
      <div className="theme-section-title">{t("theme.colorTheme", "Color Theme")}</div>
      <div className="theme-grid" role="radiogroup" aria-label={t("theme.colorThemeLabel", "Color theme")}>
        {COLOR_THEMES.map(({ value, label, className }) => (
          <button
            key={value}
            className={`theme-option${colorTheme === value ? " active" : ""}`}
            onClick={() => onColorThemeChange(value)}
            aria-pressed={colorTheme === value}
            aria-label={t(`theme.colorTheme.${value}`, `${label} theme`)}
            title={t(`theme.colorTheme.${value}`, label)}
          >
            <div className={`theme-option-swatch ${className}`} aria-hidden="true">
              <span className="theme-option-swatch-sample theme-option-swatch-sample-1" />
              <span className="theme-option-swatch-sample theme-option-swatch-sample-2" />
              <span className="theme-option-swatch-sample theme-option-swatch-sample-3" />
              <span className="theme-option-swatch-sample theme-option-swatch-sample-4" />
            </div>
            <span className="theme-option-label">{t(`theme.colorTheme.${value}`, label)}</span>
          </button>
        ))}
      </div>

      {/* FNXC:Theme 2026-06-20-19:00: The custom color picker must be visible only for shadcn-custom on every theme-selector surface; ThemeSelector and ThemeDropdown share COLOR_THEMES and the same picker component so their affordances stay synchronized. */}
      {colorTheme === "shadcn-custom" ? (
        <ShadcnColorPicker
          value={shadcnCustomColors}
          onChange={onShadcnCustomColorsChange}
          resolvedThemeMode={resolvedThemeMode}
        />
      ) : null}

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
