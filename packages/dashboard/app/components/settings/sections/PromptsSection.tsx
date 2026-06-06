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
import type { SectionBaseProps } from "./context";

export interface PromptsSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
}

export function PromptsSection({ scopeBanner, form, setForm }: PromptsSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.nav.prompts", "Prompts")}</h4>
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
