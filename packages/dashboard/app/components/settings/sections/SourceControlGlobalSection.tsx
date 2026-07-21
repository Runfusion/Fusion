import type { GlobalSettings } from "@fusion/core";
import { useTranslation } from "react-i18next";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsTextRow } from "../SettingsTextRow";
import { SettingsHelpTip } from "../SettingsHelpTip";
import type { SectionBaseProps } from "./context";

type GlobalSourceControlSettings = Pick<GlobalSettings, "gitlabEnabled" | "gitlabInstanceUrl" | "gitlabApiBaseUrl" | "gitlabAuthToken" | "gitlabAuthTokenType" | "reportRoadmapDedupeEnabled" | "reportRoadmapLabel" | "reportRoadmapRepo">;

export interface SourceControlGlobalSectionProps extends SectionBaseProps {
    globalSettings: GlobalSourceControlSettings | null;
    onGlobalSourceControlSettingsChange: (patch: Partial<GlobalSourceControlSettings>) => void;
    globalTrackingRepoOptions: TrackingRepoOption[];
    globalTrackingRepoLoading: boolean;
    globalTrackingRepoError: string | null;
}

/*
FNXC:SourceControl 2026-07-15-20:30:
The global GitLab fallbacks and the global default tracking repo moved out of "General · Global" into their own section, adjacent to "Source Control · Project" under the Integrations nav group. They are integrations with GitHub/GitLab, not general app preferences, and pairing the two scopes is what lets an operator see a global fallback and its project override without hunting across unrelated sections.
NOTE for future edits: `splitSettingsSave` (save-split.ts) gates these nine dual-scope keys on the ACTIVE SECTION ID — they route to the global patch only while this section is open, and to the project patch everywhere else. That guard names `source-control-global` literally. Renaming this section id without updating save-split.ts would silently write these global fallbacks into project settings.

FNXC:SettingsScope 2026-07-15-20:30:
No scope badge on any row here: all nine keys (`gitlabEnabled`, `gitlabInstanceUrl`, `gitlabApiBaseUrl`, `gitlabAuthTokenType`, `gitlabAuthToken`, `githubTrackingDefaultRepo`, `reportRoadmapDedupeEnabled`, `reportRoadmapLabel`, `reportRoadmapRepo`) are declared in BOTH `DEFAULT_GLOBAL_SETTINGS` and `DEFAULT_PROJECT_SETTINGS`, so no badge can state their scope honestly. The section name ("Source Control · Global") carries it, as does each label's "Global …" prefix.

FNXC:SettingsStyling 2026-07-15-20:30:
Plain label+control+help rows use the shared primitives; `gitlabAuthToken` uses the primitive's `type: "password"` (defaulting `autocomplete="off"`). The tracking-repo select and the disclosure chrome stay bespoke — they are custom widgets, not label+control+help rows.
*/
export function SourceControlGlobalSection({ form, setForm, globalSettings, onGlobalSourceControlSettingsChange, globalTrackingRepoOptions, globalTrackingRepoLoading, globalTrackingRepoError, }: SourceControlGlobalSectionProps) {
    const { t } = useTranslation("app");
    /*
    FNXC:GitLabEnablement 2026-07-04-00:00:
    The GitLab rows read from the SCOPED global values (`globalSettings`), not the merged `form`, so a project override never renders as the global fallback's value. `form` is only the fallback while the scoped fetch is in flight.
    */
    const globalSourceControl = globalSettings ?? form;
    const globalGitlab = globalSourceControl;
    return (<>
      {/* FNXC:SettingsHelp 2026-07-16-12:45: Inline help moved behind the shared "?" affordance beside the label — operator requirement: no inline description paragraphs in Settings. The bespoke TrackingRepoSelect widget is no obstacle: the tip belongs to the label line, not the control. */}
      <div className="form-group">
        <div className="settings-field-label-row">
          <label htmlFor="globalGithubTrackingDefaultRepo">{t("settings.globalGeneral.globalDefaultTrackingRepo", "Global default tracking repo")}</label>
          <SettingsHelpTip settingKey="globalGithubTrackingDefaultRepo">{t("settings.globalGeneral.projectsInheritThisValueWhenTheyDoNot", "Projects inherit this value when they do not set a project default tracking repo. No default — unset.")}</SettingsHelpTip>
        </div>
        <TrackingRepoSelect id="globalGithubTrackingDefaultRepo" ariaLabel="Global default tracking repo" value={form.githubTrackingDefaultRepo ?? ""} options={globalTrackingRepoOptions} loading={globalTrackingRepoLoading} error={globalTrackingRepoError ?? undefined} placeholder={t("settings.globalGeneral.ownerRepo", "owner/repo")} onChange={(nextValue) => setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))}/>
      </div>
      {/* FNXC:ReportPipeline 2026-07-18-20:45: FR-30 exposes global fallback values beside the global tracking repository so operators can configure a machine-wide public-roadmap policy without creating a project override. */}
      <SettingsToggleRow
        descriptor={{
          key: "reportRoadmapDedupeEnabled",
          label: t("settings.globalGeneral.reportRoadmapDedupeEnabled", "Global public-roadmap deduplication"),
          help: t("settings.globalGeneral.reportRoadmapDedupeEnabledHelp", "Fallback for projects that do not set a public-roadmap deduplication preference. No default — unset (projects default to enabled)."),
        }}
        value={globalSourceControl.reportRoadmapDedupeEnabled ?? true}
        onChange={(value) => onGlobalSourceControlSettingsChange({ reportRoadmapDedupeEnabled: value ?? undefined })}
      />
      <SettingsTextRow
        descriptor={{
          key: "reportRoadmapLabel",
          label: t("settings.globalGeneral.reportRoadmapLabel", "Global public roadmap label"),
          help: t("settings.globalGeneral.reportRoadmapLabelHelp", "Fallback label for open public-roadmap issues when a project does not set one. No default — unset (projects default to roadmap)."),
        }}
        value={globalSourceControl.reportRoadmapLabel ?? ""}
        onChange={(value) => onGlobalSourceControlSettingsChange({ reportRoadmapLabel: value || undefined })}
      />
      <SettingsTextRow
        descriptor={{
          key: "reportRoadmapRepo",
          label: t("settings.globalGeneral.reportRoadmapRepo", "Global public roadmap repository (optional)"),
          help: t("settings.globalGeneral.reportRoadmapRepoHelp", "Fallback GitHub owner/repository for public-roadmap issues. When unset, uses the tracking repository. No default — unset."),
          placeholder: "owner/repository",
        }}
        value={globalSourceControl.reportRoadmapRepo ?? ""}
        onChange={(value) => onGlobalSourceControlSettingsChange({ reportRoadmapRepo: value || undefined })}
      />
      {/*
        FNXC:GitLabEnablement 2026-07-02-00:00:
        FN-7453 adds a global GitLab enable fallback that can disable outbound GitLab HTTP API operations without deleting saved self-managed URL or token settings. Projects can override the enabled state when they need GitLab active while the global fallback is off.
      */}
      <details className="settings-gitlab-disclosure" data-testid="global-gitlab-configuration-disclosure">
        <summary>
          <span className="settings-gitlab-disclosure__title">{t("settings.globalGeneral.gitLabConfiguration", "GitLab Configuration")}</span>
          <label className="checkbox-label settings-gitlab-disclosure__toggle" htmlFor="globalGitlabEnabled" onClick={(event) => event.stopPropagation()}>
            <input id="globalGitlabEnabled" type="checkbox" checked={globalGitlab.gitlabEnabled !== false} onChange={(e) => onGlobalSourceControlSettingsChange({ gitlabEnabled: e.target.checked })}/>
            {t("settings.globalGeneral.enableGitLabIntegration", "Enable GitLab integration")}
          </label>
          {/*
          FNXC:SettingsHelp 2026-07-16-12:45:
          Inline disclosure hint moved behind the shared "?" affordance beside the summary title — operator requirement: no inline description paragraphs in Settings.
          The copy stays conditional on `gitlabEnabled` inside the tip. The wrapping span stops propagation, same as the summary's checkbox label, so opening the tip never toggles the disclosure.
          */}
          <span onClick={(event) => event.stopPropagation()}>
            <SettingsHelpTip settingKey="global-gitlab-configuration">{globalGitlab.gitlabEnabled === false ? t("settings.globalGeneral.gitLabDisabledHint", "GitLab API operations are disabled by global default. Saved URL and token fallbacks remain stored for re-enable.") : t("settings.globalGeneral.gitLabEnabledHint", "Global GitLab URL and token fallbacks apply to projects that do not set their own values. No default — unset (unset behaves as enabled until explicitly disabled).")}</SettingsHelpTip>
          </span>
        </summary>
        <div className="settings-gitlab-disclosure__body" aria-disabled={globalGitlab.gitlabEnabled === false}>
          <SettingsTextRow
            descriptor={{
              key: "gitlabInstanceUrl",
              label: t("settings.globalGeneral.gitLabInstanceUrl", "Global GitLab instance URL"),
              help: t("settings.globalGeneral.gitLabInstanceUrlHint", "Blank defaults to GitLab.com. Projects inherit this self-managed GitLab URL unless they set their own project value. No default — unset."),
              type: "url",
              placeholder: "https://gitlab.com",
              disabled: globalGitlab.gitlabEnabled === false,
            }}
            value={globalGitlab.gitlabInstanceUrl ?? ""}
            onChange={(v) => onGlobalSourceControlSettingsChange({ gitlabInstanceUrl: v || undefined })}
          />
          <SettingsTextRow
            descriptor={{
              key: "gitlabApiBaseUrl",
              label: t("settings.globalGeneral.gitLabApiBaseUrlOptional", "Global GitLab API base URL (optional / advanced)"),
              help: t("settings.globalGeneral.gitLabApiBaseUrlHint", "Blank derives <instance>/api/v4. Override only for self-managed GitLab API gateways that use a different absolute http:// or https:// URL. No default — unset."),
              type: "url",
              placeholder: "https://gitlab.com/api/v4",
              disabled: globalGitlab.gitlabEnabled === false,
            }}
            value={globalGitlab.gitlabApiBaseUrl ?? ""}
            onChange={(v) => onGlobalSourceControlSettingsChange({ gitlabApiBaseUrl: v || undefined })}
          />
          <SettingsSelectRow
            descriptor={{
              key: "gitlabAuthTokenType",
              label: t("settings.globalGeneral.gitLabTokenType", "Global GitLab token type"),
              help: t("settings.globalGeneral.gitLabTokenTypeHint", "No default — unset (the selector falls back to personal access token until you choose otherwise)."),
              disabled: globalGitlab.gitlabEnabled === false,
              options: [
                { value: "personal", label: t("settings.globalGeneral.gitLabPersonalAccessToken", "Personal access token") },
                { value: "project", label: t("settings.globalGeneral.gitLabProjectAccessToken", "Project access token") },
                { value: "group", label: t("settings.globalGeneral.gitLabGroupAccessToken", "Group access token") },
              ],
            }}
            value={globalGitlab.gitlabAuthTokenType ?? "personal"}
            onChange={(v) => onGlobalSourceControlSettingsChange({ gitlabAuthTokenType: v as "personal" | "project" | "group" })}
          />
          <SettingsTextRow
            descriptor={{
              key: "gitlabAuthToken",
              label: t("settings.globalGeneral.gitLabAccessToken", "Global GitLab access token"),
              help: t("settings.globalGeneral.gitLabAuthTokenHint", "Projects inherit this fallback only when they do not set a project GitLab token. Read-only operations need read_api or api; write actions need api; project/group tokens remain limited by resource membership. No default — unset."),
              type: "password",
              disabled: globalGitlab.gitlabEnabled === false,
            }}
            value={globalGitlab.gitlabAuthToken ?? ""}
            onChange={(v) => onGlobalSourceControlSettingsChange({ gitlabAuthToken: v || undefined })}
          />
        </div>
      </details>
    </>);
}
export default SourceControlGlobalSection;
