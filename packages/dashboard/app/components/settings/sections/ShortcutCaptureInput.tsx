import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { normalizeKeyboardShortcut } from "../../../utils/keyboardShortcuts";

export interface ShortcutCaptureInputProps {
  id: string;
  value: string;
  defaultValue: string;
  invalid: boolean;
  describedById: string;
  onChange: (value: string) => void;
}

/*
FNXC:DashboardShortcuts 2026-07-04-00:00:
FN-7553 replaces "type the exact string" shortcut inputs with press-to-record capture. Clicking Record arms a one-shot document keydown listener that normalizes the next combination via the shared `normalizeKeyboardShortcut` parser (same parser the runtime hook and validation use, so what you record is guaranteed to match at runtime). Manual typing remains supported as a fallback for operators who already know the syntax. Escape while recording CANCELS recording rather than binding Escape \u2014 this keeps Escape permanently reserved for the dashboard's topmost-popup-close shortcut and gives the operator an obvious way to back out of recording without disabling the field. The recording surface carries `data-shortcuts-ignore="true"` so the global dashboard listener's editable-target guard always excludes it while focused/recording.
*/
export function ShortcutCaptureInput({ id, value, defaultValue, invalid, describedById, onChange }: ShortcutCaptureInputProps) {
  const { t } = useTranslation("app");
  const [recording, setRecording] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const stopRecording = useCallback(() => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    setRecording(false);
  }, []);

  /*
  FNXC:DashboardShortcuts 2026-07-04-01:30:
  Recording arms a capture-phase document keydown listener that unconditionally
  preventDefault/stopPropagation's the next keydown anywhere in the app. If the
  operator closes Settings (or navigates to a different settings section) while
  "Record" is still armed — without pressing Escape or a key — this component
  unmounts but the listener previously stayed attached forever, hijacking the
  very next keystroke app-wide. Clean up on unmount so an abandoned recording
  session cannot leak a stray global listener.
  */
  useEffect(() => () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
  }, []);

  const startRecording = useCallback(() => {
    if (typeof document === "undefined") return;
    setRecording(true);

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        stopRecording();
        return;
      }

      // A bare modifier keydown (e.g. just pressing Ctrl) isn't a complete
      // combination yet; keep recording until a non-modifier key arrives.
      if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return;

      const parts: string[] = [];
      if (event.ctrlKey) parts.push("Ctrl");
      if (event.altKey) parts.push("Alt");
      if (event.shiftKey) parts.push("Shift");
      if (event.metaKey) parts.push("Meta");
      parts.push(event.key === " " ? "Space" : event.key);
      const captured = normalizeKeyboardShortcut(parts.join("+"));
      if (captured.valid && !captured.disabled) {
        onChange(captured.normalized);
      }
      stopRecording();
    };

    document.addEventListener("keydown", handleKeyDown, { capture: true });
    cleanupRef.current = () => document.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [onChange, stopRecording]);

  return (
    <div className="shortcut-capture" data-shortcuts-ignore="true">
      <input
        id={id}
        className={`input shortcut-capture__input${invalid ? " shortcut-capture__input--invalid" : ""}`}
        value={recording ? t("settings.keyboardShortcuts.recording", "Press keys… (Esc to cancel)") : value}
        placeholder={defaultValue}
        readOnly={recording}
        aria-invalid={invalid || undefined}
        aria-describedby={describedById}
        data-shortcuts-ignore="true"
        onFocus={(event) => {
          if (recording) event.currentTarget.blur();
        }}
        onChange={(event) => onChange(event.target.value)}
      />
      {/*
      FNXC:DashboardShortcuts 2026-07-05-00:00:
      Record/Clear are TEXT-labeled buttons ("Record"/"Recording…"/"Clear"), not icon-only
      controls. `btn-icon` sets `line-height: 0` and a mobile 36px square meant for SVG-only
      buttons — applying it here clipped the label's line box and, at mobile widths, forced
      "Recording…" to overflow the fixed square and overlap the Clear button/input
      (reported via screenshot IMG_1305). Use `btn-sm` instead so labels render on a normal
      line-height with content-sized width; `.shortcut-capture` locks these buttons with
      `flex-shrink: 0` so they never collide with the input or each other.
      */}
      <button
        type="button"
        className={`btn btn-sm shortcut-capture__record${recording ? " shortcut-capture__record--active" : ""}`}
        aria-pressed={recording}
        title={recording ? t("settings.keyboardShortcuts.recordingTitle", "Recording… press Escape to cancel") : t("settings.keyboardShortcuts.recordTitle", "Record a new shortcut")}
        onClick={() => (recording ? stopRecording() : startRecording())}
      >
        {recording ? t("settings.keyboardShortcuts.recordingLabel", "Recording…") : t("settings.keyboardShortcuts.recordLabel", "Record")}
      </button>
      <button
        type="button"
        className="btn btn-sm shortcut-capture__clear"
        title={t("settings.keyboardShortcuts.clearTitle", "Disable this shortcut")}
        onClick={() => {
          if (recording) stopRecording();
          onChange("");
        }}
      >
        {t("settings.keyboardShortcuts.clearLabel", "Clear")}
      </button>
    </div>
  );
}

export default ShortcutCaptureInput;
