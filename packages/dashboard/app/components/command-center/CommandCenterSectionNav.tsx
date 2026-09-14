import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import "./CommandCenterSectionNav.css";

export interface CommandCenterSection {
  id: string;
  label: string;
}

export interface CommandCenterSectionNavProps {
  sections: CommandCenterSection[];
  activeId: string;
  onSelect: (id: string) => void;
  /** Full-height section rail used by the shared dashboard view sidebar. */
  variant?: "dropdown" | "rail";
}

/*
FNXC:StandardizedViewLayout 2026-09-13-21:43:
Command Center keeps useSubViews as the sole section-order and feature-gating authority. The same component presents those sections as the shared full-height rail in the dashboard view and retains the compact dropdown fallback for constrained legacy hosts.
*/
export function CommandCenterSectionNav({ sections, activeId, onSelect, variant = "dropdown" }: CommandCenterSectionNavProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const [focusActiveOnOpen, setFocusActiveOnOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const activeIndex = Math.max(0, sections.findIndex((section) => section.id === activeId));
  const activeLabel = sections[activeIndex]?.label ?? activeId;
  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) close(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [close, open]);

  useEffect(() => {
    if (open && focusActiveOnOpen) {
      optionRefs.current[activeIndex]?.focus();
      setFocusActiveOnOpen(false);
    }
  }, [activeIndex, focusActiveOnOpen, open]);

  const select = useCallback((id: string) => {
    onSelect(id);
    close();
  }, [close, onSelect]);

  const focusOption = (index: number) => {
    optionRefs.current[(index + sections.length) % sections.length]?.focus();
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const focusedIndex = optionRefs.current.findIndex((option) => option === document.activeElement);
    const index = focusedIndex === -1 ? activeIndex : focusedIndex;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusOption(index + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusOption(index - 1);
        break;
      case "Home":
        event.preventDefault();
        focusOption(0);
        break;
      case "End":
        event.preventDefault();
        focusOption(sections.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (sections[index]) select(sections[index].id);
        break;
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  };

  const openFromKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      setFocusActiveOnOpen(true);
      setOpen(true);
    }
  };

  if (variant === "rail") {
    return (
      <nav className="cc-section-nav cc-section-nav--rail" aria-label={t("commandCenter.tablistLabel", "Dashboard sections")}>
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className={`cc-section-nav-option${section.id === activeId ? " active" : ""}`}
            aria-current={section.id === activeId ? "page" : undefined}
            data-testid={`command-center-section-option-${section.id}`}
            onClick={() => onSelect(section.id)}
          >
            {section.label}
          </button>
        ))}
      </nav>
    );
  }

  return (
    <div className="cc-section-nav">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-sm cc-section-nav-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("commandCenter.tablistLabel", "Dashboard sections")}
        data-testid="command-center-section-nav-trigger"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={openFromKeyboard}
      >
        <span>{activeLabel}</span>
        <ChevronDown />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="cc-section-nav-menu"
          role="listbox"
          aria-label={t("commandCenter.tablistLabel", "Dashboard sections")}
          data-testid="command-center-section-nav-menu"
          onKeyDown={onMenuKeyDown}
        >
          {sections.map((section, index) => (
            <button
              key={section.id}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="option"
              aria-selected={section.id === activeId}
              className={`cc-section-nav-option${section.id === activeId ? " active" : ""}`}
              data-testid={`command-center-section-option-${section.id}`}
              onClick={() => select(section.id)}
            >
              {section.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
