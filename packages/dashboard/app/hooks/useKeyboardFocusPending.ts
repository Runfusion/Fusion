import { useEffect, useState } from "react";
import {
  ZOOMED_SCALE_THRESHOLD,
  isKeyboardEditableElement,
} from "../utils/mobileKeyboardViewport";

/*
FNXC:MobileKeyboardViewport 2026-09-17-14:23:
FN-512 makes this hook share the canonical editable predicate and zoom threshold with keyboard
detection, so a non-text control can never hide mobile chrome and the two cannot drift apart.

It deliberately keeps its OWN direct listeners rather than subscribing to the shared frame: this
flag must release the instant focus leaves an editor, and a blur frequently changes no geometry at
all. A frame-change subscription would be deduplicated away and leave mobile chrome stuck
keyboard-up for the whole dismissal animation.
*/

/**
 * Reports the focus transition that precedes a settled visual-viewport keyboard sample.
 * Released immediately on blur so composers and the executor footer are never stuck keyboard-up.
 */
export function useKeyboardFocusPending(enabled: boolean): boolean {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") {
      setPending(false);
      return;
    }

    const evaluate = () => {
      const scale = window.visualViewport?.scale ?? 1;
      setPending(
        scale <= ZOOMED_SCALE_THRESHOLD
        && isKeyboardEditableElement(document.activeElement),
      );
    };

    const viewport = window.visualViewport;
    window.addEventListener("focusin", evaluate);
    window.addEventListener("focusout", evaluate);
    viewport?.addEventListener("resize", evaluate);
    viewport?.addEventListener("scroll", evaluate);
    evaluate();

    return () => {
      window.removeEventListener("focusin", evaluate);
      window.removeEventListener("focusout", evaluate);
      viewport?.removeEventListener("resize", evaluate);
      viewport?.removeEventListener("scroll", evaluate);
      setPending(false);
    };
  }, [enabled]);

  return pending;
}
