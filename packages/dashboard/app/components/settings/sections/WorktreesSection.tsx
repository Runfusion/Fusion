import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GitRemoteDetailed } from "../../../api";
import type { useWorktrunkInstallStatus } from "../../../hooks/useWorktrunkInstallStatus";
import { SettingsToggleRow } from "../SettingsToggleRow";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import { SettingsTextRow } from "../SettingsTextRow";
import type { SectionBaseProps, SettingsFormState } from "./context";
export interface WorktreesSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    gitRemotes: GitRemoteDetailed[];
    worktrunkInstall: ReturnType<typeof useWorktrunkInstallStatus>;
    worktrunkInstallVerified: boolean;
    onOpenWorktreesDirPicker: () => void;
    onWorktreeCopyFileChange: (index: number, value: string) => void;
    onRemoveWorktreeCopyFile: (index: number) => void;
    onAddWorktreeCopyFile: () => void;
    onOpenWorktreeCopyFilePicker: (index: number) => void;
    onOpenApprovals?: (approvalId?: string) => void;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
The plain label+control+help rows here render through the shared settings primitives instead of hand-rolled `form-group` + `checkbox-label` markup, so their labels, help copy, and padding come from the one settings type scale. `.form-group` itself stays untouched and global — 35 non-settings files style forms with it, so settings migrate off it rather than restyle it underneath the rest of the dashboard.

FNXC:SettingsScope 2026-07-15-17:35:
Every migrated key in this section is project-scoped (`DEFAULT_PROJECT_SETTINGS`): worktree count, layout, naming, and rebase policy describe one repository's checkout strategy and must not follow the operator to another project. The badges restate that per row because settings search can land an operator on a single control with no section chrome in view.

