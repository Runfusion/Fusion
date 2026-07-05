import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { SectionBaseProps } from "./context";
import { ShortcutCaptureInput } from "./ShortcutCaptureInput";
import {
  DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS,
  SHORTCUT_CATEGORIES,
  describeShortcutValidation,
  getShortcutActionLabel,
  normalizeKeyboardShortcut,
  resolveDashboardKeyboardShortcuts,
  type DashboardShortcutAction,
} from "../../../utils/keyboardShortcuts";

export interface KeyboardShortcutsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
FN-7553 promotes keyboard shortcuts from two bare inputs buried in Global General to their own dedicated settings section, grouped by category (Communication/Workspace/Navigation/Tasks from SHORTCUT_CATEGORIES) with a press-to-record capture control per row. `dashboardKeyboardShortcuts` ownership moved here from `global-general` (save-split.ts GLOBAL_SECTION_KEYS + section-keys.ts) so exactly one section owns the key for save/reset.
*/
export function KeyboardShortcutsSection({ scopeBanner, form, setForm }: KeyboardShortcutsSectionProps) {
  const { t } = useTranslation("app");
  const shortcutValues = resolveDashboardKeyboardShortcuts(form.dashboardKeyboardShortcuts);
  const shortcutValidationMessage = describeShortcutValidation(shortcutValues);

  const updateShortcut = (action: DashboardShortcutAction, value: string) => setForm((f) => ({
    ...f,
    dashboardKeyboardShortcuts: {
      ...resolveDashboardKeyboardShortcuts(f.dashboardKeyboardShortcuts),
      [action]: value,
    },
  }));

  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.keyboardShortcuts.title", "Keyboard Shortcuts")}</h4>
      <p className="settings-description">{t("settings.keyboardShortcuts.hint", "Configure global dashboard shortcuts. Click Record and press a combination, or type one manually. Shortcuts are ignored while typing in inputs, editors, chat composers, and terminal fields. Leave blank to disable an action.")}</p>
      <div className="form-group settings-keyboard-shortcuts" data-testid="keyboard-shortcuts-settings">
        {SHORTCUT_CATEGORIES.map((category) => (
          <div className="shortcut-category" key={category.id}>
            <h5 className="settings-section-heading">{t(`settings.keyboardShortcuts.category.${category.id}`, category.label)}</h5>
            {category.actions.map((action) => {
              const parsed = normalizeKeyboardShortcut(shortcutValues[action]);
              const inputId = `dashboardShortcut-${action}`;
              const hintId = `${inputId}Hint`;
              return (
                <div className="shortcut-row" key={action}>
                  <label htmlFor={inputId}>{t(`settings.keyboardShortcuts.action.${action}`, getShortcutActionLabel(action))}</label>
                  <ShortcutCaptureInput
                    id={inputId}
                    value={shortcutValues[action]}
                    defaultValue={DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS[action]}
                    invalid={!parsed.valid}
                    describedById={hintId}
                    onChange={(value) => updateShortcut(action, value)}
                  />
                  <small id={hintId}>
                    {parsed.valid
                      ? t("settings.keyboardShortcuts.rowHint", "Default: {{default}}. Leave blank to disable.", { default: DEFAULT_DASHBOARD_KEYBOARD_SHORTCUTS[action] })
                      : parsed.error}
                  </small>
                </div>
              );
            })}
          </div>
        ))}
        {shortcutValidationMessage && (
          <small className="settings-description shortcut-conflict-banner" role="alert">{shortcutValidationMessage}</small>
        )}
      </div>
    </>
  );
}

export default KeyboardShortcutsSection;
