import "./UiStyleSelector.css";
import { useTranslation } from "react-i18next";
import { UI_STYLES, type UiStyle } from "@fusion/core";

/*
FNXC:UiStyleAxis 2026-09-15-00:20:
FN-399's second appearance axis gets ONE shared control, rendered by both entry points (Settings →
Appearance and the Command Center theme card) so the two can never drift into different option sets.

It is deliberately a plain radiogroup built from the existing control primitives rather than a second
dropdown: there are exactly two values, and both must be visible and keyboard-reachable at a glance.

The preview beside each option is LOCAL: it paints a miniature card/control/pill using the catalogue
tokens of that style and the CURRENT palette, so the operator sees the shape difference without the
selector touching `html`, issuing a request, or writing anything on hover or focus. Only an explicit
selection calls `onChange`.
*/

interface UiStyleSelectorProps {
  uiStyle: UiStyle;
  onChange: (style: UiStyle) => void;
  /** Optional id so a section heading can label the group. */
  id?: string;
}

const STYLE_COPY: Record<UiStyle, { labelKey: string; labelFallback: string; descriptionKey: string; descriptionFallback: string }> = {
  classic: {
    labelKey: "uiStyle.classic",
    labelFallback: "Actuel",
    descriptionKey: "uiStyle.classicDescription",
    descriptionFallback: "The familiar Fusion grammar, unchanged.",
  },
  clean: {
    labelKey: "uiStyle.clean",
    labelFallback: "Épuré",
    descriptionKey: "uiStyle.cleanDescription",
    descriptionFallback: "Tighter density, softer corners, quieter chrome.",
  },
};

export function UiStyleSelector({ uiStyle, onChange, id }: UiStyleSelectorProps) {
  const { t } = useTranslation("app");

  return (
    <div
      className="ui-style-selector"
      role="radiogroup"
      id={id}
      aria-label={t("uiStyle.label", "Interface style")}
    >
      {UI_STYLES.map((style) => {
        const copy = STYLE_COPY[style];
        const isSelected = uiStyle === style;
        return (
          <button
            key={style}
            type="button"
            role="radio"
            aria-checked={isSelected}
            className={`ui-style-option${isSelected ? " ui-style-option--selected" : ""}`}
            data-testid={`ui-style-option-${style}`}
            onClick={() => onChange(style)}
          >
            {/*
            Local shape preview: `data-ui-style` here scopes the catalogue to this subtree only, so the
            preview never changes the document or any other surface.
            */}
            <span className="ui-style-preview" data-ui-style={style} aria-hidden="true">
              <span className="ui-style-preview__card">
                <span className="ui-style-preview__line ui-style-preview__line--title" />
                <span className="ui-style-preview__line" />
              </span>
              <span className="ui-style-preview__row">
                <span className="ui-style-preview__pill" />
                <span className="ui-style-preview__control" />
              </span>
            </span>
            <span className="ui-style-option__text">
              <span className="ui-style-option__label">{t(copy.labelKey, copy.labelFallback)}</span>
              <span className="ui-style-option__description">{t(copy.descriptionKey, copy.descriptionFallback)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
