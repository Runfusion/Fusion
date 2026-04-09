import { useCallback } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import type { ThemeMode, ColorTheme } from "@fusion/core";

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
  { value: "zen", label: "Zen", className: "theme-swatch-zen" },
  { value: "berry", label: "Berry", className: "theme-swatch-berry" },
  { value: "high-contrast", label: "High Contrast", className: "theme-swatch-high-contrast" },
  { value: "industrial", label: "Industrial", className: "theme-swatch-industrial" },
  { value: "monochrome", label: "Mono", className: "theme-swatch-monochrome" },
  { value: "slate", label: "Slate", className: "theme-swatch-slate" },
  { value: "ash", label: "Ash", className: "theme-swatch-ash" },
  { value: "graphite", label: "Graphite", className: "theme-swatch-graphite" },
  { value: "silver", label: "Silver", className: "theme-swatch-silver" },
  { value: "solarized", label: "Solarized", className: "theme-swatch-solarized" },
  { value: "factory", label: "Factory", className: "theme-swatch-factory" },
  { value: "ayu", label: "Ayu", className: "theme-swatch-ayu" },
  { value: "one-dark", label: "One Dark", className: "theme-swatch-one-dark" },
  { value: "nord", label: "Nord", className: "theme-swatch-nord" },
  { value: "dracula", label: "Dracula", className: "theme-swatch-dracula" },
  { value: "gruvbox", label: "Gruvbox", className: "theme-swatch-gruvbox" },
  { value: "tokyo-night", label: "Tokyo Night", className: "theme-swatch-tokyo-night" },
  { value: "catppuccin-mocha", label: "Catppuccin Mocha", className: "theme-swatch-catppuccin-mocha" },
  { value: "github-dark", label: "GitHub Dark", className: "theme-swatch-github-dark" },
  { value: "everforest", label: "Everforest", className: "theme-swatch-everforest" },
  { value: "rose-pine", label: "Rosé Pine", className: "theme-swatch-rose-pine" },
  { value: "kanagawa", label: "Kanagawa", className: "theme-swatch-kanagawa" },
  { value: "night-owl", label: "Night Owl", className: "theme-swatch-night-owl" },
  { value: "palenight", label: "Palenight", className: "theme-swatch-palenight" },
  { value: "monokai-pro", label: "Monokai Pro", className: "theme-swatch-monokai-pro" },
  { value: "slime", label: "Slime", className: "theme-swatch-slime" },
  { value: "brutalist", label: "Brutalist", className: "theme-swatch-brutalist" },
  { value: "neon-city", label: "Neon City", className: "theme-swatch-neon-city" },
  { value: "parchment", label: "Parchment", className: "theme-swatch-parchment" },
  { value: "terminal", label: "Terminal", className: "theme-swatch-terminal" },
  { value: "glass", label: "Glass", className: "theme-swatch-glass" },
  { value: "horizon", label: "Horizon", className: "theme-swatch-horizon" },
  { value: "vitesse", label: "Vitesse", className: "theme-swatch-vitesse" },
  { value: "outrun", label: "Outrun", className: "theme-swatch-outrun" },
  { value: "snazzy", label: "Snazzy", className: "theme-swatch-snazzy" },
  { value: "porple", label: "Porple", className: "theme-swatch-porple" },
  { value: "espresso", label: "Espresso", className: "theme-swatch-espresso" },
  { value: "mars", label: "Mars", className: "theme-swatch-mars" },
  { value: "poimandres", label: "Poimandres", className: "theme-swatch-poimandres" },
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
