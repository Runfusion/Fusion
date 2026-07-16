import { useTranslation } from "react-i18next";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { SectionBaseProps } from "./context";

export interface SourceControlSectionProps extends SectionBaseProps {
    projectTrackingRepoOptions: TrackingRepoOption[];
    projectTrackingRepoLoading: boolean;
    projectTrackingRepoError: string | null;
}

/*
FNXC:SourceControl 2026-07-15-20:30:
Project source-control settings were split across two sections that neither named nor contained the topic: GitHub Tracking + the GitLab URL disclosure lived in "General · Project", while GitHub/GitLab authentication lived in "Merge". An operator wiring up GitLab had to visit both, and `gitlabEnabled` was writable from BOTH — two enable toggles for one key, so the last section saved won. This section is the single project-scoped home for GitHub/GitLab, which is what removes that duplicate rather than merely hiding it.
The GitLab URL block and the GitLab auth block are now ONE disclosure with ONE `gitlabEnabled` toggle in its summary. Both blocks were already governed by that same key (FN-7453), so merging them costs no behavior — the two toggles were always writing the same setting.

FNXC:SettingsScope 2026-07-15-20:30:
Rows on `gitlabEnabled`, `gitlabInstanceUrl`, `gitlabApiBaseUrl`, `gitlabAuthTokenType`, `gitlabAuthToken`, and `githubTrackingDefaultRepo` carry NO scope badge: every one of them is declared in BOTH `DEFAULT_GLOBAL_SETTINGS` and `DEFAULT_PROJECT_SETTINGS`, so a "project" badge would assert a scope the schema does not support. The section name ("Source Control · Project") carries the scope instead. The GitHub-only keys ARE project-only in the schema, so they keep their badge.

FNXC:SettingsStyling 2026-07-15-20:30:
Plain label+control+help rows render through the shared settings primitives. `githubAuthToken`/`gitlabAuthToken` use the primitive's `type: "password"` (which defaults `autocomplete="off"`) — previously these rows had to stay hand-rolled to avoid SettingsTextRow's hardcoded `type="text"` rendering a stored token in plain sight.
Rows that stay bespoke: the tracking-mode select (its help is TWO `<small>` blocks, the second conditional on unrelated model settings — a descriptor `help` is one string), the tracking-repo select (custom widget), and the disclosure chrome itself.
*/
export function SourceControlSection({ form, setForm, projectTrackingRepoOptions, projectTrackingRepoLoading, projectTrackingRepoError, }: SourceControlSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      <h4 className="settings-section-heading">{t("settings.general.gitHubTracking", "GitHub Tracking")}</h4>
      <div className="form-group">
        <label htmlFor="githubTrackingMode">{t("settings.general.defaultTrackingModeForNewTasks", "Default tracking mode for new tasks")}</label>
        <select id="githubTrackingMode" className="select" value={form.githubTrackingEnabledByDefault ? "new-tasks" : "off"} onChange={(e) => setForm((f) => ({
            ...f,
            githubTrackingEnabledByDefault: e.target.value === "new-tasks",
        }))}>
          <option value="off">{t("settings.general.offDefault", "Off (default)")}</option>
          <option value="new-tasks">{t("settings.general.onForNewTasks", "On for new tasks")}</option>
        </select>
        <small>{t("settings.general.controlsWhetherNewlyCreatedTasksHaveGitHubIssue", " Controls whether newly created tasks have GitHub issue tracking enabled by default. Individual tasks can still override this from the task detail modal. ")}</small>
        {/*
          FNXC:SettingsGeneral 2026-06-22-03:20:
          Tracking-issue helper copy. The FN-6771 JSX→t() extraction left a raw HTML
          entity ("&apos;") in this default string. As a t() argument the string is a
          plain JS value (not JSX-decoded), so the entity rendered verbatim as the
          literal "&apos;" instead of an apostrophe. Use a real apostrophe so the copy
          reads correctly in both modal and embedded presentations.
        */}
        <small>{t("settings.general.trackingIssuesUseThisTaskAposSTitle", " Tracking issues use this task's title. If a task has no title yet, Fusion can summarize its description using the title summarization model in Project Models. ")}{!form.autoSummarizeTitles && !form.useAiMergeCommitSummary && !form.githubTrackingEnabledByDefault
            ? t("settings.general.enableSummarizationInProjectModelsToConfigureThatModel", " Enable summarization in Project Models to configure that model.")
            : ""}
        </small>
      </div>
      {/*
        FNXC:GithubImportTracking 2026-07-01-00:00:
        This checkbox is project-scoped and import-specific: operators can link imported GitHub issues to GitHub tracking without turning tracking on for every new task.
      */}
      <SettingsToggleRow
        descriptor={{
          key: "githubLinkImportedIssuesToTracking",
          label: t("settings.general.alwaysLinkImportedGitHubIssuesToTracking", " Always link imported GitHub issues to GitHub tracking "),
          help: t("settings.general.whenEnabledImportedGitHubIssuesUseTheirSource", "When enabled, GitHub issue imports become tracked tasks that adopt the source issue. This does not turn GitHub tracking on for ordinary new tasks. Default: disabled."),
          scope: "project",
        }}
        value={form.githubLinkImportedIssuesToTracking === true}
        onChange={(v) => setForm((f) => ({ ...f, githubLinkImportedIssuesToTracking: v === true }))}
      />
      <div className="form-group">
        <label htmlFor="projectGithubTrackingDefaultRepoGeneral">{t("settings.general.projectDefaultTrackingRepo", "Project default tracking repo")}</label>
        <TrackingRepoSelect id="projectGithubTrackingDefaultRepoGeneral" ariaLabel="Project default tracking repo" value={form.githubTrackingDefaultRepo ?? ""} options={projectTrackingRepoOptions} loading={projectTrackingRepoLoading} error={projectTrackingRepoError ?? undefined} placeholder={t("settings.general.ownerRepo", "owner/repo")} onChange={(nextValue) => setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))}/>
        <small>{t("settings.general.defaultRepoUsedWhenCreatingGitHubIssuesFor", "Default repo used when creating GitHub issues for tracked tasks. Falls back to the global default if blank.")}</small>
      </div>
      <SettingsToggleRow
        descriptor={{
          key: "githubTrackingDedupEnabled",
          label: t("settings.general.searchTheTrackingRepoForLikelyDuplicatesBefore", " Search the tracking repo for likely duplicates before opening a new issue "),
          help: t("settings.general.whenEnabledFusionChecksOpenAndClosedIssues", " When enabled, Fusion checks open and closed issues in the target repo for likely duplicates (using File Scope paths and key symptoms) before creating a new tracking issue. Uncheck to always create a new issue. Default: enabled. "),
          scope: "project",
        }}
        value={form.githubTrackingDedupEnabled !== false}
        onChange={(v) => setForm((f) => ({ ...f, githubTrackingDedupEnabled: v === true }))}
      />
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.merge.gitHubAuthentication", "GitHub Authentication")}</h4>
      {/* FNXC:SettingsStyling 2026-07-15-17:35: No `help` — this row carried no help copy before the migration, and inventing one would be new operator-facing text rather than a restyle. */}
      <SettingsSelectRow
        descriptor={{
          key: "githubAuthMode",
          label: t("settings.merge.gitHubAuthMode", "GitHub auth mode"),
          scope: "project",
          options: [
            { value: "gh-cli", label: t("settings.merge.gitHubCLIGhAuth", "GitHub CLI (gh auth) (default)") },
            { value: "token", label: t("settings.merge.personalAccessToken", "Personal access token") },
          ],
        }}
        value={form.githubAuthMode ?? "gh-cli"}
        onChange={(v) => setForm((f) => ({ ...f, githubAuthMode: v as "gh-cli" | "token" }))}
      />
      {(form.githubAuthMode ?? "gh-cli") === "token" && (
        <SettingsTextRow
          descriptor={{
            key: "githubAuthToken",
            label: t("settings.merge.gitHubPersonalAccessToken", "GitHub personal access token"),
            help: t("settings.merge.githubAuthTokenHint", "No default — unset."),
            scope: "project",
            type: "password",
          }}
          value={form.githubAuthToken ?? ""}
          onChange={(v) => setForm((f) => ({ ...f, githubAuthToken: v || undefined }))}
        />
      )}
      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.general.gitLabConfiguration", "GitLab Configuration")}</h4>
      {/*
        FNXC:GitLabEnablement 2026-07-02-00:00:
        FN-7453 keeps saved GitLab URL settings separate from the active integration switch. The disclosure is collapsed by default to reduce Settings noise; the summary toggle remains reachable without expanding advanced self-managed URL fields.

        FNXC:SourceControl 2026-07-15-20:30:
        This is the ONLY `gitlabEnabled` control in the project scope. The Merge section rendered a second one (id `mergeGitlabEnabled`) governing the same key from a different screen; both are now this one toggle.
      */}
      <details className="settings-gitlab-disclosure" data-testid="project-gitlab-configuration-disclosure">
        <summary>
          <span className="settings-gitlab-disclosure__title">{t("settings.general.gitLabConfiguration", "GitLab Configuration")}</span>
          <label className="checkbox-label settings-gitlab-disclosure__toggle" htmlFor="gitlabEnabled" onClick={(event) => event.stopPropagation()}>
            <input id="gitlabEnabled" type="checkbox" checked={form.gitlabEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, gitlabEnabled: e.target.checked }))}/>
            {t("settings.general.enableGitLabIntegration", "Enable GitLab integration")}
          </label>
        </summary>
        <small className="settings-description">{form.gitlabEnabled === false ? t("settings.general.gitLabDisabledHint", "GitLab API imports, comments, close/reopen, and refresh operations are disabled. Saved URLs and tokens remain stored for re-enable.") : t("settings.general.gitLabEnabledHint", "Configure GitLab.com or self-managed GitLab URLs. Blank values inherit global fallbacks and then GitLab.com. No default — unset (unset behaves as enabled until explicitly disabled).")}</small>
        <div className="settings-gitlab-disclosure__body" aria-disabled={form.gitlabEnabled === false}>
          <SettingsTextRow
            descriptor={{
              key: "gitlabInstanceUrl",
              label: t("settings.general.gitLabInstanceUrl", "GitLab instance URL"),
              help: t("settings.general.gitLabInstanceUrlHint", "Blank uses GitLab.com or the global default. Set an absolute http:// or https:// URL for self-managed GitLab, such as https://gitlab.example.com/gitlab."),
              type: "url",
              placeholder: "https://gitlab.com",
              disabled: form.gitlabEnabled === false,
            }}
            value={form.gitlabInstanceUrl ?? ""}
            onChange={(v) => setForm((f) => ({ ...f, gitlabInstanceUrl: v || undefined }))}
          />
          <SettingsTextRow
            descriptor={{
              key: "gitlabApiBaseUrl",
              label: t("settings.general.gitLabApiBaseUrlOptional", "GitLab API base URL (optional / advanced)"),
              help: t("settings.general.gitLabApiBaseUrlHint", "Blank derives <instance>/api/v4. Override only when a self-managed GitLab API is served from a different absolute http:// or https:// URL."),
              type: "url",
              placeholder: "https://gitlab.com/api/v4",
              disabled: form.gitlabEnabled === false,
            }}
            value={form.gitlabApiBaseUrl ?? ""}
            onChange={(v) => setForm((f) => ({ ...f, gitlabApiBaseUrl: v || undefined }))}
          />
          {/*
            FNXC:GitLabEnablement 2026-07-02-00:00:
            FN-7453 makes project GitLab auth controls collapsible and governed by the same project-scoped enable switch as URL settings. Disabling GitLab preserves saved tokens but blocks outbound API side effects before auth validation.

            FNXC:SourceControl 2026-07-15-20:30:
            The auth block keeps BOTH its own heading and its own enable/disable hint after the merge: the URL hint above describes what disabling does to imports/refresh, while this one describes the PRIVATE-TOKEN auth contract and the token's global fallback. Neither string is a paraphrase of the other, so collapsing them into one would delete operator-facing copy rather than deduplicate it.
          */}
          <h5 className="settings-section-heading">{t("settings.merge.gitLabAuthentication", "GitLab Authentication")}</h5>
          <small className="settings-description">{form.gitlabEnabled === false ? t("settings.merge.gitLabDisabledHint", "GitLab comments, close/reopen, import fetches, and refresh operations are disabled. Saved tokens remain stored for re-enable.") : t("settings.merge.gitLabAuthDetails", "Fusion uses GitLab REST API token authentication with the PRIVATE-TOKEN header. Leave the token blank to clear the project override and fall back to a configured global GitLab token or GITLAB_TOKEN where available. No default — unset (unset behaves as enabled until explicitly disabled).")}</small>
          <SettingsSelectRow
            descriptor={{
              key: "gitlabAuthTokenType",
              label: t("settings.merge.gitLabTokenType", "GitLab token type"),
              disabled: form.gitlabEnabled === false,
              options: [
                { value: "personal", label: t("settings.merge.gitLabPersonalAccessToken", "Personal access token (default)") },
                { value: "project", label: t("settings.merge.gitLabProjectAccessToken", "Project access token") },
                { value: "group", label: t("settings.merge.gitLabGroupAccessToken", "Group access token") },
              ],
            }}
            value={form.gitlabAuthTokenType ?? "personal"}
            onChange={(v) => setForm((f) => ({ ...f, gitlabAuthTokenType: v as "personal" | "project" | "group" }))}
          />
          <SettingsTextRow
            descriptor={{
              key: "gitlabAuthToken",
              label: t("settings.merge.gitLabAccessToken", "GitLab access token"),
              help: t("settings.merge.gitLabAuthTokenHint", "Read-only GitLab operations need read_api or api. Future write actions such as comments and auto-close need api. Project and group tokens are limited to their associated resource and role membership. No default — unset."),
              type: "password",
              disabled: form.gitlabEnabled === false,
            }}
            value={form.gitlabAuthToken ?? ""}
            onChange={(v) => setForm((f) => ({ ...f, gitlabAuthToken: v || undefined }))}
          />
        </div>
      </details>
    </>);
}
export default SourceControlSection;
