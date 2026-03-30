import { useCallback } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemeMode, ColorTheme } from "@kb/core";

interface ThemeSelectorProps {
  themeMode: ThemeMode;
  colorTheme: ColorTheme;
  onThemeModeChange: (mode: ThemeMode) => void;
  onColorThemeChange: (theme: ColorTheme) => void;
}

const THEME_MODES: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const COLOR_THEMES: { value: ColorTheme; label: string; className: string }[] = [
  { value: "default", label: "Default", className: "theme-swatch-default" },
  { value: "ocean", label: "Ocean", className: "theme-swatch-ocean" },
  { value: "forest", label: "Forest", className: "theme-swatch-forest" },
  { value: "sunset", label: "Sunset", className: "theme-swatch-sunset" },
  { value: "berry", label: "Berry", className: "theme-swatch-berry" },
  { value: "monochrome", label: "Mono", className: "theme-swatch-monochrome" },
  { value: "high-contrast", label: "High Contrast", className: "theme-swatch-high-contrast" },
  { value: "solarized", label: "Solarized", className: "theme-swatch-solarized" },
];

/**
 * ThemeSelector component for choosing light/dark/system mode and color theme
 */
export function ThemeSelector({
  themeMode,
  colorTheme,
  onThemeModeChange,
  onColorThemeChange,
}: ThemeSelectorProps) {
  const handleReset = useCallback(() => {
    onThemeModeChange("dark");
    onColorThemeChange("default");
  }, [onThemeModeChange, onColorThemeChange]);

  return (
    <div className="theme-selector">
      {/* Theme Mode Toggle */}
      <div className="theme-mode-toggle" role="radiogroup" aria-label="Theme mode">
        {THEME_MODES.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            className={`theme-mode-btn${themeMode === value ? " active" : ""}`}
            onClick={() => onThemeModeChange(value)}
            aria-pressed={themeMode === value}
            aria-label={`${label} mode`}
            title={`${label} mode`}
          >
            <Icon size={16} />
            <span>{label}</span>
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
          <div className="theme-preview-label">Current theme</div>
          <div className="theme-preview-value">
            {themeMode === "system" ? "System" : `${themeMode.charAt(0).toUpperCase() + themeMode.slice(1)}`}
            {" / "}
            {COLOR_THEMES.find((t) => t.value === colorTheme)?.label}
          </div>
        </div>
      </div>

      {/* Color Theme Grid */}
      <div className="theme-section-title">Color Theme</div>
      <div className="theme-grid" role="radiogroup" aria-label="Color theme">
        {COLOR_THEMES.map(({ value, label, className }) => (
          <button
            key={value}
            className={`theme-option${colorTheme === value ? " active" : ""}`}
            onClick={() => onColorThemeChange(value)}
            aria-pressed={colorTheme === value}
            aria-label={`${label} theme`}
            title={label}
          >
            <div className={`theme-option-swatch ${className}`} />
            <span className="theme-option-label">{label}</span>
          </button>
        ))}
      </div>

      {/* Reset Button */}
      <button
        className="theme-reset-btn"
        onClick={handleReset}
        aria-label="Reset to default theme"
      >
        <span>Reset to defaults</span>
      </button>
    </div>
  );
}
