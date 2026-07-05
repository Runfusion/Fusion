/**
 * Prompts section (U9 / KTD-10).
 *
 * Project-group section wrapping AgentPromptsManager. Presentational: it reads
 * `agentPrompts`/`promptOverrides` off the modal form and relays edits back
 * through `setForm`; the shell keeps persistence + save-split.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { AgentPromptsConfig } from "@fusion/core";
import { AgentPromptsManager } from "../../AgentPromptsManager";
import { MovedSettingsStub } from "./MovedSettingsStub";
import type { SectionBaseProps } from "./context";

export interface PromptsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  /**
   * FNXC:Settings 2026-06-26-16:54:
   * Settings Prompts and Workflow Editor prompts are distinct editing surfaces. Settings owns agent role templates plus PromptKey segment overrides, while this callback links users to per-workflow, per-node prompt/gate prompts in the Workflow Editor.
   */
  onOpenWorkflowSettings?: () => void;
}

export function PromptsSection({ scopeBanner, form, setForm, onOpenWorkflowSettings }: PromptsSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.nav.prompts", "Prompts")}</h4>
      <div className="form-group">
        <small>
          {t(
            "settings.prompts.surfaceExplanation",
            "Use this section for agent role system prompt templates, role assignments, and global PromptKey segment overrides. Per-workflow step prompts for prompt and gate nodes are edited in the Workflow Editor. No default \u2014 unset (built-in role prompts apply until overridden).",
          )}
        </small>
      </div>
      <MovedSettingsStub
        message={t(
          "settings.prompts.workflowPromptsRedirect",
          "Per-workflow step prompts for prompt and gate nodes live in the Workflow Editor.",
        )}
        onOpenWorkflowSettings={onOpenWorkflowSettings}
      />
      <AgentPromptsManager
        value={form.agentPrompts}
        onChange={(agentPrompts: AgentPromptsConfig) => {
          setForm((f) => ({ ...f, agentPrompts }));
        }}
        promptOverrides={form.promptOverrides}
        onPromptOverridesChange={(overrides) => {
          setForm((f) => ({ ...f, promptOverrides: overrides }));
        }}
      />
    </>
  );
}

export default PromptsSection;
