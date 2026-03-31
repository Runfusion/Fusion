import { Terminal, Sparkles } from "lucide-react";
import type { AutomationStepType } from "@kb/core";

interface StepTypeBadgeProps {
  type: AutomationStepType;
  size?: number;
}

export function StepTypeBadge({ type, size = 12 }: StepTypeBadgeProps) {
  if (type === "command") {
    return (
      <span className="step-type-badge step-type-command" title="Command step">
        <Terminal size={size} />
        <span>Command</span>
      </span>
    );
  }

  return (
    <span className="step-type-badge step-type-ai-prompt" title="AI Prompt step">
      <Sparkles size={size} />
      <span>AI Prompt</span>
    </span>
  );
}
