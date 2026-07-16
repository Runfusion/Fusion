import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@fusion/core";
import { fetchGitRemoteBranches } from "../../../api";
import { MovedSettingsStub } from "./MovedSettingsStub";
import { SettingsSelectRow } from "../SettingsSelectRow";
import { SettingsNumberRow } from "../SettingsNumberRow";
import type { SectionBaseProps } from "./context";
/*
FNXC:MergePush 2026-07-11-23:00:
The push-after-merge target used to be one free-text field ("origin" or "origin main"),
which was easy to mistype and gave no discoverability of what could be pushed where. It
is now split into a remote dropdown (the repo's configured git remotes) and a target
branch dropdown (branches known on that remote, defaulting to the integration branch),
while still persisting to the single `pushRemote` setting string so the engine parser
and existing configs are unchanged. A Custom… escape hatch covers branches that don't
exist on the remote yet (pushing creates them), and the free-text input returns as a
fallback when no remotes are configured.
*/
export function parsePushRemoteSetting(pushRemote: string | undefined): { remote: string; branch: string } {
    const tokens = (pushRemote ?? "").trim().split(/\s+/).filter(Boolean);
    return { remote: tokens[0] ?? "origin", branch: tokens.slice(1).join(" ") };
}
export function composePushRemoteSetting(remote: string, branch: string): string | undefined {
    const trimmedRemote = remote.trim() || "origin";
    const trimmedBranch = branch.trim();
    if (trimmedBranch) return `${trimmedRemote} ${trimmedBranch}`;
    // Bare default remote with default branch = the setting's default — store unset.
    return trimmedRemote === "origin" ? undefined : trimmedRemote;
}
function resolveMaxAutoMergeRetriesForMergeForm(value: unknown): number {
    const configured = Number(value);
    return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 3;
}
interface LegacyAutoMergeStampCandidate {
    taskId: string;
    column: string;
    cleared: boolean;
}
interface LegacyAutoMergeStampListResponse {
    candidates: LegacyAutoMergeStampCandidate[];
    count: number;
}
interface LegacyAutoMergeStampApplyResponse {
    cleared: LegacyAutoMergeStampCandidate[];
    count: number;
}
async function readLegacyAutoMergeStampResponse(response: Response): Promise<LegacyAutoMergeStampListResponse> {
    if (!response.ok) {
        throw new Error(await response.text() || "Failed to load legacy auto-merge stamps");
    }
    return response.json() as Promise<LegacyAutoMergeStampListResponse>;
}
/*
FNXC:SettingsStyling 2026-07-15-17:35:
The plain label+control+help rows here render through the shared settings primitives instead of hand-rolled `form-group` markup, so their labels, help copy, and padding come from the one settings type scale. `.form-group` itself stays untouched and global — 35 non-settings files style forms with it, so settings migrate off it rather than restyle it underneath the rest of the dashboard.

FNXC:SettingsScope 2026-07-15-17:35:
Every migrated key here is project-scoped (`DEFAULT_PROJECT_SETTINGS`): merge policy, retry caps, and auth mode describe one repository's landing strategy. The badges restate that per row because settings search can land an operator on a single control with no section chrome in view.

FNXC:SettingsStyling 2026-07-15-17:35:
Most of this section deliberately keeps its bespoke markup, because Merge is not a section of plain label+control+help rows:
- Every row whose help lives in a `<details className="settings-option-details">` "More details" disclosure keeps it. Merge help copy is long enough that it is collapsed by default; a descriptor `help` renders unconditionally, so migrating those rows would silently delete a progressive-disclosure affordance across the section and turn Merge into a wall of prose. That is a UX change, not a styling one.
- `mergeIntegrationWorktree`, `mergeConflictStrategy`, `postMergeAuditMode`, `commitAuthorName`, and `commitAuthorEmail` compose help from several `t()` fragments interleaved with `<code>`/`<strong>` elements; a descriptor `help` is a single string and flattening that copy would reword operator-facing text. `mergeIntegrationWorktree` additionally renders an adjacent live warning banner the primitive has no slot for.
- `integrationBranch` and the push remote/branch pair are custom dropdown+Custom…-escape-hatch widgets, not plain selects.
- `planApprovalMode` keeps its `data-testid="plan-approval-mode-select"`, which the primitives have no slot for and MergeSection.legacy-automerge-cleanup.test.tsx reads.
- `testMode` is declared in BOTH `DEFAULT_GLOBAL_SETTINGS` and `DEFAULT_PROJECT_SETTINGS`, so its scope is ambiguous and no badge can be stamped honestly.
- The legacy auto-merge stamp cleanup panel is a report-and-trigger card, not a setting.
*/
export interface MergeSectionProps extends SectionBaseProps {
    integrationBranchOptions: string[];
    integrationBranchCustomMode: boolean;
    setIntegrationBranchCustomMode: (value: boolean) => void;
    onOpenWorkflowSettings?: () => void;
    /** Names of the repo's configured git remotes for the push-target dropdown. */
    gitRemoteOptions?: string[];
    projectId?: string;
}
export function MergeSection({ form, setForm, integrationBranchOptions, integrationBranchCustomMode, setIntegrationBranchCustomMode, onOpenWorkflowSettings, gitRemoteOptions = [], projectId, }: MergeSectionProps) {
    const { t } = useTranslation("app");
    const pushTarget = parsePushRemoteSetting(form.pushRemote);
    const [pushBranchOptions, setPushBranchOptions] = useState<string[]>([]);
    const [pushBranchCustomMode, setPushBranchCustomMode] = useState(false);
    // Load the branches known on the selected push remote whenever it changes.
    // Best-effort: an empty list leaves the default + Custom… options usable.
    useEffect(() => {
        if (!form.pushAfterMerge || gitRemoteOptions.length === 0) return;
        let cancelled = false;
        fetchGitRemoteBranches(pushTarget.remote, projectId)
            .then((branches) => { if (!cancelled) setPushBranchOptions(branches); })
            .catch(() => { if (!cancelled) setPushBranchOptions([]); });
        return () => { cancelled = true; };
    }, [form.pushAfterMerge, pushTarget.remote, projectId, gitRemoteOptions.length]);
    const [legacyStampCandidates, setLegacyStampCandidates] = useState<LegacyAutoMergeStampCandidate[]>([]);
    const [legacyStampLoading, setLegacyStampLoading] = useState(true);
    const [legacyStampApplying, setLegacyStampApplying] = useState(false);
    const [legacyStampError, setLegacyStampError] = useState<string | null>(null);
    const [legacyStampSuccess, setLegacyStampSuccess] = useState<string | null>(null);
    const loadLegacyAutoMergeStamps = useCallback(async () => {
        setLegacyStampLoading(true);
        setLegacyStampError(null);
        try {
            const data = await readLegacyAutoMergeStampResponse(await fetch("/api/maintenance/legacy-automerge-stamps"));
            setLegacyStampCandidates(Array.isArray(data.candidates) ? data.candidates : []);
        }
        catch (err) {
            setLegacyStampError(err instanceof Error ? err.message : "Failed to load legacy auto-merge stamps");
        }
        finally {
            setLegacyStampLoading(false);
        }
    }, []);
    useEffect(() => {
        void loadLegacyAutoMergeStamps();
    }, [loadLegacyAutoMergeStamps]);
    const applyLegacyAutoMergeStampCleanup = async () => {
        const confirmed = window.confirm("Apply cleanup for legacy auto-merge stamps? This clears only legacy non-override in-review stamps returned by the store and never touches genuine per-task overrides.");
        if (!confirmed)
            return;
        setLegacyStampApplying(true);
        setLegacyStampError(null);
        setLegacyStampSuccess(null);
        try {
            const response = await fetch("/api/maintenance/legacy-automerge-stamps/apply", { method: "POST" });
            if (!response.ok) {
                throw new Error(await response.text() || "Failed to apply legacy auto-merge stamp cleanup");
            }
            const data = await response.json() as LegacyAutoMergeStampApplyResponse;
            setLegacyStampSuccess(`Cleared ${data.count} legacy auto-merge stamp${data.count === 1 ? "" : "s"}.`);
            await loadLegacyAutoMergeStamps();
        }
        catch (err) {
            setLegacyStampError(err instanceof Error ? err.message : "Failed to apply legacy auto-merge stamp cleanup");
        }
        finally {
            setLegacyStampApplying(false);
        }
    };
    return (<>
      <h4 className="settings-section-heading">{t("settings.merge.merge", "Merge")}</h4>
      <div className="form-group">
        <label htmlFor="autoMerge" className="checkbox-label">
          <input id="autoMerge" type="checkbox" checked={form.autoMerge} onChange={(e) => setForm((f) => ({ ...f, autoMerge: e.target.checked }))}/>{t("settings.merge.autoMergeCompletedTasks", " Auto-merge completed tasks ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.whenEnabledTasksThatPassReviewAreAutomatically", "When enabled, tasks that pass review are automatically merged into the main branch. Default: enabled.")}</small>
        </details>
      </div>
      <div className="form-group">
        {/*
          FNXC:PlanApproval 2026-06-26-00:00:
          Operators need one project-scoped control beside review/merge policy to force all tasks to auto-approve or require manual plan approval without editing each workflow.

          FNXC:PlanApproval 2026-07-04-00:00:
          FN-7557: auto-approve-all is now the project default (previously workflow), so the select fallback and "(default)" label marker move to the auto-approve option to keep the dropdown truthful.
        */}
        <label htmlFor="planApprovalMode">{t("settings.merge.planApprovalMode", "Plan approval mode")}</label>
        <select id="planApprovalMode" className="select" value={form.planApprovalMode ?? "auto-approve-all"} onChange={(e) => {
            const nextMode = e.target.value as Settings["planApprovalMode"];
            setForm((f) => ({ ...f, planApprovalMode: nextMode }));
        }} data-testid="plan-approval-mode-select">
          <option value="workflow">{t("settings.merge.planApprovalModeWorkflow", "Use workflow setting")}</option>
          <option value="auto-approve-all">{t("settings.merge.planApprovalModeAutoApproveAll", "Auto-approve all tasks (default)")}</option>
          <option value="require-all">{t("settings.merge.planApprovalModeRequireAll", "Require approval for all tasks")}</option>
        </select>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.planApprovalModeHelp", "Project-wide override for the planning approval gate. Leave on workflow to use each workflow's Require plan approval setting, or force all approved specs to bypass or wait for manual approval.")}</small>
        </details>
      </div>
      {/*
        FNXC:AutoMergeRetries 2026-06-17-04:20:
        Operators need a merge-section control for maxAutoMergeRetries so conflict-heavy projects can tune how many auto-resolution attempts occur before Fusion parks a task for human recovery. Invalid input falls back to 3 to preserve prior behavior.
      */}
      <SettingsNumberRow
        descriptor={{
          key: "maxAutoMergeRetries",
          label: t("settings.merge.autoMergeConflictRetries", "Auto-merge conflict retries"),
          help: t("settings.merge.positiveIntegerRetryCapForAutoMergeConflict", "Positive integer retry cap for auto-merge conflict resolution before a task parks for human recovery. Default 3."),
          scope: "project",
          min: 1,
          step: 1,
        }}
        value={form.maxAutoMergeRetries ?? 3}
        onChange={(v) => setForm((f) => ({
            ...f,
            maxAutoMergeRetries: v === null ? undefined : resolveMaxAutoMergeRetriesForMergeForm(v),
        }))}
      />
      <div className="form-group" data-testid="legacy-automerge-stamp-cleanup-panel">
        <h5 className="settings-section-heading">{t("settings.merge.legacyAutoMergeStampCleanup", "Legacy auto-merge stamp cleanup")}</h5>
        <small>{t("settings.merge.findsInReviewTasksWhoseAutoMergeValue", " Finds in-review tasks whose auto-merge value came from the legacy review-entry stamp. Dry-run is automatic; applying delegates to the store cleanup and preserves genuine per-task overrides. ")}</small>
        {legacyStampLoading ? (<small aria-live="polite">{t("settings.merge.checkingForLegacyAutoMergeStamps", "Checking for legacy auto-merge stamps\u2026")}</small>) : legacyStampCandidates.length === 0 ? (<small data-testid="legacy-automerge-stamp-empty-state">{t("settings.merge.noLegacyAutoMergeStampsToCleanUp", " No legacy auto-merge stamps to clean up. ")}</small>) : (<>
            <small>{legacyStampCandidates.length}{t("settings.merge.legacyAutoMergeStamp", " legacy auto-merge stamp")}{legacyStampCandidates.length === 1 ? "" : "s"}{t("settings.merge.readyToCleanUp", " ready to clean up.")}</small>
            <ul>
              {legacyStampCandidates.map((candidate) => (<li key={candidate.taskId} data-testid="legacy-automerge-stamp-candidate-row">
                  <strong>{candidate.taskId}</strong> — {candidate.column}
                </li>))}
            </ul>
            <button type="button" className="btn" onClick={applyLegacyAutoMergeStampCleanup} disabled={legacyStampApplying} data-testid="legacy-automerge-stamp-apply-button">
              {legacyStampApplying ? "Applying cleanup…" : "Apply cleanup"}
            </button>
          </>)}
        {legacyStampSuccess ? <small className="settings-success" aria-live="polite">{legacyStampSuccess}</small> : null}
        {legacyStampError ? <small className="settings-error" role="alert">{legacyStampError}</small> : null}
      </div>
      <div className="form-group">
        <label htmlFor="mergerMode">{t("settings.merge.aIMerge", "AI merge")}</label>
        <select id="mergerMode" className="select" value={form.merger?.mode ?? "ai"} onChange={(e) => setForm((f) => ({ ...f, merger: { ...(f.merger ?? {}), mode: e.target.value as "ai" | "deterministic" } }))}>
          <option value="ai">{t("settings.merge.aIMergeDefaultAIMergesInAClean", "AI merge (default) \u2014 AI merges in a clean room, an AI reviewer audits with retries, then lands")}</option>
          <option value="deterministic">{t("settings.merge.deterministicLegacyRebaseConflictStrategyAuditPipeline", "Deterministic (legacy) \u2014 rebase / conflict-strategy / audit pipeline")}</option>
        </select>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.aIModeMergesTheTaskBranchIntoAn", " AI mode merges the task branch into an isolated clean-room checkout at the target branch's tip, has an AI reviewer audit the squash (with corrective retries \u2014 advisory concerns land with a logged warning, an unfixable correctness concern hard-fails), then fast-forwards the target branch and syncs your local checkout (AI reconciles a conflicting restore). Each task merges to its own target branch, or the default integration branch. ")}<strong>{t("settings.merge.theLegacyMergeSettingsBelowDoNotApply", "The legacy merge settings below do not apply while AI merge is on.")}</strong>
          </small>
        </details>
      </div>
      {(form.merger?.mode ?? "ai") === "ai" && (<>
          {/* FNXC:AIMerge 2026-07-15-17:35: Dotted descriptor key because this is a leaf of the nested project-scoped `merger` blob, not a top-level settings field; the row's anchor and control id follow the same `merger.maxReviewPasses` path the settings blob uses. */}
          <SettingsNumberRow
            descriptor={{
              key: "merger.maxReviewPasses",
              label: t("settings.merge.maxAIReviewPasses", "Max AI review passes"),
              help: t("settings.merge.aICorrectiveRoundsBeforeLandingTheBestResult", "AI corrective rounds before landing the best result (advisory concern) or hard-failing (unfixable correctness concern). Default 3. The reviewer uses your project's reviewer/validator model."),
              scope: "project",
              min: 0,
              max: 10,
            }}
            value={form.merger?.maxReviewPasses ?? 3}
            onChange={(v) => setForm((f) => ({ ...f, merger: { ...(f.merger ?? {}), maxReviewPasses: v ?? undefined } }))}
          />
          <div className="form-group">
            <label htmlFor="mergerAllowDirtyLocalCheckoutSync" className="checkbox-label">
              <input id="mergerAllowDirtyLocalCheckoutSync" type="checkbox" checked={form.merger?.allowDirtyLocalCheckoutSync === true} onChange={(e) => setForm((f) => ({
                ...f,
                merger: { ...(f.merger ?? {}), allowDirtyLocalCheckoutSync: e.target.checked },
            }))}/>{t("settings.merge.allowAIMergeToSyncADirtyChecked", " Allow AI merge to sync a dirty checked-out integration branch ")}</label>
            <details className="settings-option-details">
              <summary>{t("settings.merge.moreDetails", "More details")}</summary>
              <small>{t("settings.merge.dangerousCompatibilityEscapeHatchLeaveOffUnlessYou", " Dangerous compatibility escape hatch \u2014 restores the legacy stash \u2192 fast-forward \u2192 restore behavior when your checked-out integration branch has unrelated local edits. When off, AI merge blocks before advancing the branch so dirty project-root edits cannot contaminate a completed merge. Default: enabled (new/unconfigured projects sync a dirty checkout). ")}</small>
            </details>
          </div>
        </>)}
      <div className="form-group">
        <label htmlFor="testMode" className="checkbox-label">
          <input id="testMode" type="checkbox" checked={form.testMode === true} onChange={(e) => setForm((f) => ({ ...f, testMode: e.target.checked }))}/>{t("settings.merge.enableTestMode", " Enable test mode ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.forcesAllAILanesToUseTheDeterministic", "Forces all AI lanes to use the deterministic mock provider. No network calls, zero token cost. No default \u2014 unset (disabled).")}</small>
        </details>
      </div>
      <MovedSettingsStub message={t("settings.movedStub.reviewVerification", "Review, verification auto-fix, and scope-enforcement settings now live on the workflow.")} onOpenWorkflowSettings={onOpenWorkflowSettings}/>
      <div className="form-group">
        <label htmlFor="mergeStrategy">{t("settings.merge.autoCompletionMode", "Auto-completion mode")}</label>
        <select id="mergeStrategy" value={form.mergeStrategy || "direct"} onChange={(e) => setForm((f) => ({ ...f, mergeStrategy: e.target.value as Settings["mergeStrategy"] }))}>
          <option value="direct">{t("settings.merge.directMergeIntoTheCurrentBranch", "Direct merge into the current branch (default)")}</option>
          <option value="pull-request">{t("settings.merge.createMonitorAndMergeAGitHubPullRequest", "Create, monitor, and merge a GitHub pull request")}</option>
        </select>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.controlsWhatHappensAfterATaskReachesIn", " Controls what happens after a task reaches In Review. Direct mode merges into the current branch locally. Pull request mode keeps the task in In Review while Fusion waits for GitHub reviews and required checks before merging the PR. ")}</small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="integrationBranch">{t("settings.merge.integrationBranch", "Integration branch")}</label>
        {(() => {
            const currentValue = form.integrationBranch ?? "";
            const valueIsKnown = currentValue.length > 0 && integrationBranchOptions.includes(currentValue);
            const isCustomMode = integrationBranchCustomMode || (currentValue.length > 0 && !valueIsKnown);
            if (isCustomMode) {
                return (<div className="form-inline-group">
                <input id="integrationBranch" type="text" className="input" placeholder={t("settings.merge.branchName", "branch name")} value={currentValue} onChange={(e) => {
                        const trimmed = e.target.value.trim();
                        setForm((f) => ({
                            ...f,
                            integrationBranch: trimmed.length === 0 ? undefined : trimmed,
                        }));
                    }} data-testid="integration-branch-custom-input"/>
                <button type="button" className="btn-link" onClick={() => {
                        setIntegrationBranchCustomMode(false);
                        setForm((f) => ({ ...f, integrationBranch: undefined }));
                    }} data-testid="integration-branch-use-dropdown">{t("settings.merge.useDropdown", " Use dropdown ")}</button>
              </div>);
            }
            const CUSTOM = "__fusion-custom__";
            const AUTO = "";
            return (<select id="integrationBranch" className="select" value={currentValue} onChange={(e) => {
                    const next = e.target.value;
                    if (next === CUSTOM) {
                        setIntegrationBranchCustomMode(true);
                        return;
                    }
                    setForm((f) => ({
                        ...f,
                        integrationBranch: next === AUTO ? undefined : next,
                    }));
                }} data-testid="integration-branch-select">
              <option value={AUTO}>{t("settings.merge.autoDetectOriginHEADMain", "(auto-detect \u2014 origin/HEAD \u2192 main)")}</option>
              {integrationBranchOptions.map((name) => (<option key={name} value={name}>{name}</option>))}
              <option value={CUSTOM}>{t("settings.merge.custom", "Custom\u2026")}</option>
            </select>);
        })()}
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.theCanonicalBranchFusionMergesTasksIntoAnd", " No default \u2014 unset (auto-detect). The canonical branch Fusion merges tasks into and uses as the reference for all ahead/behind / overlap / pre-rebase computations. Leave on ")}<em>{t("settings.merge.autoDetect", "auto-detect")}</em>{t("settings.merge.toResolveViaTheStandardCascade", " to resolve via the standard cascade (")}<code>integrationBranch</code>{t("settings.merge.legacy", " \u2192 legacy ")}<code>baseBranch</code> →
            <code>origin/HEAD</code>{t("settings.merge.symbolicRefFallback", " symbolic ref \u2192 fallback ")}<code>main</code>{t("settings.merge.pickALocalBranchFromTheDropdownCommon", "). Pick a local branch from the dropdown \u2014 common integration names like ")}<code>main</code>,
            <code>master</code>, <code>trunk</code>{t("settings.merge.and", ", and ")}<code>develop</code>{t("settings.merge.areListedFirstOrChoose", " are listed first \u2014 or choose ")}<em>{t("settings.merge.custom", "Custom\u2026")}</em>{t("settings.merge.toTypeABranchThatDoesnAposT", " to type a branch that doesn't exist locally yet. Applies to both direct merges and pull-request mode; individual tasks can still override via task metadata. ")}</small>
        </details>
      </div>
      {form.mergeStrategy !== "pull-request" && (form.merger?.mode ?? "ai") !== "ai" && (<>
          <div className="form-group">
            <label htmlFor="directMergeCommitStrategy">{t("settings.merge.directMergeCommitRouting", "Direct merge commit routing")}</label>
            <select id="directMergeCommitStrategy" className="select" value={form.directMergeCommitStrategy ?? "always-squash"} onChange={(e) => setForm((f) => ({
                ...f,
                directMergeCommitStrategy: e.target.value as "auto" | "always-squash" | "always-rebase",
            }))}>
              <option value="auto">{t("settings.merge.autoSquashSingleSubstantiveBranchesPreserveMultiSubstantive", "Auto \u2014 squash single-substantive branches, preserve multi-substantive history")}</option>
              <option value="always-squash">{t("settings.merge.alwaysSquashDirectMerges", "Always squash direct merges (default)")}</option>
              <option value="always-rebase">{t("settings.merge.alwaysPreserveDirectMergeCommitHistory", "Always preserve direct-merge commit history")}</option>
            </select>
            <details className="settings-option-details">
              <summary>{t("settings.merge.moreDetails", "More details")}</summary>
              <small>{t("settings.merge.autoKeepsTodayAposSSquashBehaviorFor", " Auto keeps today's squash behavior for branches with zero or one substantive commit, but switches multi-substantive branches to a history-preserving rebase-and-merge path. Individual tasks can override this in PROMPT.md with ")}<code>**Direct Merge Commit Strategy:** auto|always-squash|always-rebase</code>.
              </small>
            </details>
          </div>
          <div className="form-group">
            <label htmlFor="mergeIntegrationWorktree">{t("settings.merge.integrationWorktree", "Integration worktree")}</label>
            <select id="mergeIntegrationWorktree" className="select" value={form.mergeIntegrationWorktree ?? "reuse-task-worktree"} onChange={(e) => setForm((f) => ({
                ...f,
                mergeIntegrationWorktree: e.target.value as Settings["mergeIntegrationWorktree"],
            }))}>
              <option value="reuse-task-worktree">{t("settings.merge.reuseTaskWorktreeDefault", "Reuse task worktree (default)")}</option>
              <option value="cwd-main">{t("settings.merge.useProjectRootLegacy", "Use project root (legacy)")}</option>
            </select>
            <small>{t("settings.merge.autoMergeRunsInTheTaskWorktreeBy", " Auto-merge runs in the task worktree by default. Switch to the legacy project-root path only if you need the pre-FN-5279 fallback; worktrunk-managed projects still defer to worktrunk. ")}</small>
            {(form.mergeIntegrationWorktree ?? "reuse-task-worktree") !== "reuse-task-worktree" && (<div className="settings-warning-banner" role="alert" aria-live="polite" data-testid="merge-integration-worktree-warning">
                <strong>{t("settings.merge.legacyIntegrationBranchMode", "Legacy integration-branch mode.")}</strong>{" "}{t("settings.merge.autoMergeWillRunRebaseConflictResolutionAnd", " Auto-merge will run rebase, conflict resolution, and squash commits inside the project root (the user's checked-out integration-branch worktree) instead of the task worktree. Fusion assumes that directory is already on the integration branch and clean; if it isn't, merges may fail or touch the user's working tree. Reuse-task-worktree is the recommended default (FN-5279). Switch back unless you have a specific reason to opt in (FN-5348). ")}</div>)}
          </div>
          <div className="form-group">
            <label htmlFor="mergeAdvanceAutoSync">{t("settings.merge.autoSyncProjectCheckoutAfterMerge", "Auto-sync project checkout after merge")}</label>
            <select id="mergeAdvanceAutoSync" className="select" value={form.mergeAdvanceAutoSync ?? "stash-and-ff"} onChange={(e) => setForm((f) => ({
                ...f,
                mergeAdvanceAutoSync: e.target.value as "off" | "ff-only" | "stash-and-ff",
            }))} data-testid="merge-advance-auto-sync-select">
              <option value="stash-and-ff">{t("settings.merge.stashFastForwardDefaultPreserveLocalEdits", "Stash + fast-forward (default) \u2014 preserve local edits")}</option>
              <option value="ff-only">{t("settings.merge.fastForwardOnlySkipDirtyWorktrees", "Fast-forward only \u2014 skip dirty worktrees")}</option>
              <option value="off">{t("settings.merge.offLeaveTheProjectRootStaleLegacyBehavior", "Off \u2014 leave the project root stale (legacy behavior)")}</option>
            </select>
            <details className="settings-option-details">
              <summary>{t("settings.merge.moreDetails", "More details")}</summary>
              <small>{t("settings.merge.afterFusionAdvancesTheIntegrationBranchRefThe", " After Fusion advances the integration branch ref, the merger can auto-sync other worktrees still checked out on that branch (typically your project-root checkout). ")}<code>Stash + fast-forward</code>{t("settings.merge.snapshotsRealLocalEditsAsAPatchAgainst", " snapshots real local edits as a patch against the previous tip, snaps the worktree to the new tip, then reapplies the patch \u2014 untracked files that collide with newly-tracked paths are left in a temp dir for manual recovery. ")}<code>Fast-forward only</code>{t("settings.merge.snapsCleanlyWhenTheWorktreeHasNoEdits", " snaps cleanly when the worktree has no edits and skips otherwise. ")}<code>Off</code>{t("settings.merge.isTheLegacyBehavior", " is the legacy behavior: ")}<code>git status</code>{t("settings.merge.inYourProjectRootWillShowTheNew", " in your project root will show the new commits inverted as &quot;staged changes&quot; until you pull manually. Only applies to direct merges. ")}</small>
            </details>
          </div>
        </>)}
      {/*
        FNXC:SourceControl 2026-07-15-20:30:
        The GitHub Authentication and GitLab Authentication blocks moved to "Source Control · Project" (SourceControlSection.tsx), joining the GitHub tracking + GitLab URL settings that were in General. Merge owns the landing strategy; how Fusion authenticates to a forge is a source-control concern that Merge only consumed.
        This section's GitLab auth disclosure carried a SECOND `gitlabEnabled` toggle (id `mergeGitlabEnabled`) writing the same key as General's — removing it here is what resolves that duplicate, so do not reintroduce a forge auth control in Merge.
      */}
      <div className="form-group">
        <label htmlFor="includeTaskIdInCommit" className="checkbox-label">
          <input id="includeTaskIdInCommit" type="checkbox" checked={form.includeTaskIdInCommit !== false} onChange={(e) => setForm((f) => ({ ...f, includeTaskIdInCommit: e.target.checked }))}/>{t("settings.merge.includeTaskIDInCommitScope", " Include task ID in commit scope ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.whenDisabledMergeCommitMessagesOmitTheTask", "When disabled, merge commit messages omit the task ID from the scope (e.g. ")}<code>feat: ...</code>{t("settings.merge.insteadOf", " instead of ")}<code>feat(KB-001): ...</code>{t("settings.merge.includeTaskIdInCommitDefault", "). Default: enabled.")}</small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="commitAuthorEnabled" className="checkbox-label">
          <input id="commitAuthorEnabled" type="checkbox" checked={form.commitAuthorEnabled !== false} onChange={(e) => setForm((f) => ({ ...f, commitAuthorEnabled: e.target.checked }))}/>{t("settings.merge.addFusionAsCoAuthorOnCommits", " Add Fusion as co-author on commits ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.whenEnabledCommitsMadeByFusionKeepYour", " When enabled, commits made by Fusion keep your git identity as the primary author and append a ")}<code>Co-authored-by</code>{t("settings.merge.trailerCreditingFusionRecognizedByGitHubForShared", " trailer crediting Fusion (recognized by GitHub for shared attribution). Default: enabled. ")}</small>
        </details>
      </div>

      {form.commitAuthorEnabled !== false && (<>
          <div className="form-group">
            <label htmlFor="commitAuthorName">{t("settings.merge.coAuthorName", "Co-author Name")}</label>
            <input id="commitAuthorName" type="text" value={form.commitAuthorName ?? ""} placeholder={t("settings.merge.fusion", "Fusion")} onChange={(e) => setForm((f) => ({
                ...f,
                commitAuthorName: e.target.value || undefined,
            }))}/>
            <small>{t("settings.merge.nameUsedInThe", "Name used in the ")}<code>Co-authored-by</code>{t("settings.merge.trailer", " trailer. Default: Fusion.")}</small>
          </div>
          <div className="form-group">
            <label htmlFor="commitAuthorEmail">{t("settings.merge.coAuthorEmail", "Co-author Email")}</label>
            <input id="commitAuthorEmail" type="email" value={form.commitAuthorEmail ?? ""} placeholder={t("settings.merge.noreplyRunfusionAi", "noreply@runfusion.ai")} onChange={(e) => setForm((f) => ({
                ...f,
                commitAuthorEmail: e.target.value || undefined,
            }))}/>
            <small>{t("settings.merge.emailUsedInThe", "Email used in the ")}<code>Co-authored-by</code>{t("settings.merge.trailerEmail", " trailer. Default: noreply@runfusion.ai.")}</small>
          </div>
        </>)}

      <div className="form-group">
        <label htmlFor="autoResolveConflicts" className="checkbox-label">
          <input id="autoResolveConflicts" type="checkbox" checked={form.autoResolveConflicts !== false} onChange={(e) => setForm((f) => ({ ...f, autoResolveConflicts: e.target.checked }))}/>{t("settings.merge.autoResolveConflictsInLockFilesAndGenerated", " Auto-resolve conflicts in lock files and generated files ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.whenEnabledLockFilesPackageLockJsonPnpm", "When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.), generated files (dist/*, *.gen.ts), and trivial whitespace conflicts are resolved automatically without AI intervention. Complex code conflicts still require AI review. Default: enabled.")}</small>
        </details>
      </div>
      {(form.merger?.mode ?? "ai") !== "ai" && (<>
      <div className="form-group">
        <label htmlFor="smartConflictResolution" className="checkbox-label">
          <input id="smartConflictResolution" type="checkbox" checked={form.smartConflictResolution !== false} onChange={(e) => setForm((f) => ({ ...f, smartConflictResolution: e.target.checked }))}/>{t("settings.merge.smartConflictResolution", " Smart conflict resolution ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.whenEnabledLockFilesPackageLockJsonPnpm2", "When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.) are resolved using 'ours' strategy, generated files (dist/*, *.gen.ts) using 'theirs' strategy, and trivial whitespace conflicts are auto-resolved without spawning an AI agent. Complex code conflicts still require AI review. Default: enabled.")}</small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="mergeConflictStrategy">{t("settings.merge.conflictFallbackStrategy", "Conflict Fallback Strategy")}</label>
        <select id="mergeConflictStrategy" value={form.mergeConflictStrategy ?? "smart-prefer-main"} onChange={(e) => setForm((f) => ({ ...f, mergeConflictStrategy: e.target.value as "smart-prefer-main" | "smart-prefer-branch" | "ai-only" | "abort" }))}>
          <option value="smart-prefer-main">{t("settings.merge.smartPreferMainOnFallbackFetchFfOrigin", "Smart, prefer main on fallback \u2014 fetch+ff origin \u2192 AI \u2192 auto-resolve \u2192 -X ours (default; protects just-merged sibling work)")}</option>
          <option value="smart-prefer-branch">{t("settings.merge.smartPreferTaskOnFallbackFetchFfOrigin", "Smart, prefer task on fallback \u2014 fetch+ff origin \u2192 AI \u2192 auto-resolve \u2192 -X theirs (legacy \"smart\" behavior; task branch wins)")}</option>
          <option value="ai-only">{t("settings.merge.aIOnlyAIAutoResolveAIRetryNever", "AI only \u2014 AI \u2192 auto-resolve \u2192 AI retry; never silently pick a side")}</option>
          <option value="abort">{t("settings.merge.abortOneAIAttemptRequireManualResolutionIf", "Abort \u2014 one AI attempt; require manual resolution if it fails")}</option>
        </select>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.both", " Both ")}<strong>{t("settings.merge.smart", "Smart")}</strong>{t("settings.merge.optionsStartWithABestEffort", " options start with a best-effort ")}<code>git fetch</code>{t("settings.merge.fastForwardOfLocalMainFrom", " + fast-forward of local main from ")}<code>origin</code>{t("settings.merge.soAFreshlyPushedSiblingCommitDoesntGet", " (so a freshly-pushed sibling commit doesn't get clobbered), then run an AI agent, then auto-resolve handles lock/generated/trivial files. They differ only in the ")}<em>{t("settings.merge.finalFallback", "final fallback")}</em>:
            {" "}
            <strong>{t("settings.merge.smartPreferMain", "Smart, prefer main")}</strong>{t("settings.merge.uses", " uses ")}<code>-X ours</code>{t("settings.merge.soMainWinsProtectsJustMergedSiblingWork", " so main wins \u2014 protects just-merged sibling work and is the new default. ")}{" "}
            <strong>{t("settings.merge.smartPreferTask", "Smart, prefer task")}</strong>{t("settings.merge.uses", " uses ")}<code>-X theirs</code>{t("settings.merge.soTheTaskBranchWinsFastButCan", " so the task branch wins \u2014 fast, but can resurrect code an earlier sibling task deleted (the FN-2887 class of regression). ")}{" "}
            <strong>{t("settings.merge.aIOnly", "AI only")}</strong>{t("settings.merge.retriesTheAIAgentRatherThanAutoPicking", " retries the AI agent rather than auto-picking a side. ")}{" "}
            <strong>{t("settings.merge.abort", "Abort")}</strong>{t("settings.merge.stopsAfterTheFirstAIAttemptAndWaits", " stops after the first AI attempt and waits for a human. ")}{" "}
            <em>{t("settings.merge.legacy2", "Legacy ")}<code>"smart"</code>{t("settings.merge.and2", " and ")}<code>"prefer-main"</code>{t("settings.merge.valuesFromOlderSettingsAreMigratedAutomatically", " values from older settings are migrated automatically.")}</em>
          </small>
        </details>
      </div>
      <SettingsSelectRow
        descriptor={{
          key: "mergeStrategyOverlapBehavior",
          label: t("settings.merge.smartPreferMainOverlapGuard", "Smart Prefer Main Overlap Guard"),
          help: t("settings.merge.whenUsingSmartPreferMainAutomaticallyPreferThe", " When using smart-prefer-main, automatically prefer the branch side for files that main has recently modified to avoid silently discarding branch work. "),
          scope: "project",
          options: [
            { value: "flip-to-prefer-branch", label: t("settings.merge.flipOverlappingFilesToPreferTheTaskBranch", "Flip overlapping files to prefer the task branch (default)") },
            { value: "warn-only", label: t("settings.merge.warnOnlyKeepLegacyMainWinsFallback", "Warn only \u2014 keep legacy main-wins fallback") },
            { value: "ignore", label: t("settings.merge.ignoreOverlapDetectionPreserveLegacyBehavior", "Ignore overlap detection \u2014 preserve legacy behavior") },
          ],
        }}
        value={form.mergeStrategyOverlapBehavior ?? "flip-to-prefer-branch"}
        onChange={(v) => setForm((f) => ({
                ...f,
                mergeStrategyOverlapBehavior: v as "flip-to-prefer-branch" | "warn-only" | "ignore",
            }))}
      />
      <div className="form-group">
        <label htmlFor="postMergeAuditMode">{t("settings.merge.postMergeAuditMode", "Post-merge audit mode")}</label>
        <select className="select" id="postMergeAuditMode" value={form.postMergeAuditMode ?? "warn"} onChange={(e) => setForm((f) => ({
                ...f,
                postMergeAuditMode: e.target.value as "block" | "warn" | "off",
            }))}>
          <option value="block">{t("settings.merge.blockStrict", "Block (strict)")}</option>
          <option value="warn">{t("settings.merge.warnDefaultLogFindingsContinue", "Warn (default; log findings, continue)")}</option>
          <option value="off">{t("settings.merge.offSkipAudit", "Off (skip audit)")}</option>
        </select>
        <small>{t("settings.merge.controlsThePostMergeAuditGate", " Controls the post-merge audit gate. ")}<strong>{t("settings.merge.warn", "Warn")}</strong>{t("settings.merge.defaultLogsFindingsButAutoCompletesTheMerge", " (default) logs findings but auto-completes the merge. ")}<strong>{t("settings.merge.block", "Block")}</strong>{t("settings.merge.isTheStricterOptInModeThatRefuses", " is the stricter opt-in mode that refuses to auto-complete merges with duplicate-subject or touched-file overlap risks. ")}<strong>{t("settings.merge.off", "Off")}</strong>{t("settings.merge.skipsTheAuditEntirelySwitchingToOffIs", " skips the audit entirely. Switching to Off is recommended only if you trust your branches don't silently drop edits. ")}</small>
      </div>
      </>)}
      <div className="form-group">
        <label htmlFor="pushAfterMerge" className="checkbox-label">
          <input id="pushAfterMerge" type="checkbox" checked={form.pushAfterMerge === true} onChange={(e) => setForm((f) => ({ ...f, pushAfterMerge: e.target.checked }))}/>{t("settings.merge.pushToRemoteAfterMerge", " Push to remote after merge ")}</label>
        <details className="settings-option-details">
          <summary>{t("settings.merge.moreDetails", "More details")}</summary>
          <small>{t("settings.merge.whenEnabledTheMergedResultIsAutomaticallyPushed", "When enabled, the merged result is automatically pushed to the configured git remote. This includes pulling the latest from the remote first (rebase) and resolving any conflicts with AI if needed. Default: disabled.")}</small>
        </details>
      </div>

      {form.pushAfterMerge && (gitRemoteOptions.length === 0 ? (<div className="form-group">
          <label htmlFor="pushRemote">{t("settings.merge.pushRemote", "Push Remote")}</label>
          <input id="pushRemote" type="text" placeholder={t("settings.merge.origin", "origin")} value={form.pushRemote || ""} onChange={(e) => setForm((f) => ({ ...f, pushRemote: e.target.value || undefined }))}/>
          <details className="settings-option-details">
            <summary>{t("settings.merge.moreDetails", "More details")}</summary>
            <small>{t("settings.merge.gitRemoteToPushToEGOrigin", "Git remote to push to (e.g. \"origin\"). Can include branch name (e.g. \"origin main\"). Default: \"origin\".")}</small>
          </details>
        </div>) : (<>
          <div className="form-group">
            <label htmlFor="pushRemote">{t("settings.merge.pushRemote", "Push Remote")}</label>
            <select id="pushRemote" className="select" value={pushTarget.remote} onChange={(e) => {
                // Capture eagerly: the deferred setForm updater must not read the
                // controlled select's value after React resets it on re-render.
                const nextRemote = e.target.value;
                // Branches differ per remote — reset the target branch to the default.
                setPushBranchCustomMode(false);
                setForm((f) => ({ ...f, pushRemote: composePushRemoteSetting(nextRemote, "") }));
            }} data-testid="push-remote-select">
              {!gitRemoteOptions.includes(pushTarget.remote) && (<option value={pushTarget.remote}>{pushTarget.remote}</option>)}
              {gitRemoteOptions.map((name) => (<option key={name} value={name}>{name}</option>))}
            </select>
            <details className="settings-option-details">
              <summary>{t("settings.merge.moreDetails", "More details")}</summary>
              <small>{t("settings.merge.gitRemoteThatMergedResultsArePushedTo", "Git remote that merged results are pushed to. Default: \"origin\".")}</small>
            </details>
          </div>
          <div className="form-group">
            <label htmlFor="pushRemoteBranch">{t("settings.merge.pushTargetBranch", "Push target branch")}</label>
            {(() => {
                const currentBranch = pushTarget.branch;
                const branchIsKnown = currentBranch.length > 0 && pushBranchOptions.includes(currentBranch);
                if (pushBranchCustomMode || (currentBranch.length > 0 && !branchIsKnown)) {
                    return (<div className="form-inline-group">
                        <input id="pushRemoteBranch" type="text" className="input" placeholder={t("settings.merge.branchName", "branch name")} value={currentBranch} onChange={(e) => {
                            const trimmed = e.target.value.trim();
                            setForm((f) => ({ ...f, pushRemote: composePushRemoteSetting(pushTarget.remote, trimmed) }));
                        }} data-testid="push-remote-branch-custom-input"/>
                        <button type="button" className="btn-link" onClick={() => {
                            setPushBranchCustomMode(false);
                            setForm((f) => ({ ...f, pushRemote: composePushRemoteSetting(pushTarget.remote, "") }));
                        }} data-testid="push-remote-branch-use-dropdown">{t("settings.merge.useDropdown", " Use dropdown ")}</button>
                    </div>);
                }
                const CUSTOM = "__fusion-custom__";
                return (<select id="pushRemoteBranch" className="select" value={currentBranch} onChange={(e) => {
                        const next = e.target.value;
                        if (next === CUSTOM) {
                            setPushBranchCustomMode(true);
                            return;
                        }
                        setForm((f) => ({ ...f, pushRemote: composePushRemoteSetting(pushTarget.remote, next) }));
                    }} data-testid="push-remote-branch-select">
                  <option value="">{t("settings.merge.sameAsIntegrationBranchDefault", "(same as integration branch — default)")}</option>
                  {pushBranchOptions.map((name) => (<option key={name} value={name}>{name}</option>))}
                  <option value={CUSTOM}>{t("settings.merge.custom", "Custom…")}</option>
                </select>);
            })()}
            <details className="settings-option-details">
              <summary>{t("settings.merge.moreDetails", "More details")}</summary>
              <small>{t("settings.merge.pushTargetBranchHelp", "Branch on the remote that merged results are pushed to. Leave on the default to push the integration branch to its same-named remote branch; pick a listed remote branch or choose Custom… to type one that doesn't exist on the remote yet (the push creates it).")}</small>
            </details>
          </div>
        </>))}
    </>);
}
export default MergeSection;
