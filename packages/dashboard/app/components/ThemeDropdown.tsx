import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown } from "lucide-react";
import type { ColorTheme, ThemeMode } from "@fusion/core";
import { COLOR_THEMES, THEME_MODES } from "./themeOptions";
import { ShadcnColorPicker } from "./ShadcnColorPicker";
import "./ThemeSelector.css";
import "./ThemeDropdown.css";

interface ThemeDropdownProps {
  colorTheme: ColorTheme;
  onColorThemeChange: (theme: ColorTheme) => void;
  themeMode?: ThemeMode;
  shadcnCustomColors?: Record<string, string>;
  resolvedThemeMode?: "dark" | "light";
  onThemeModeChange?: (mode: ThemeMode) => void;
  onShadcnCustomColorsChange?: (colors: Record<string, string>) => void;
}

export function resolveColorTheme(colorTheme: ColorTheme) {
  return COLOR_THEMES.find((theme) => theme.value === colorTheme) ?? COLOR_THEMES[0];
}

function ThemeSwatch({ className }: { className: string }) {
  return (
    <span className={`theme-option-swatch ${className}`} aria-hidden="true">
      <span className="theme-option-swatch-sample theme-option-swatch-sample-1" />
      <span className="theme-option-swatch-sample theme-option-swatch-sample-2" />
      <span className="theme-option-swatch-sample theme-option-swatch-sample-3" />
      <span className="theme-option-swatch-sample theme-option-swatch-sample-4" />
    </span>
  );
}

/*
FNXC:Theme 2026-06-19-12:10:
FN-6727 requires Command Center operators to change the global app theme from a compact dropdown that previews each color theme with the same rich swatch chips used by Settings; this component accepts App-threaded setters instead of creating another theme owner.
*/
export function ThemeDropdown({
  colorTheme,
  onColorThemeChange,
  themeMode,
  shadcnCustomColors = {},
  resolvedThemeMode = themeMode === "light" ? "light" : "dark",
  onThemeModeChange,
  onShadcnCustomColorsChange = () => {},
}: ThemeDropdownProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, COLOR_THEMES.findIndex((theme) => theme.value === colorTheme)));
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const currentTheme = useMemo(() => resolveColorTheme(colorTheme), [colorTheme]);
  const listboxId = "theme-dropdown-listbox";

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex(Math.max(0, COLOR_THEMES.findIndex((theme) => theme.value === colorTheme)));
  }, [colorTheme]);

  useEffect(() => {
    if (open) {
      optionRefs.current[activeIndex]?.focus();
    }
  }, [activeIndex, open]);

  const chooseTheme = (theme: ColorTheme) => {
    onColorThemeChange(theme);
    setOpen(false);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const selectedIndex = Math.max(0, COLOR_THEMES.findIndex((theme) => theme.value === colorTheme));
      setActiveIndex(event.key === "ArrowUp" ? Math.max(0, selectedIndex - 1) : selectedIndex);
      setOpen(true);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, theme: ColorTheme) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index + delta + COLOR_THEMES.length) % COLOR_THEMES.length);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(COLOR_THEMES.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseTheme(theme);
    }
  };

  return (
    <div className={`theme-dropdown${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="theme-dropdown-trigger btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <ThemeSwatch className={currentTheme.className} />
        <span className="theme-dropdown-trigger-label">
          {t(`theme.colorTheme.${currentTheme.value}`, currentTheme.label)}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>

      {themeMode && onThemeModeChange ? (
        <div className="theme-dropdown-modes" role="radiogroup" aria-label={t("theme.modeLabel", "Theme mode")}>
          {THEME_MODES.map(({ value, label, icon: Icon }) => (
            <button
              key={value}
              type="button"
              className={`theme-dropdown-mode-btn btn btn-sm${themeMode === value ? " active" : ""}`}
              aria-pressed={themeMode === value}
              onClick={() => onThemeModeChange(value)}
              title={t(`theme.${value}Mode`, `${label} mode`)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(`theme.${value}`, label)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* FNXC:Theme 2026-06-20-19:00: Command Center exposes the same shadcn-custom color picker as Settings and hides it for every other theme so non-custom themes never show orphaned override controls. */}
      {colorTheme === "shadcn-custom" ? (
        <ShadcnColorPicker
          value={shadcnCustomColors}
          onChange={onShadcnCustomColorsChange}
          resolvedThemeMode={resolvedThemeMode}
        />
      ) : null}

      {open ? (
        <div className="theme-dropdown-popover" role="presentation">
          <div id={listboxId} className="theme-dropdown-list" role="listbox" aria-label={t("theme.colorThemeLabel", "Color theme")}>
            {COLOR_THEMES.map(({ value, label, className }, index) => {
              const selected = colorTheme === value;
              return (
                <button
                  key={value}
                  ref={(element) => {
                    optionRefs.current[index] = element;
                  }}
                  type="button"
                  className={`theme-dropdown-option${selected ? " active" : ""}`}
                  role="option"
                  aria-selected={selected}
                  tabIndex={index === activeIndex ? 0 : -1}
                  onClick={() => chooseTheme(value)}
                  onKeyDown={(event) => handleOptionKeyDown(event, index, value)}
                >
                  <ThemeSwatch className={className} />
                  <span className="theme-dropdown-option-label">{t(`theme.colorTheme.${value}`, label)}</span>
                  {selected ? <Check size={16} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export type { ThemeDropdownProps };
