import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { GitRemoteDetailed } from "../../../api";
import type { useWorktrunkInstallStatus } from "../../../hooks/useWorktrunkInstallStatus";
import type { SectionBaseProps, SettingsFormState } from "./context";
export interface WorktreesSectionProps extends SectionBaseProps {
    scopeBanner: ReactNode;
    gitRemotes: GitRemoteDetailed[];
    worktrunkInstall: ReturnType<typeof useWorktrunkInstallStatus>;
    worktrunkInstallVerified: boolean;
    onOpenWorktreesDirPicker: () => void;
    onOpenApprovals?: (approvalId?: string) => void;
}
export function WorktreesSection({ scopeBanner, form, setForm, gitRemotes, worktrunkInstall, worktrunkInstallVerified, onOpenWorktreesDirPicker, onOpenApprovals, }: WorktreesSectionProps) {
    const { t } = useTranslation("app");
    return (<>
      {scopeBanner}
      <h4 className="settings-section-heading">{t("settings.worktrees.worktrees", "Worktrees")}</h4>
      <div className="form-group">
        <label htmlFor="maxWorktrees">{t("settings.worktrees.maxWorktrees", "Max Worktrees")}</label>
        <input id="maxWorktrees" type="number" min={1} max={20} value={form.maxWorktrees ?? ""} onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, maxWorktrees: val === "" ? undefined : Number(val) } as SettingsFormState));
        }}/>
        <small>{t("settings.worktrees.limitsTotalGitWorktreesIncludingInReviewTasks", "Limits total git worktrees including in-review tasks")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="worktreeInitCommand">{t("settings.worktrees.worktreeInitCommand", "Worktree Init Command")}</label>
        <input id="worktreeInitCommand" type="text" placeholder={t("settings.worktrees.pnpmInstallFrozenLockfile", "pnpm install --frozen-lockfile")} value={form.worktreeInitCommand || ""} onChange={(e) => setForm((f) => ({ ...f, worktreeInitCommand: e.target.value }))}/>
        <small>{t("settings.worktrees.shellCommandToRunInEachNewWorktree", "Shell command to run in each new worktree after creation")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="recycleWorktrees" className="checkbox-label">
          <input id="recycleWorktrees" type="checkbox" checked={form.recycleWorktrees} onChange={(e) => setForm((f) => ({ ...f, recycleWorktrees: e.target.checked }))}/>{t("settings.worktrees.recycleWorktrees", " Recycle worktrees ")}</label>
        <small>{t("settings.worktrees.offByDefaultOptInWhenEnabledCompleted", "Off by default (opt-in). When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="executorAllowSiblingBranchRename" className="checkbox-label">
          <input id="executorAllowSiblingBranchRename" type="checkbox" checked={form.executorAllowSiblingBranchRename === true} onChange={(e) => setForm((f) => ({ ...f, executorAllowSiblingBranchRename: e.target.checked }))}/>{t("settings.worktrees.allowSilentSiblingBranchRenameDuringExecutorConflicts", " Allow silent sibling branch rename during executor conflicts ")}</label>
        <small>{t("settings.worktrees.discouragedThisRestoresTheLegacyBehaviorWhereA", " Discouraged. This restores the legacy behavior where a live ")}<code>fusion/&lt;task-id&gt;</code>{t("settings.worktrees.branchCollisionSilentlyForksWorkOntoSiblingBranches", " branch collision silently forks work onto sibling branches like ")}<code>-2</code>{t("settings.worktrees.andCanHidePriorCommitsFromTheDefault", " and can hide prior commits from the default recovery flow. ")}</small>
      </div>
      <div className="form-group">
        <label htmlFor="worktreeNaming">{t("settings.worktrees.worktreeNamingStyle", "Worktree Naming Style")}</label>
        <select id="worktreeNaming" value={form.worktreeNaming || "random"} onChange={(e) => setForm((f) => ({ ...f, worktreeNaming: e.target.value as "random" | "task-id" | "task-title" }))} disabled={form.recycleWorktrees}>
          <option value="random">{t("settings.worktrees.randomNamesEGSwiftFalcon", "Random names (e.g., swift-falcon)")}</option>
          <option value="task-id">{t("settings.worktrees.taskIDEGFN042", "Task ID (e.g., FN-042)")}</option>
          <option value="task-title">{t("settings.worktrees.taskTitleEGFixLoginBug", "Task title (e.g., fix-login-bug)")}</option>
        </select>
        <small>
          {form.recycleWorktrees
            ? "Naming style is not applicable when recycling worktrees — pooled worktrees retain their existing names"
            : "How to name fresh worktree directories. Only applies when recycling is off."}
        </small>
      </div>
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
      <div className="form-group">
        <label htmlFor="worktreeRebaseBeforeMerge" className="checkbox-label">
          <input id="worktreeRebaseBeforeMerge" type="checkbox" checked={form.worktreeRebaseBeforeMerge !== false} onChange={(e) => setForm((f) => ({ ...f, worktreeRebaseBeforeMerge: e.target.checked }))}/>{t("settings.worktrees.rebaseFromRemoteBeforeMerge", " Rebase from remote before merge ")}</label>
        <small>{t("settings.worktrees.whenEnabledTheMergerFetchesFromTheConfigured", "When enabled, the merger fetches from the configured remote and rebases the task branch onto the latest default-branch tip before merging \u2014 catching concurrent pushes from other collaborators or fusion workers. Any conflicts the rebase surfaces flow into the existing smart/AI resolve pipeline.")}</small>
      </div>
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
      <div className="form-group">
        <label htmlFor="worktreeRebaseLocalBase" className="checkbox-label">
          <input id="worktreeRebaseLocalBase" type="checkbox" checked={form.worktreeRebaseLocalBase !== false} onChange={(e) => setForm((f) => ({ ...f, worktreeRebaseLocalBase: e.target.checked }))}/>{t("settings.worktrees.alsoRebaseOntoLocalDefaultBranchHEAD", " Also rebase onto local default-branch HEAD ")}</label>
        <small>{t("settings.worktrees.inAdditionToTheRemoteRebaseAboveAlso", " In addition to the remote rebase above, also rebase the task branch onto the local default-branch HEAD (rootDir). This catches sibling tasks that merged locally but haven't been pushed yet \u2014 without it, two concurrent tasks where one deletes code can have the other silently re-introduce it via the fallback strategy. Enabled by default; only disable if it causes issues with your workflow. ")}</small>
      </div>

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
        <small>{t("settings.worktrees.disabledByDefaultOptInWhenEnabledFusion", " Disabled by default (opt-in). When enabled, Fusion shells out to ")}<code>worktrunk</code>{t("settings.worktrees.forWorktreeCreateSyncPruneAndRemoveOperations", " for worktree create, sync, prune, and remove operations and follows worktrunk&apos;s directory layout. ")}</small>
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
          <code>fail</code>{t("settings.worktrees.stopsOnWorktrunkErrorsForExplicitOperatorRecovery", " stops on worktrunk errors for explicit operator recovery; ")}<code>fallback-native</code>{t("settings.worktrees.keepsProgressMovingBySwitchingToFusionApos", " keeps progress moving by switching to Fusion&apos;s built-in worktree backend. ")}</small>
      </div>
    </>);
}
export default WorktreesSection;
