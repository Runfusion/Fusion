import { useCallback, useEffect, useRef, useState } from "react";
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

  const shouldUseMobileScrollAssist = useCallback(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }

    const compactLayout = window.matchMedia("(max-width: 768px)").matches;
    const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    return compactLayout || coarsePointer;
  }, []);

  const getScrollBehavior = useCallback((): ScrollBehavior => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return "auto";
    }

    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }, []);

  const scrollInputIntoView = useCallback(() => {
    if (!shouldUseMobileScrollAssist()) {
      return;
    }

    const target = inputRef.current ?? formRef.current;
    if (!target || typeof target.scrollIntoView !== "function") {
      return;
    }

    const behavior = getScrollBehavior();
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: "center", behavior, inline: "nearest" });
      // Mobile keyboards can shift viewport after focus; a short follow-up call
      // keeps the textarea visible when that deferred viewport resize completes.
      window.setTimeout(() => {
        target.scrollIntoView({ block: "center", behavior, inline: "nearest" });
      }, 120);
    });
  }, [getScrollBehavior, shouldUseMobileScrollAssist]);

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
    };
  }, [inputFocused, scrollInputIntoView, shouldUseMobileScrollAssist]);

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
          onClick={onSubmit}
          disabled={disabled}
        >
          {submitLabel}
        </button>
      </div>
      {helpText && <p className="oauth-manual-code__help">{helpText}</p>}
    </div>
  );
}
