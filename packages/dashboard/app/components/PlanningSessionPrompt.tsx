import "./PlanningSessionPrompt.css";
import { useTranslation } from "react-i18next";
import { useAutosizeTextarea } from "../hooks/useAutosizeTextarea";

interface PlanningSessionPromptProps {
  prompt?: string;
  testId: string;
}

/**
 * FNXC:PlanningHistory 2026-08-28-03:34:
 * Planning Mode session history shows the operator's initiating prompt read-only next to the Q&A. Sessions without a saved prompt render nothing instead of leaving an empty history shell.
 */
export function PlanningSessionPrompt({ prompt, testId }: PlanningSessionPromptProps) {
  const { t } = useTranslation("app");
  const { ref } = useAutosizeTextarea({ value: prompt ?? "", minHeight: 64, maxHeight: 240 });

  if (!prompt?.trim()) {
    return null;
  }

  const label = t("planning.initialPromptLabel", "Prompt that started this session");

  return (
    <section className="planning-session-prompt">
      <span className="planning-session-prompt-label">{label}</span>
      <textarea
        ref={ref}
        className="planning-session-prompt-text"
        readOnly
        value={prompt}
        data-testid={testId}
        aria-label={label}
      />
    </section>
  );
}
