import { useCallback, useEffect, useRef, useState } from "react";
import { useTouchActionGesture } from "../hooks/useTouchActionGesture";
import { scrollFocusedControlWithin } from "../utils/scrollFocusedControlWithin";
import { getKeyboardViewportFrame } from "../utils/mobileKeyboardViewport";
import "./OAuthManualCodeForm.css";

interface OAuthManualCodeFormProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  prompt: string;
  placeholder?: string;
  helpText?: string;
  disabled?: boolean;
  submitLabel?: string;
  "data-testid"?: string;
}

export function OAuthManualCodeForm({
  value,
  onChange,
  onSubmit,
  prompt,
  placeholder,
  helpText,
  disabled = false,
  submitLabel = "Submit code",
  "data-testid": testId,
}: OAuthManualCodeFormProps) {
  const formRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const [inputFocused, setInputFocused] = useState(false);
  // FNXC:OAuthManualCodeForm 2026-07-14-00:00: on mobile, tapping "Submit code"
  // while the textarea above still has focus can cause the browser to consume
  // that first tap solely to blur the textarea and dismiss the on-screen
  // keyboard, suppressing the resulting click — requiring a second, separate
  // tap to actually submit (FN-7953). Reuse the same gesture handling already
  // proven for the chat Send/Stop button (`useStandardChatActionGesture` in
  // StandardChatSurface.tsx) via the generic, non-chat-coupled
  // useTouchActionGesture() hook so a single tap submits immediately.
  const { beginTouchActionGesture, markHandledSendTouch, consumeHandledSendTouch } = useTouchActionGesture();

  const shouldUseMobileScrollAssist = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }

    const compactLayout = window.matchMedia("(max-width: 768px)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    return compactLayout || coarsePointer;
  }, []);


  /*
  FNXC:MobileKeyboardViewport 2026-09-17-14:23:
  FN-512: reveal the code field inside its own scroller, once, after the geometry update.

  The previous assist called `scrollIntoView({ block: "center" })` twice — in an animation frame and
  again 120ms later — which scrolled every ancestor including the document. The second, deferred call
  was the dangerous one: if the user moved to another field in the meantime it dragged THAT surface
  instead. The helper below refuses unless this input is still the focused, connected control, and
  the pending frame is cancelled on blur and unmount, so a transfer can never be overridden by the
  previous field's callback.
  */
  const pendingRevealRef = useRef<number | null>(null);
  const cancelPendingReveal = useCallback(() => {
    if (pendingRevealRef.current !== null) {
      cancelAnimationFrame(pendingRevealRef.current);
      pendingRevealRef.current = null;
    }
  }, []);

  const scrollInputIntoView = useCallback(() => {
    if (!shouldUseMobileScrollAssist()) {
      return;
    }

    cancelPendingReveal();
    pendingRevealRef.current = requestAnimationFrame(() => {
      pendingRevealRef.current = null;
      scrollFocusedControlWithin(inputRef.current, {
        visibleBottom: getKeyboardViewportFrame()?.visibleBottom,
      });
    });
  }, [cancelPendingReveal, shouldUseMobileScrollAssist]);

  useEffect(() => {
    if (!inputFocused || !shouldUseMobileScrollAssist()) {
      return;
    }

    scrollInputIntoView();

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const handleViewportShift = () => {
      if (document.activeElement === inputRef.current) {
        scrollInputIntoView();
      }
    };

    viewport.addEventListener("resize", handleViewportShift);
    viewport.addEventListener("scroll", handleViewportShift);

    return () => {
      viewport.removeEventListener("resize", handleViewportShift);
      viewport.removeEventListener("scroll", handleViewportShift);
      cancelPendingReveal();
    };
  }, [cancelPendingReveal, inputFocused, scrollInputIntoView, shouldUseMobileScrollAssist]);

  useEffect(() => cancelPendingReveal, [cancelPendingReveal]);

  return (
    <div ref={formRef} className="oauth-manual-code" data-testid={testId}>
      <p className="oauth-manual-code__prompt">{prompt}</p>
      <textarea
        ref={inputRef}
        className="form-input oauth-manual-code__input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={() => {
          setInputFocused(true);
          scrollInputIntoView();
        }}
        onBlur={() => setInputFocused(false)}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
        disabled={disabled}
      />
      <div className="oauth-manual-code__actions">
        <button
          type="button"
          className="btn btn-sm"
          onPointerDown={(event) => {
            if (event.pointerType && event.pointerType !== "mouse") {
              event.preventDefault();
              if (!beginTouchActionGesture()) return;
              markHandledSendTouch();
              if (!disabled) onSubmit();
            }
          }}
          onTouchStart={(event) => {
            event.preventDefault();
            if (!beginTouchActionGesture()) return;
            markHandledSendTouch();
            if (!disabled) onSubmit();
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (consumeHandledSendTouch()) return;
            if (!disabled) onSubmit();
          }}
          disabled={disabled}
          style={{ touchAction: "manipulation" }}
        >
          {submitLabel}
        </button>
      </div>
      {helpText && <p className="oauth-manual-code__help">{helpText}</p>}
    </div>
  );
}
