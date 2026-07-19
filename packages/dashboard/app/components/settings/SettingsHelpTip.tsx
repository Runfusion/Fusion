/**
 * SettingsHelpTip — the help affordance for a settings row.
 *
 * FNXC:SettingsHelp 2026-07-15-21:10:
 * Help copy moved off the row and behind a small "?" beside the label. Rendering every description inline turned dense sections into walls of prose — the median settings help string is ~100 characters and some run past 400 — which is what drove Merge to invent its own "More details" disclosure. One affordance in the shared row replaces that per-section improvisation, so help reads the same way everywhere.
 * The copy is NOT hidden: it stays in the DOM at all times so assistive tech and in-page find still reach it, and so the settings search index keeps matching on help text (`aria-describedby` points at it from the trigger). Only its VISUAL presentation is deferred.
 *
 * FNXC:SettingsHelp 2026-07-15-21:10:
 * Opens on click AND on hover, deliberately:
 *  - Click/tap is the baseline because it is the only interaction a touch device has. A hover-only tip is invisible on mobile.
 *  - Hover is layered on top for pointer devices only, via `@media (hover: hover) and (pointer: fine)`. Touch browsers emulate `:hover` on tap and leave it stuck until you tap elsewhere, so an unguarded `:hover` rule would strand an open bubble on mobile.
 *  - Focus opens it too, so the tip is reachable by keyboard without a mouse.
 * Open state is React's; hover/focus are CSS. They cannot disagree because CSS only ever adds reveal conditions — it never has to know the click state.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { HelpCircle } from "lucide-react";
import "./SettingsHelpTip.css";

export interface SettingsHelpTipProps {
  /**
   * Pre-translated help copy.
   *
   * FNXC:SettingsHelp 2026-07-15-21:40:
   * `ReactNode`, not `string`: a large share of settings help is not plain prose — it interleaves `t()` fragments with `<code>` (paths, cron shapes, CLI commands) or an external link. Those rows kept hand-rolled `<small>` help precisely because a single-string API could not carry them, which is what split the section into "rows with a help icon" and "rows with a paragraph".
   * Accepting nodes is what lets every row use the same affordance without rewording operator-facing copy.
   */
  children: ReactNode;
  /** Stable id for the setting, used to build the bubble's element id. */
  settingKey?: string;
}

/*
FNXC:SettingsHelp 2026-07-15-22:25:
At most one tip is open at a time, enforced by a broadcast rather than by the outside-pointerdown handler alone.
Outside-pointerdown covers tapping, but it is not the only way a tip opens: pressing Enter/Space on a focused trigger fires `click` with NO pointer event, so a keyboard operator moving between two tips would leave the first bubble open underneath the second. Observed as two overlapping bubbles on a 390px viewport.
A document-level event keeps the tips decoupled — they never need to know about each other or share a context — and costs one listener per tip.
*/
const SETTINGS_HELP_OPEN_EVENT = "fusion:settings-help-open";

export function SettingsHelpTip({ children, settingKey }: SettingsHelpTipProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const reactId = useId();
  const helpId = `settings-help-${settingKey ?? reactId}`;

  // Close when any other tip announces that it opened.
  useEffect(() => {
    const onOtherOpened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== helpId) setOpen(false);
    };
    document.addEventListener(SETTINGS_HELP_OPEN_EVENT, onOtherOpened);
    return () => document.removeEventListener(SETTINGS_HELP_OPEN_EVENT, onOtherOpened);
  }, [helpId]);

  const toggle = () => {
    setOpen((wasOpen) => {
      const next = !wasOpen;
      if (next) {
        document.dispatchEvent(new CustomEvent(SETTINGS_HELP_OPEN_EVENT, { detail: helpId }));
      }
      return next;
    });
  };

  /*
  FNXC:SettingsHelp 2026-07-15-21:10:
  A tip closes on outside pointer-down and on Escape. Without this, tapping another row on mobile leaves the previous bubble open on top of it — there is no pointer-leave on touch to close it.
  `pointerdown` rather than `click` so the bubble is gone before the next control receives its press, and it never swallows that first tap.
  */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  return (
    <span className="settings-help" data-open={open ? "true" : "false"} ref={wrapRef}>
      <button
        type="button"
        className="settings-help-trigger"
        aria-label={t("settings.help.show", "Show help")}
        aria-expanded={open}
        aria-describedby={helpId}
        data-testid={settingKey ? `settings-help-${settingKey}` : undefined}
        onClick={toggle}
      >
        <HelpCircle size={13} aria-hidden />
      </button>
      {/*
      FNXC:SettingsHelp 2026-07-15-21:10:
      `role="note"`, not `role="tooltip"`: a tooltip is expected to be transient and label-like, while this is a persistent description the operator can open and read. It is also always rendered — CSS hides it visually — so `aria-describedby` above resolves whether or not the bubble is on screen.
      */}
      <span id={helpId} role="note" className="settings-help-bubble">
        {children}
      </span>
    </span>
  );
}

export default SettingsHelpTip;
