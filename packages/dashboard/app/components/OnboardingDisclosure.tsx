import { useState } from "react";
import { ChevronRight } from "lucide-react";
import "./OnboardingDisclosure.css";

interface OnboardingDisclosureProps {
  summary: string;
  children: React.ReactNode;
  className?: string;
  onToggle?: (isOpen: boolean) => void;
  defaultOpen?: boolean;
}

export function OnboardingDisclosure({
  summary,
  children,
  className = "",
  onToggle,
  defaultOpen = false,
}: OnboardingDisclosureProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className={`onboarding-disclosure ${className}`.trim()}>
      <button
        className="onboarding-disclosure-trigger"
        onClick={() => {
          const next = !isOpen;
          setIsOpen(next);
          onToggle?.(next);
        }}
        aria-expanded={isOpen}
        type="button"
      >
        <ChevronRight size={14} className="onboarding-disclosure-chevron" aria-hidden="true" />
        <span>{summary}</span>
      </button>
      {isOpen ? <div className="onboarding-disclosure-content">{children}</div> : null}
    </div>
  );
}
