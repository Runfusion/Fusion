import { useTranslation } from "react-i18next";
import { Terminal, Sparkles, ListPlus } from "lucide-react";
import type { AutomationStepType } from "@fusion/core";

interface StepTypeBadgeProps {
  type: AutomationStepType;
  size?: number;
}

export function StepTypeBadge({ type, size = 12 }: StepTypeBadgeProps) {
  const { t } = useTranslation("app");

  if (type === "command") {
    return (
      <span className="step-type-badge step-type-command" title={t("stepType.commandStepTitle", "Command step")}>
        <Terminal size={size} />
        <span>{t("stepType.command", "Command")}</span>
      </span>
    );
  }

  if (type === "create-task") {
    return (
      <span className="step-type-badge step-type-create-task" title={t("stepType.createTaskStepTitle", "Create Task step")}>
        <ListPlus size={size} />
        <span>{t("stepType.createTask", "Create Task")}</span>
      </span>
    );
  }

  return (
    <span className="step-type-badge step-type-ai-prompt" title={t("stepType.aiPromptStepTitle", "AI Prompt step")}>
      <Sparkles size={size} />
      <span>{t("stepType.aiPrompt", "AI Prompt")}</span>
    </span>
  );
}