FNXC:SettingsStyling 2026-07-15-17:35:
Four groups deliberately keep their bespoke markup because they are not plain label+control+help rows:
- The `worktreeCopyFiles` allowlist is a repeating row editor with per-row Browse/Remove buttons.
- `worktreesDir` pairs its input with a Browse button and swaps in rich `<code>`-bearing help.
- `executorAllowSiblingBranchRename` and `worktreeRebaseRemote` compose their help from several `t()` fragments interleaved with `<code>` elements; a descriptor `help` is a single string, and flattening that copy would reword operator-facing text.
- The whole worktrunk block edits one nested `worktrunk` object (not a top-level settings key), carries `<code>`-bearing help, cross-field disabled logic, and an install affordance.
*/
export function WorktreesSection({ scopeBanner, form, setForm, gitRemotes, worktrunkInstall, worktrunkInstallVerified, onOpenWorktreesDirPicker, onWorktreeCopyFileChange, onRemoveWorktreeCopyFile, onAddWorktreeCopyFile, onOpenWorktreeCopyFilePicker, onOpenApprovals, }: WorktreesSectionProps) {
    const { t } = useTranslation("app");
    const worktreeCopyFileRows = (form.worktreeCopyFiles?.length ?? 0) > 0 ? form.worktreeCopyFiles ?? [] : [""];
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.worktrees.worktrees", "Worktrees")}</h4>
      {/* FNXC:Worktrees 2026-07-15-17:35: An emptied Max Worktrees stores `undefined`, not 0 or "", so the key is absent from the settings blob and the scheduler falls back to the schema default of 4 rather than capping concurrency at nothing. */}
      <SettingsNumberRow
        descriptor={{
          key: "maxWorktrees",
          label: t("settings.worktrees.maxWorktrees", "Max Worktrees"),
          help: t("settings.worktrees.limitsTotalGitWorktreesIncludingInReviewTasks", "Limits total git worktrees including in-review tasks. Default: 4."),
          scope: "project",
          min: 1,
          max: 20,
        }}
        value={form.maxWorktrees ?? null}
        onChange={(v) => setForm((f) => ({ ...f, maxWorktrees: v ?? undefined } as SettingsFormState))}
      />
      <SettingsTextRow
        descriptor={{
          key: "worktreeInitCommand",
          label: t("settings.worktrees.worktreeInitCommand", "Worktree Init Command"),
          help: t("settings.worktrees.shellCommandToRunInEachNewWorktree", "Shell command to run in each new worktree after creation. No default \u2014 unset."),
          scope: "project",
          placeholder: t("settings.worktrees.pnpmInstallFrozenLockfile", "pnpm install --frozen-lockfile"),
        }}
        value={form.worktreeInitCommand ?? null}
        onChange={(v) => setForm((f) => ({ ...f, worktreeInitCommand: v ?? "" }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "recycleWorktrees",
          label: t("settings.worktrees.recycleWorktrees", " Recycle worktrees "),
          help: t("settings.worktrees.offByDefaultOptInWhenEnabledCompleted", "Off by default (opt-in). When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup"),
          scope: "project",
        }}
        value={form.recycleWorktrees === true}
        onChange={(v) => setForm((f) => ({ ...f, recycleWorktrees: v === true }))}
      />
      <SettingsToggleRow
        descriptor={{
          key: "showWorktreeGrouping",
          label: t("settings.worktrees.showWorktreeGrouping", " Show worktree grouping on the board "),
          help: t("settings.worktrees.showWorktreeGroupingHelp", "Off by default. When enabled, WIP and processing columns always group tasks by worktree and show worktree names, including workflow-mode processing columns."),
          scope: "project",
        }}
        value={form.showWorktreeGrouping === true}
        onChange={(v) => setForm((f) => ({ ...f, showWorktreeGrouping: v === true }))}
      />
      <div className="form-group">
        <label>{t("settings.worktrees.filesToCopyIntoNewWorktrees", "Files to copy into new worktrees")}</label>
        {/*
        FNXC:WorktreeCopyFiles 2026-06-24-00:00:
        Users need a visible, editable allowlist for repository files such as `.env` that Fusion copies into freshly prepared task worktrees. The UI preserves blank rows while editing, but save normalization trims, removes blanks, and de-duplicates before persistence.
        */}
        <div className="settings-overlap-ignore-list" data-testid="worktree-copy-files-list">
          {worktreeCopyFileRows.map((path, index) => (
            <div className="settings-overlap-ignore-row" key={index}>
              <div className="settings-overlap-ignore-path-controls">
                <input
                  id={`worktreeCopyFile-${index}`}
                  type="text"
                  className="input"
                  placeholder={t("settings.worktrees.copyFilePlaceholder", ".env")}
                  value={path}
                  onChange={(e) => onWorktreeCopyFileChange(index, e.target.value)}
                  aria-label={t("settings.worktrees.copyFilePathLabel", "File to copy into new worktrees")}
                />
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onOpenWorktreeCopyFilePicker(index)}
                  aria-label={t("settings.worktrees.browseCopyFile", "Browse file to copy into new worktrees")}
                >
                  {t("settings.worktrees.browse", " Browse ")}
                </button>
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onRemoveWorktreeCopyFile(index)}
                aria-label={t("settings.worktrees.removeCopyFile", "Remove copied worktree file")}
              >
                {t("settings.worktrees.remove", "Remove")}
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-sm" onClick={onAddWorktreeCopyFile}>
          {t("settings.worktrees.addCopyFile", "Add file")}
        </button>
        <small>{t("settings.worktrees.copyFilesHelp", "Optional. Repository-root-relative regular files are copied into fresh or pooled task worktrees before init commands run. Missing files or directories are skipped without exposing contents. Default: empty (no files copied).")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="executorAllowSiblingBranchRename" className="checkbox-label">
          <input id="executorAllowSiblingBranchRename" type="checkbox" checked={form.executorAllowSiblingBranchRename === true} onChange={(e) => setForm((f) => ({ ...f, executorAllowSiblingBranchRename: e.target.checked }))}/>{t("settings.worktrees.allowSilentSiblingBranchRenameDuringExecutorConflicts", " Allow silent sibling branch rename during executor conflicts ")}</label>
        <small>{t("settings.worktrees.discouragedThisRestoresTheLegacyBehaviorWhereA", " Discouraged. This restores the legacy behavior where a live ")}<code>fusion/&lt;task-id&gt;</code>{t("settings.worktrees.branchCollisionSilentlyForksWorkOntoSiblingBranches", " branch collision silently forks work onto sibling branches like ")}<code>-2</code>{t("settings.worktrees.andCanHidePriorCommitsFromTheDefault", " and can hide prior commits from the default recovery flow. Default: disabled. ")}</small>
      </div>
      {/*
      FNXC:Worktrees 2026-07-15-17:35:
      Recycling and naming are coupled: pooled worktrees keep the names they were created with, so the naming select is disabled while `recycleWorktrees` is on and its help swaps to explain why rather than letting the operator pick a style that would be silently ignored.
      */}
      <SettingsSelectRow
        descriptor={{
          key: "worktreeNaming",
          label: t("settings.worktrees.worktreeNamingStyle", "Worktree Naming Style"),
          help: form.recycleWorktrees
            ? t("settings.worktrees.namingStyleNotApplicableWhenRecycling", "Naming style is not applicable when recycling worktrees \u2014 pooled worktrees retain their existing names")
            : t("settings.worktrees.howToNameFreshWorktreeDirectories", "How to name fresh worktree directories. Only applies when recycling is off. Default: random."),
          scope: "project",
          disabled: form.recycleWorktrees,
          options: [
            { value: "random", label: t("settings.worktrees.randomNamesEGSwiftFalcon", "Random names (e.g., swift-falcon)") },
            { value: "task-id", label: t("settings.worktrees.taskIDEGFN042", "Task ID (e.g., FN-042)") },
            { value: "task-title", label: t("settings.worktrees.taskTitleEGFixLoginBug", "Task title (e.g., fix-login-bug)") },
          ],
        }}
        value={form.worktreeNaming || "random"}
        onChange={(v) => setForm((f) => ({ ...f, worktreeNaming: v as "random" | "task-id" | "task-title" }))}
      />
      <div className="form-group">
        <label htmlFor="worktreesDir">{t("settings.worktrees.worktreesDirectory", "Worktrees Directory")}</label>
        <div className="settings-overlap-ignore-path-controls">
          <input id="worktreesDir" type="text" placeholder={t("settings.worktrees.defaultsToWorktreesLeaveEmptyUnlessOverriding", "Defaults to .worktrees \u2014 leave empty unless overriding")} value={form.worktreesDir || ""} disabled={form.worktrunk?.enabled === true} onChange={(e) => setForm((f) => ({ ...f, worktreesDir: e.target.value }))}/>
          <button type="button" className="btn btn-sm" onClick={onOpenWorktreesDirPicker} aria-label={t("settings.worktrees.browseWorktreesDirectory", "Browse worktrees directory")} disabled={form.worktrunk?.enabled === true}>{t("settings.worktrees.browse", " Browse ")}</button>
        </div>
        <small>
          {form.worktrunk?.enabled === true
            ? "Disabled because Worktrunk integration is enabled — worktrunk manages the worktree directory layout. Disable worktrunk integration to use a custom directory."
            : <>{t("settings.worktrees.optionalSupports", " Optional. Supports ")}<code>~</code>{t("settings.worktrees.and", " and ")}<code>{"{repo}"}</code>{t("settings.worktrees.defaultsTo", ". Defaults to ")}<code>&lt;projectRoot&gt;/.worktrees</code>{t("settings.worktrees.whenUnsetOnlyAffectsNewlyCreatedWorktrees", " when unset. Only affects newly-created worktrees. ")}</>}
        </small>
      </div>
      {/* FNXC:Worktrees 2026-07-15-17:35: Defaults to on, so an absent key reads as enabled (`!== false`) rather than off \u2014 an unset settings blob must not silently skip the pre-merge rebase. */}
      <SettingsToggleRow
        descriptor={{
          key: "worktreeRebaseBeforeMerge",
          label: t("settings.worktrees.rebaseFromRemoteBeforeMerge", " Rebase from remote before merge "),
          help: t("settings.worktrees.whenEnabledTheMergerFetchesFromTheConfigured", "When enabled, the merger fetches from the configured remote and rebases the task branch onto the latest default-branch tip before merging \u2014 catching concurrent pushes from other collaborators or fusion workers. Any conflicts the rebase surfaces flow into the existing smart/AI resolve pipeline. Default: enabled."),
          scope: "project",
        }}
        value={form.worktreeRebaseBeforeMerge !== false}
        onChange={(v) => setForm((f) => ({ ...f, worktreeRebaseBeforeMerge: v === true }))}
      />
      {form.worktreeRebaseBeforeMerge !== false && (<div className="form-group">
          <label htmlFor="worktreeRebaseRemote">{t("settings.worktrees.rebaseRemote", "Rebase Remote")}</label>
          <select id="worktreeRebaseRemote" value={form.worktreeRebaseRemote ?? ""} onChange={(e) => setForm((f) => ({ ...f, worktreeRebaseRemote: e.target.value || undefined }))}>
            <option value="">{t("settings.worktrees.useGitDefault", "Use git default")}</option>
            {gitRemotes.map((remote) => (<option key={remote.name} value={remote.name}>
                {remote.name} ({remote.fetchUrl})
              </option>))}
          </select>
          <small>{t("settings.worktrees.whichRemoteToFetchForThePreMerge", " Which remote to fetch for the pre-merge rebase. \"Use git default\" falls back to the remote configured for the default branch (typically ")}<code>origin</code>{t("settings.worktrees.closeParenPeriod", ").")}
          </small>
        </div>)}
      <SettingsToggleRow
        descriptor={{
          key: "worktreeRebaseLocalBase",
          label: t("settings.worktrees.alsoRebaseOntoLocalDefaultBranchHEAD", " Also rebase onto local default-branch HEAD "),
          help: t("settings.worktrees.inAdditionToTheRemoteRebaseAboveAlso", " In addition to the remote rebase above, also rebase the task branch onto the local default-branch HEAD (rootDir). This catches sibling tasks that merged locally but haven't been pushed yet \u2014 without it, two concurrent tasks where one deletes code can have the other silently re-introduce it via the fallback strategy. Enabled by default; only disable if it causes issues with your workflow. "),
          scope: "project",
        }}
        value={form.worktreeRebaseLocalBase !== false}
        onChange={(v) => setForm((f) => ({ ...f, worktreeRebaseLocalBase: v === true }))}
      />

      <h4 className="settings-section-heading settings-section-heading--spaced">{t("settings.worktrees.worktrunkIntegration", "Worktrunk integration")}</h4>
      <div className="form-group">
        <label htmlFor="worktrunkEnabled" className="checkbox-label">
          <input id="worktrunkEnabled" type="checkbox" checked={form.worktrunk?.enabled === true} disabled={!worktrunkInstallVerified && form.worktrunk?.enabled !== true} onChange={(e) => setForm((f) => ({
            ...f,
            worktrunk: {
                enabled: e.target.checked,
                binaryPath: f.worktrunk?.binaryPath ?? "",
                onFailure: f.worktrunk?.onFailure ?? "fail",
            },
        }))}/>{t("settings.worktrees.enableWorktrunkIntegration", " Enable worktrunk integration ")}</label>
        <small>{t("settings.worktrees.disabledByDefaultOptInWhenEnabledFusion", " Disabled by default (opt-in). When enabled, Fusion shells out to ")}<code>worktrunk</code>{t("settings.worktrees.forWorktreeCreateSyncPruneAndRemoveOperations", " for worktree create, sync, prune, and remove operations and follows worktrunk's directory layout. ")}</small>
        {!worktrunkInstallVerified && form.worktrunk?.enabled !== true && (<small className="settings-muted">{t("settings.worktrees.installTheWorktrunkBinaryBelowToEnableThis", "Install the worktrunk binary below to enable this integration.")}</small>)}
      </div>
      <div className="form-group" data-testid="worktrunk-install-affordance">
        {worktrunkInstall.status === "installed" && (<small className="settings-muted">{t("settings.worktrees.worktrunk", " worktrunk ")}{worktrunkInstall.version ?? ""}{t("settings.worktrees.installedAt", " installed at ")}{worktrunkInstall.installPath ?? "~/.fusion/bin/worktrunk"}
          </small>)}
        {(worktrunkInstall.status === "missing" || worktrunkInstall.status === "installing") && (<>
            <button type="button" className="btn btn-primary" onClick={() => void worktrunkInstall.requestInstall()} disabled={worktrunkInstall.requesting || worktrunkInstall.status === "installing"}>
              {t("settings.worktrees.installWorktrunk", "Install worktrunk binary")}
            </button>
            <small className="settings-muted">{t("settings.worktrees.enableWorktrunkAndRequestApprovalToInstallThe", "Enable worktrunk and request approval to install the pinned release.")}</small>
          </>)}
        {worktrunkInstall.status === "pending-approval" && (<>
            <small className="settings-muted">{t("settings.worktrees.awaitingApproval", "Awaiting approval — open Approvals to continue.")}</small>
            <button type="button" className="btn btn-secondary" onClick={() => onOpenApprovals?.(worktrunkInstall.pendingApprovalId)}>
              {t("settings.worktrees.openApprovals", "Open Approvals")}
            </button>
          </>)}
        {(worktrunkInstall.status === "denied" || worktrunkInstall.status === "failed") && (<>
            <small style={{ color: "var(--color-error)" }}>{worktrunkInstall.error ?? "Worktrunk install failed."}</small>
            <button type="button" className="btn btn-secondary" onClick={() => void worktrunkInstall.requestInstall()}>
              {t("settings.worktrees.tryAgain", "Try again")}
            </button>
          </>)}
      </div>
      <div className="form-group">
        <label htmlFor="worktrunkBinaryPath">{t("settings.worktrees.worktrunkBinaryPath", "Worktrunk binary path")}</label>
        <input id="worktrunkBinaryPath" type="text" className="input" placeholder={t("settings.worktrees.autoDetectFusionBinWorktrunkOrPATH", "auto-detect (~/.fusion/bin/worktrunk or $PATH)")} value={form.worktrunk?.binaryPath ?? ""} disabled={form.worktrunk?.enabled !== true} onChange={(e) => setForm((f) => ({
            ...f,
            worktrunk: {
                enabled: f.worktrunk?.enabled === true,
                binaryPath: e.target.value,
                onFailure: f.worktrunk?.onFailure ?? "fail",
            },
        }))}/>
        <small>{t("settings.worktrees.optionalLeaveBlankToAutoResolveFusionWill", "Optional. Leave blank to auto-resolve; Fusion will offer to install on first use.")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="worktrunkOnFailure">{t("settings.worktrees.worktrunkFailureBehavior", "Worktrunk failure behavior")}</label>
        <select id="worktrunkOnFailure" className="select" value={form.worktrunk?.onFailure ?? "fail"} disabled={form.worktrunk?.enabled !== true} onChange={(e) => setForm((f) => ({
            ...f,
            worktrunk: {
                enabled: f.worktrunk?.enabled === true,
                binaryPath: f.worktrunk?.binaryPath ?? "",
                onFailure: e.target.value as "fail" | "fallback-native",
            },
        }))}>
          <option value="fail">{t("settings.worktrees.failAndPauseTheTaskDefault", "Fail and pause the task (default)")}</option>
          <option value="fallback-native">{t("settings.worktrees.fallBackToFusionsNativeWorktreeBackend", "Fall back to Fusion's native worktree backend")}</option>
        </select>
        <small>
          <code>fail</code>{t("settings.worktrees.stopsOnWorktrunkErrorsForExplicitOperatorRecovery", " stops on worktrunk errors for explicit operator recovery; ")}<code>fallback-native</code>{t("settings.worktrees.keepsProgressMovingBySwitchingToFusionApos", " keeps progress moving by switching to Fusion's built-in worktree backend. ")}</small>
      </div>
    </>);
}
export default WorktreesSection;
