/**
 * Prompts section (U9 / KTD-10).
 *
 * Project-group section wrapping AgentPromptsManager. Presentational: it reads
 * `agentPrompts`/`promptOverrides` off the modal form and relays edits back
 * through `setForm`; the shell keeps persistence + save-split.
 */
import { useTranslation } from "react-i18next";
import type { AgentPromptsConfig } from "@fusion/core";
import { AgentPromptsManager } from "../../AgentPromptsManager";
import { SettingsHelpTip } from "../SettingsHelpTip";
import { MovedSettingsStub } from "./MovedSettingsStub";
import type { SectionBaseProps } from "./context";

export interface PromptsSectionProps extends SectionBaseProps {
  /**
   * FNXC:Settings 2026-06-26-16:54:
   * Settings Prompts and Workflow Editor prompts are distinct editing surfaces. Settings owns agent role templates plus PromptKey segment overrides, while this callback links users to per-workflow, per-node prompt/gate prompts in the Workflow Editor.
   */
  onOpenWorkflowSettings?: () => void;
}

export function PromptsSection({ form, setForm, onOpenWorkflowSettings }: PromptsSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      {/*
      FNXC:SettingsHelp 2026-07-16-12:45:
      Section intro moved behind the shared "?" beside the heading - operator requirement: no inline description paragraphs in Settings.
      */}
      <div className="settings-field-label-row">
        <h4 className="settings-section-heading">{t("settings.nav.prompts", "Prompts")}</h4>
        <SettingsHelpTip settingKey="prompts-section">
          {t(
            "settings.prompts.surfaceExplanation",
            "Use this section for agent role system prompt templates, role assignments, and global PromptKey segment overrides. Per-workflow step prompts for prompt and gate nodes are edited in the Workflow Editor. No default \u2014 unset (built-in role prompts apply until overridden).",
          )}
        </SettingsHelpTip>
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
