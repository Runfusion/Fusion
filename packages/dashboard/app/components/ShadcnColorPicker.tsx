import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  SHADCN_CUSTOM_COLOR_TOKENS,
  getShadcnCustomDefaultValue,
  sanitizeShadcnCustomColors,
} from "./shadcnCustomColors";
import "./ShadcnColorPicker.css";

export interface ShadcnColorPickerProps {
  value?: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  resolvedThemeMode?: "dark" | "light";
}

function toColorInputValue(value: string): string {
  const trimmed = value.trim();
  if (/^#[\da-f]{6}$/i.test(trimmed)) {
    return trimmed;
  }
  if (/^#[\da-f]{3}$/i.test(trimmed)) {
    const [, r, g, b] = trimmed;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return "#000000";
}

/*
FNXC:Theme 2026-06-20-18:38:
The shadcn custom picker is shared by Settings and Command Center; it only edits the sanitized token→hex override map while the parent surfaces decide visibility for shadcn-custom so no other theme receives inline overrides.

FNXC:Theme 2026-06-30-00:00:
Custom shadcn controls default collapsed to keep dashboard theme surfaces compact while leaving the override editor discoverable through an accessible icon affordance wherever this shared picker renders.
*/
export function ShadcnColorPicker({
  value = {},
  onChange,
  resolvedThemeMode = "dark",
}: ShadcnColorPickerProps) {
  const { t } = useTranslation("app");
  const [expanded, setExpanded] = useState(false);
  const controlsId = useId();
  const sanitizedValue = useMemo(() => sanitizeShadcnCustomColors(value), [value]);

  const updateToken = (cssVar: string, nextValue: string) => {
    onChange(sanitizeShadcnCustomColors({ ...sanitizedValue, [cssVar]: nextValue }));
  };

  const toggleLabel = expanded
    ? t("theme.shadcnCustom.collapse", "Collapse custom colors")
    : t("theme.shadcnCustom.show", "Show custom colors");
  const ToggleIcon = expanded ? ChevronUp : ChevronDown;

  return (
    <section className="shadcn-color-picker card" data-testid="shadcn-color-picker" aria-labelledby="shadcn-color-picker-title">
      <div className="shadcn-color-picker-header">
        <div className="shadcn-color-picker-heading">
          <h3 id="shadcn-color-picker-title" className="shadcn-color-picker-title">
            {t("theme.shadcnCustom.title", "Custom shadcn colors")}
          </h3>
          <p className="shadcn-color-picker-description">
            {t("theme.shadcnCustom.description", "Override shadcn design tokens with hex colors. Blank tokens use the theme defaults.")}
          </p>
        </div>
        <button
          type="button"
          className="btn btn-icon btn-sm shadcn-color-picker-toggle"
          aria-expanded={expanded}
          aria-controls={controlsId}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => setExpanded((current) => !current)}
        >
          <ToggleIcon size={16} aria-hidden="true" />
        </button>
      </div>
      {expanded ? (
        <div id={controlsId} className="shadcn-color-picker-controls-panel" data-testid="shadcn-color-picker-controls">
          <div className="shadcn-color-picker-actions">
            <button type="button" className="btn btn-sm" onClick={() => onChange({})}>
              {t("theme.shadcnCustom.reset", "Reset custom colors")}
            </button>
          </div>
          <div className="shadcn-color-picker-grid">
            {SHADCN_CUSTOM_COLOR_TOKENS.map((token) => {
              const fallback = getShadcnCustomDefaultValue(token, resolvedThemeMode);
              const currentValue = sanitizedValue[token.cssVar] ?? fallback;
              const inputId = `shadcn-color-${token.cssVar.replace(/^--/, "").replace(/[^a-z0-9]+/gi, "-")}`;
              return (
                <div className="shadcn-color-picker-row" key={token.cssVar} data-testid={`shadcn-color-${token.cssVar}`}>
                  <label className="shadcn-color-picker-label" htmlFor={inputId}>
                    <span>{t(`theme.shadcnCustom.token.${token.cssVar}`, token.label)}</span>
                    <code>{token.cssVar}</code>
                  </label>
                  <div className="shadcn-color-picker-controls">
                    <input
                      aria-label={t("theme.shadcnCustom.colorInput", "Pick {{label}} color", { label: token.label })}
                      className="shadcn-color-picker-native"
                      type="color"
                      value={toColorInputValue(currentValue)}
                      onChange={(event) => updateToken(token.cssVar, event.currentTarget.value)}
                    />
                    <input
                      id={inputId}
                      aria-label={t("theme.shadcnCustom.hexInput", "{{label}} hex color", { label: token.label })}
                      className="input shadcn-color-picker-hex"
                      type="text"
                      inputMode="text"
                      spellCheck={false}
                      value={currentValue}
                      onChange={(event) => updateToken(token.cssVar, event.currentTarget.value)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
