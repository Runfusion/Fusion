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
  triggerVariant?: "compact" | "current-row";
}

export function resolveColorTheme(colorTheme: ColorTheme) {
  return COLOR_THEMES.find((theme) => theme.value === colorTheme) ?? COLOR_THEMES[0];
}

function normalizeThemeQuery(value: string) {
  return value.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
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

FNXC:Theme 2026-07-16-14:30:
FN-8146 merges Settings' current-theme summary into this dropdown trigger. The Settings variant carries mode and combined-value context while Command Center retains the compact swatch-and-label trigger.
*/
export function ThemeDropdown({
  colorTheme,
  onColorThemeChange,
  themeMode,
  shadcnCustomColors = {},
  resolvedThemeMode = themeMode === "light" ? "light" : "dark",
  onThemeModeChange,
  onShadcnCustomColorsChange = () => {},
  triggerVariant = "compact",
}: ThemeDropdownProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<ColorTheme | null>(colorTheme);
  const [openOrigin, setOpenOrigin] = useState<"pointer" | "keyboard" | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const shouldFocusFilterRef = useRef(false);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const currentTheme = useMemo(() => resolveColorTheme(colorTheme), [colorTheme]);
  const currentMode = themeMode === "system" ? resolvedThemeMode : themeMode;
  const CurrentModeIcon = THEME_MODES.find((mode) => mode.value === currentMode)?.icon;
  const modeLabel = themeMode === "system"
    ? t("theme.system", "System")
    : t(`theme.${themeMode}`, themeMode ? `${themeMode.charAt(0).toUpperCase()}${themeMode.slice(1)}` : "Dark");
  const currentThemeLabel = t(`theme.colorTheme.${currentTheme.value}`, currentTheme.label);
  const currentRowLabel = `${t("theme.currentTheme", "Current theme")} ${modeLabel} / ${currentThemeLabel}`;
  const listboxId = "theme-dropdown-listbox";
  const themesWithDisplayLabels = useMemo(
    () => COLOR_THEMES.map((theme) => ({ ...theme, displayLabel: t(`theme.colorTheme.${theme.value}`, theme.label) })),
    [t],
  );
  const normalizedQuery = normalizeThemeQuery(query);
  const filteredThemes = useMemo(
    () => themesWithDisplayLabels.filter((theme) => normalizeThemeQuery(theme.displayLabel).includes(normalizedQuery)),
    [normalizedQuery, themesWithDisplayLabels],
  );
  const activeIndex = filteredThemes.findIndex((theme) => theme.value === activeValue);

  /*
  FNXC:DashboardTheming 2026-07-21-12:00:
  FN-8471 makes the 84-theme catalog discoverable without changing its persisted order or IDs. Filtering always uses the translated label rendered to operators (with metadata fallback), while pointer opens focus search and trigger keys deliberately focus filtered options: Down first, Up last, Enter/Space selected-or-first. Roving focus therefore only addresses the visible derived list.
  */
  const close = () => {
    setOpen(false);
    setQuery("");
    setActiveValue(colorTheme);
    setOpenOrigin(null);
    shouldFocusFilterRef.current = false;
    optionRefs.current = [];
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open, colorTheme]);

  useEffect(() => {
    if (!open) return;
    if (!filteredThemes.some((theme) => theme.value === activeValue)) {
      setActiveValue(filteredThemes[0]?.value ?? null);
    }
  }, [activeValue, filteredThemes, open]);

  useEffect(() => {
    if (!open) return;
    if (openOrigin === "pointer" && shouldFocusFilterRef.current) {
      filterRef.current?.focus();
      shouldFocusFilterRef.current = false;
    } else if (openOrigin === "keyboard") {
      const index = filteredThemes.findIndex((theme) => theme.value === activeValue);
      optionRefs.current[index]?.focus();
    }
  }, [activeValue, filteredThemes, open, openOrigin]);

  const chooseTheme = (theme: ColorTheme) => {
    onColorThemeChange(theme);
    close();
  };

  const openFromTrigger = (origin: "pointer" | "keyboard", key?: string) => {
    if (origin === "pointer") {
      shouldFocusFilterRef.current = true;
      setActiveValue(colorTheme);
    } else {
      const selectedVisible = filteredThemes.some((theme) => theme.value === colorTheme);
      const target = key === "ArrowUp"
        ? filteredThemes.at(-1)?.value ?? null
        : (key === "ArrowDown" ? filteredThemes[0]?.value ?? null : (selectedVisible ? colorTheme : filteredThemes[0]?.value ?? null));
      setActiveValue(target);
    }
    setOpenOrigin(origin);
    setOpen(true);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openFromTrigger("keyboard", event.key);
    }
  };

  const handleFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const targetIndex = event.key === "ArrowUp"
      ? filteredThemes.length - 1
      : Math.max(0, activeIndex);
    if (targetIndex < 0 || !filteredThemes[targetIndex]) return;
    event.preventDefault();
    setActiveValue(filteredThemes[targetIndex].value);
    optionRefs.current[targetIndex]?.focus();
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, theme: ColorTheme) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (index + delta + filteredThemes.length) % filteredThemes.length;
      setActiveValue(filteredThemes[nextIndex]?.value ?? null);
      optionRefs.current[nextIndex]?.focus();
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setActiveValue(filteredThemes[0]?.value ?? null);
      optionRefs.current[0]?.focus();
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      const lastIndex = filteredThemes.length - 1;
      setActiveValue(filteredThemes[lastIndex]?.value ?? null);
      optionRefs.current[lastIndex]?.focus();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseTheme(theme);
    }
  };

  return (
    <div className={`theme-dropdown${triggerVariant === "current-row" ? " theme-dropdown--current-row" : ""}${open ? " open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className={`theme-dropdown-trigger btn${triggerVariant === "current-row" ? " theme-dropdown-trigger--current-row" : ""}`}
        aria-label={triggerVariant === "current-row" ? currentRowLabel : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => open ? close() : openFromTrigger("pointer")}
        onKeyDown={handleTriggerKeyDown}
      >
        {triggerVariant === "current-row" ? (
          <>
            <span className="theme-dropdown-current-row-icon" aria-hidden="true">
              {CurrentModeIcon ? <CurrentModeIcon size={20} /> : null}
            </span>
            <span className="theme-dropdown-current-row-info">
              <span className="theme-dropdown-current-row-label">{t("theme.currentTheme", "Current theme")}</span>
              <span className="theme-dropdown-current-row-value">
                {modeLabel} / {currentThemeLabel}
              </span>
            </span>
            <ThemeSwatch className={currentTheme.className} />
          </>
        ) : (
          <>
            <ThemeSwatch className={currentTheme.className} />
            <span className="theme-dropdown-trigger-label">
              {currentThemeLabel}
            </span>
          </>
        )}
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
          <label className="theme-dropdown-filter">
            <span className="sr-only">{t("theme.filterColorThemes", "Filter color themes")}</span>
            <input
              ref={filterRef}
              type="search"
              className="input"
              value={query}
              placeholder={t("theme.filterColorThemesPlaceholder", "Filter color themes")}
              aria-label={t("theme.filterColorThemes", "Filter color themes")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleFilterKeyDown}
            />
          </label>
          {filteredThemes.length ? (
            <div id={listboxId} className="theme-dropdown-list" role="listbox" aria-label={t("theme.colorThemeLabel", "Color theme")}>
              {filteredThemes.map(({ value, displayLabel, className }, index) => {
                const selected = colorTheme === value;
                return (
                  <button
                    key={value}
                    ref={(element) => { optionRefs.current[index] = element; }}
                    type="button"
                    className={`theme-dropdown-option${selected ? " active" : ""}`}
                    role="option"
                    aria-selected={selected}
                    tabIndex={index === activeIndex ? 0 : -1}
                    onClick={() => chooseTheme(value)}
                    onKeyDown={(event) => handleOptionKeyDown(event, index, value)}
                  >
                    <ThemeSwatch className={className} />
                    <span className="theme-dropdown-option-label">{displayLabel}</span>
                    {selected ? <Check size={16} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ) : <p className="theme-dropdown-no-results">{t("theme.noColorThemes", "No color themes found")}</p>}
        </div>
      ) : null}
    </div>
  );
}

export type { ThemeDropdownProps };
