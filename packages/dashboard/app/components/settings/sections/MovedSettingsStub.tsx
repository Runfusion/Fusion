/**
 * Redirect stub for moved settings (U9 / KTD-5, R10).
 *
 * The step-execution, review/approval, and per-phase model-lane settings that
 * used to live inline in the Project group's Scheduling / Merge / Project Models
 * sections were hard-moved (U4) onto the workflow settings mechanism — they no
 * longer exist as project settings keys and must never be renderable or savable
 * from this modal again. Where a section lost that content, this shared stub
 * renders in its place: a short explanation plus a button that closes the
 * Settings modal and opens the workflow node editor with its Settings panel
 * pre-selected (`initialPanel="settings"`) for the project's default workflow.
 *
 * Per KTD-5's one-release rule, sections whose content moved entirely keep their
 * nav entry this release showing only this stub.
 */
import { useTranslation } from "react-i18next";
import "./MovedSettingsStub.css";

export interface MovedSettingsStubProps {
  /** Localized lead sentence describing what moved. */
  message: string;
  /**
   * Closes the Settings modal and opens the workflow editor on its Settings
   * panel for the project's default workflow. May be undefined when no host
   * wiring is available (e.g. isolated rendering) — the button is then disabled.
   */
  onOpenWorkflowSettings?: () => void;
}

export function MovedSettingsStub({ message, onOpenWorkflowSettings }: MovedSettingsStubProps) {
  const { t } = useTranslation("app");
  return (
    <div className="settings-moved-stub" role="note">
      <p className="settings-moved-stub__message">{message}</p>
      <button
        type="button"
        className="settings-moved-stub__action"
        onClick={onOpenWorkflowSettings}
        disabled={!onOpenWorkflowSettings}
      >
        {t("settings.movedStub.openWorkflowSettings", "Open workflow settings")}
      </button>
    </div>
  );
}

export default MovedSettingsStub;
