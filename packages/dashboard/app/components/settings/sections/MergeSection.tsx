/**
 * Merge section (U9 / KTD-10).
 *
 * Project-scoped merge policy: auto-merge, AI-merge mode + review passes, test
 * mode, merge strategy / integration branch, direct-merge routing, GitHub auth,
 * commit attribution, and conflict-resolution strategy. The review/verification
 * scope-enforcement knobs moved to the workflow (U4) and render as a redirect
 * stub. The integration-branch custom-mode toggle is shell state (it interplays
 * with the fetched branch-option list) and relayed as props. Keys, conditional
 * visibility, and the legacy-mode warning banner are preserved verbatim from the
 * original inline JSX.
 */
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Settings } from "@fusion/core";
import { MovedSettingsStub } from "./MovedSettingsStub";
import type { SectionBaseProps } from "./context";

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

export interface MergeSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  integrationBranchOptions: string[];
  integrationBranchCustomMode: boolean;
  setIntegrationBranchCustomMode: (value: boolean) => void;
  onOpenWorkflowSettings?: () => void;
}

export function MergeSection({
  scopeBanner,
  form,
  setForm,
  integrationBranchOptions,
  integrationBranchCustomMode,
  setIntegrationBranchCustomMode,
  onOpenWorkflowSettings,
}: MergeSectionProps) {
  const { t } = useTranslation("app");
  const [legacyStampCandidates, setLegacyStampCandidates] = useState<LegacyAutoMergeStampCandidate[]>([]);
  const [legacyStampLoading, setLegacyStampLoading] = useState(true);
  const [legacyStampApplying, setLegacyStampApplying] = useState(false);
  const [legacyStampError, setLegacyStampError] = useState<string | null>(null);
  const [legacyStampSuccess, setLegacyStampSuccess] = useState<string | null>(null);

  const loadLegacyAutoMergeStamps = useCallback(async () => {
    setLegacyStampLoading(true);
    setLegacyStampError(null);
    try {
      const data = await readLegacyAutoMergeStampResponse(
        await fetch("/api/maintenance/legacy-automerge-stamps"),
      );
      setLegacyStampCandidates(Array.isArray(data.candidates) ? data.candidates : []);
    } catch (err) {
      setLegacyStampError(err instanceof Error ? err.message : "Failed to load legacy auto-merge stamps");
    } finally {
      setLegacyStampLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLegacyAutoMergeStamps();
  }, [loadLegacyAutoMergeStamps]);

  const applyLegacyAutoMergeStampCleanup = async () => {
    const confirmed = window.confirm(
      "Apply cleanup for legacy auto-merge stamps? This clears only legacy non-override in-review stamps returned by the store and never touches genuine per-task overrides.",
    );
    if (!confirmed) return;
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
    } catch (err) {
      setLegacyStampError(err instanceof Error ? err.message : "Failed to apply legacy auto-merge stamp cleanup");
    } finally {
      setLegacyStampApplying(false);
    }
  };

  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Merge</h4>
      <div className="form-group">
        <label htmlFor="autoMerge" className="checkbox-label">
          <input
            id="autoMerge"
            type="checkbox"
            checked={form.autoMerge}
            onChange={(e) =>
              setForm((f) => ({ ...f, autoMerge: e.target.checked }))
            }
          />
          Auto-merge completed tasks
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>When enabled, tasks that pass review are automatically merged into the main branch</small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="maxAutoMergeRetries">Auto-merge conflict retries</label>
        {/*
          FNXC:AutoMergeRetries 2026-06-17-04:20:
          Operators need a merge-section control for maxAutoMergeRetries so conflict-heavy projects can tune how many auto-resolution attempts occur before Fusion parks a task for human recovery. Invalid input falls back to 3 to preserve prior behavior.
        */}
        <input
          id="maxAutoMergeRetries"
          type="number"
          min={1}
          step={1}
          value={form.maxAutoMergeRetries ?? 3}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              maxAutoMergeRetries: e.target.value === "" ? undefined : resolveMaxAutoMergeRetriesForMergeForm(e.target.value),
            }))
          }
        />
        <small>Positive integer retry cap for auto-merge conflict resolution before a task parks for human recovery. Default 3.</small>
      </div>
      <div className="form-group" data-testid="legacy-automerge-stamp-cleanup-panel">
        <h5 className="settings-section-heading">Legacy auto-merge stamp cleanup</h5>
        <small>
          Finds in-review tasks whose auto-merge value came from the legacy review-entry stamp.
          Dry-run is automatic; applying delegates to the store cleanup and preserves genuine
          per-task overrides.
        </small>
        {legacyStampLoading ? (
          <small aria-live="polite">Checking for legacy auto-merge stamps…</small>
        ) : legacyStampCandidates.length === 0 ? (
          <small data-testid="legacy-automerge-stamp-empty-state">
            No legacy auto-merge stamps to clean up.
          </small>
        ) : (
          <>
            <small>{legacyStampCandidates.length} legacy auto-merge stamp{legacyStampCandidates.length === 1 ? "" : "s"} ready to clean up.</small>
            <ul>
              {legacyStampCandidates.map((candidate) => (
                <li key={candidate.taskId} data-testid="legacy-automerge-stamp-candidate-row">
                  <strong>{candidate.taskId}</strong> — {candidate.column}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn"
              onClick={applyLegacyAutoMergeStampCleanup}
              disabled={legacyStampApplying}
              data-testid="legacy-automerge-stamp-apply-button"
            >
              {legacyStampApplying ? "Applying cleanup…" : "Apply cleanup"}
            </button>
          </>
        )}
        {legacyStampSuccess ? <small className="settings-success" aria-live="polite">{legacyStampSuccess}</small> : null}
        {legacyStampError ? <small className="settings-error" role="alert">{legacyStampError}</small> : null}
      </div>
      <div className="form-group">
        <label htmlFor="mergerMode">AI merge</label>
        <select
          id="mergerMode"
          className="select"
          value={form.merger?.mode ?? "ai"}
          onChange={(e) =>
            setForm((f) => ({ ...f, merger: { ...(f.merger ?? {}), mode: e.target.value as "ai" | "deterministic" } }))
          }
        >
          <option value="ai">AI merge (default) — AI merges in a clean room, an AI reviewer audits with retries, then lands</option>
          <option value="deterministic">Deterministic (legacy) — rebase / conflict-strategy / audit pipeline</option>
        </select>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>
            AI mode merges the task branch into an isolated clean-room checkout at the target
            branch&apos;s tip, has an AI reviewer audit the squash (with corrective retries —
            advisory concerns land with a logged warning, an unfixable correctness concern
            hard-fails), then fast-forwards the target branch and syncs your local checkout
            (AI reconciles a conflicting restore). Each task merges to its own target branch,
            or the default integration branch. <strong>The legacy merge settings below do not
            apply while AI merge is on.</strong>
          </small>
        </details>
      </div>
      {(form.merger?.mode ?? "ai") === "ai" && (
        <>
          <div className="form-group">
            <label htmlFor="mergerMaxReviewPasses">Max AI review passes</label>
            <input
              id="mergerMaxReviewPasses"
              type="number"
              min={0}
              max={10}
              value={form.merger?.maxReviewPasses ?? 3}
              onChange={(e) =>
                setForm((f) => ({ ...f, merger: { ...(f.merger ?? {}), maxReviewPasses: e.target.value === "" ? undefined : Number(e.target.value) } }))
              }
            />
            <small>AI corrective rounds before landing the best result (advisory concern) or hard-failing (unfixable correctness concern). Default 3. The reviewer uses your project&apos;s reviewer/validator model.</small>
          </div>
          <div className="form-group">
            <label htmlFor="mergerAllowDirtyLocalCheckoutSync" className="checkbox-label">
              <input
                id="mergerAllowDirtyLocalCheckoutSync"
                type="checkbox"
                checked={form.merger?.allowDirtyLocalCheckoutSync === true}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    merger: { ...(f.merger ?? {}), allowDirtyLocalCheckoutSync: e.target.checked },
                  }))
                }
              />
              Allow AI merge to sync a dirty checked-out integration branch
            </label>
            <details className="settings-option-details">
              <summary>More details</summary>
              <small>
                Dangerous compatibility escape hatch. Leave off unless you explicitly want the legacy
                stash → fast-forward → restore behavior when your checked-out integration branch has
                unrelated local edits. When off, AI merge blocks before advancing the branch so dirty
                project-root edits cannot contaminate a completed merge.
              </small>
            </details>
          </div>
        </>
      )}
      <div className="form-group">
        <label htmlFor="testMode" className="checkbox-label">
          <input
            id="testMode"
            type="checkbox"
            checked={form.testMode === true}
            onChange={(e) =>
              setForm((f) => ({ ...f, testMode: e.target.checked }))
            }
          />
          Enable test mode
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>Forces all AI lanes to use the deterministic mock provider. No network calls, zero token cost.</small>
        </details>
      </div>
      <MovedSettingsStub
        message={t(
          "settings.movedStub.reviewVerification",
          "Review, verification auto-fix, and scope-enforcement settings now live on the workflow.",
        )}
        onOpenWorkflowSettings={onOpenWorkflowSettings}
      />
      <div className="form-group">
        <label htmlFor="mergeStrategy">Auto-completion mode</label>
        <select
          id="mergeStrategy"
          value={form.mergeStrategy || "direct"}
          onChange={(e) =>
            setForm((f) => ({ ...f, mergeStrategy: e.target.value as Settings["mergeStrategy"] }))
          }
        >
          <option value="direct">Direct merge into the current branch</option>
          <option value="pull-request">Create, monitor, and merge a GitHub pull request</option>
        </select>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>
            Controls what happens after a task reaches In Review. Direct mode merges into the current branch locally. Pull request mode keeps the task in In Review while Fusion waits for GitHub reviews and required checks before merging the PR.
          </small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="integrationBranch">Integration branch</label>
        {(() => {
          const currentValue = form.integrationBranch ?? "";
          const valueIsKnown = currentValue.length > 0 && integrationBranchOptions.includes(currentValue);
          const isCustomMode = integrationBranchCustomMode || (currentValue.length > 0 && !valueIsKnown);
          if (isCustomMode) {
            return (
              <div className="form-inline-group">
                <input
                  id="integrationBranch"
                  type="text"
                  className="input"
                  placeholder="branch name"
                  value={currentValue}
                  onChange={(e) => {
                    const trimmed = e.target.value.trim();
                    setForm((f) => ({
                      ...f,
                      integrationBranch: trimmed.length === 0 ? undefined : trimmed,
                    }));
                  }}
                  data-testid="integration-branch-custom-input"
                />
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setIntegrationBranchCustomMode(false);
                    setForm((f) => ({ ...f, integrationBranch: undefined }));
                  }}
                  data-testid="integration-branch-use-dropdown"
                >
                  Use dropdown
                </button>
              </div>
            );
          }
          const CUSTOM = "__fusion-custom__";
          const AUTO = "";
          return (
            <select
              id="integrationBranch"
              className="select"
              value={currentValue}
              onChange={(e) => {
                const next = e.target.value;
                if (next === CUSTOM) {
                  setIntegrationBranchCustomMode(true);
                  return;
                }
                setForm((f) => ({
                  ...f,
                  integrationBranch: next === AUTO ? undefined : next,
                }));
              }}
              data-testid="integration-branch-select"
            >
              <option value={AUTO}>(auto-detect — origin/HEAD → main)</option>
              {integrationBranchOptions.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
              <option value={CUSTOM}>Custom…</option>
            </select>
          );
        })()}
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>
            The canonical branch Fusion merges tasks into and uses as the reference for all
            ahead/behind / overlap / pre-rebase computations. Leave on <em>auto-detect</em>
            to resolve via the standard cascade
            (<code>integrationBranch</code> → legacy <code>baseBranch</code> →
            <code>origin/HEAD</code> symbolic ref → fallback <code>main</code>). Pick a
            local branch from the dropdown — common integration names like <code>main</code>,
            <code>master</code>, <code>trunk</code>, and <code>develop</code> are listed
            first — or choose <em>Custom…</em> to type a branch that doesn&apos;t exist
            locally yet. Applies to both direct merges and pull-request mode; individual
            tasks can still override via task metadata.
          </small>
        </details>
      </div>
      {form.mergeStrategy !== "pull-request" && (form.merger?.mode ?? "ai") !== "ai" && (
        <>
          <div className="form-group">
            <label htmlFor="directMergeCommitStrategy">Direct merge commit routing</label>
            <select
              id="directMergeCommitStrategy"
              className="select"
              value={form.directMergeCommitStrategy ?? "always-squash"}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  directMergeCommitStrategy: e.target.value as "auto" | "always-squash" | "always-rebase",
                }))
              }
            >
              <option value="auto">Auto — squash single-substantive branches, preserve multi-substantive history</option>
              <option value="always-squash">Always squash direct merges</option>
              <option value="always-rebase">Always preserve direct-merge commit history</option>
            </select>
            <details className="settings-option-details">
              <summary>More details</summary>
              <small>
                Auto keeps today&apos;s squash behavior for branches with zero or one substantive commit, but switches multi-substantive branches to a history-preserving rebase-and-merge path. Individual tasks can override this in PROMPT.md with <code>**Direct Merge Commit Strategy:** auto|always-squash|always-rebase</code>.
              </small>
            </details>
          </div>
          <div className="form-group">
            <label htmlFor="mergeIntegrationWorktree">Integration worktree</label>
            <select
              id="mergeIntegrationWorktree"
              className="select"
              value={form.mergeIntegrationWorktree ?? "reuse-task-worktree"}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  mergeIntegrationWorktree: e.target.value as Settings["mergeIntegrationWorktree"],
                }))
              }
            >
              <option value="reuse-task-worktree">Reuse task worktree (default)</option>
              <option value="cwd-main">Use project root (legacy)</option>
            </select>
            <small>
              Auto-merge runs in the task worktree by default. Switch to the legacy project-root path only if you need the pre-FN-5279 fallback; worktrunk-managed projects still defer to worktrunk.
            </small>
            {(form.mergeIntegrationWorktree ?? "reuse-task-worktree") !== "reuse-task-worktree" && (
              <div
                className="settings-warning-banner"
                role="alert"
                aria-live="polite"
                data-testid="merge-integration-worktree-warning"
              >
                <strong>Legacy integration-branch mode.</strong>{" "}
                Auto-merge will run rebase, conflict resolution, and squash commits inside the
                project root (the user&apos;s checked-out integration-branch worktree) instead of
                the task worktree. Fusion assumes that directory is already on the integration
                branch and clean; if it isn&apos;t, merges may fail or touch the user&apos;s working
                tree. Reuse-task-worktree is the recommended default (FN-5279). Switch back unless
                you have a specific reason to opt in (FN-5348).
              </div>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="mergeAdvanceAutoSync">Auto-sync project checkout after merge</label>
            <select
              id="mergeAdvanceAutoSync"
              className="select"
              value={form.mergeAdvanceAutoSync ?? "stash-and-ff"}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  mergeAdvanceAutoSync: e.target.value as "off" | "ff-only" | "stash-and-ff",
                }))
              }
              data-testid="merge-advance-auto-sync-select"
            >
              <option value="stash-and-ff">Stash + fast-forward (default) — preserve local edits</option>
              <option value="ff-only">Fast-forward only — skip dirty worktrees</option>
              <option value="off">Off — leave the project root stale (legacy behavior)</option>
            </select>
            <details className="settings-option-details">
              <summary>More details</summary>
              <small>
                After Fusion advances the integration branch ref, the merger can auto-sync other
                worktrees still checked out on that branch (typically your project-root
                checkout). <code>Stash + fast-forward</code> snapshots real local edits as a patch
                against the previous tip, snaps the worktree to the new tip, then reapplies the
                patch — untracked files that collide with newly-tracked paths are left in a temp
                dir for manual recovery. <code>Fast-forward only</code> snaps cleanly when the
                worktree has no edits and skips otherwise. <code>Off</code> is the legacy
                behavior: <code>git status</code> in your project root will show the new commits
                inverted as &quot;staged changes&quot; until you pull manually. Only applies to direct
                merges.
              </small>
            </details>
          </div>
        </>
      )}
      <h4 className="settings-section-heading settings-section-heading--spaced">GitHub Authentication</h4>
      <div className="form-group">
        <label htmlFor="githubAuthMode">GitHub auth mode</label>
        <select
          id="githubAuthMode"
          className="select"
          value={form.githubAuthMode ?? "gh-cli"}
          onChange={(e) =>
            setForm((f) => ({ ...f, githubAuthMode: e.target.value as "gh-cli" | "token" }))
          }
        >
          <option value="gh-cli">GitHub CLI (gh auth)</option>
          <option value="token">Personal access token</option>
        </select>
      </div>
      {(form.githubAuthMode ?? "gh-cli") === "token" && (
        <div className="form-group">
          <label htmlFor="githubAuthToken">GitHub personal access token</label>
          <input
            id="githubAuthToken"
            type="password"
            className="input"
            value={form.githubAuthToken ?? ""}
            onChange={(e) =>
              setForm((f) => ({ ...f, githubAuthToken: e.target.value || undefined }))
            }
          />
        </div>
      )}
      <div className="form-group">
        <label htmlFor="includeTaskIdInCommit" className="checkbox-label">
          <input
            id="includeTaskIdInCommit"
            type="checkbox"
            checked={form.includeTaskIdInCommit !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, includeTaskIdInCommit: e.target.checked }))
            }
          />
          Include task ID in commit scope
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>When disabled, merge commit messages omit the task ID from the scope (e.g. <code>feat: ...</code> instead of <code>feat(KB-001): ...</code>)</small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="commitAuthorEnabled" className="checkbox-label">
          <input
            id="commitAuthorEnabled"
            type="checkbox"
            checked={form.commitAuthorEnabled !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, commitAuthorEnabled: e.target.checked }))
            }
          />
          Add Fusion as co-author on commits
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>
            When enabled, commits made by Fusion keep your git identity as the
            primary author and append a <code>Co-authored-by</code> trailer crediting
            Fusion (recognized by GitHub for shared attribution).
          </small>
        </details>
      </div>

      {form.commitAuthorEnabled !== false && (
        <>
          <div className="form-group">
            <label htmlFor="commitAuthorName">Co-author Name</label>
            <input
              id="commitAuthorName"
              type="text"
              value={form.commitAuthorName ?? ""}
              placeholder="Fusion"
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  commitAuthorName: e.target.value || undefined,
                }))
              }
            />
            <small>Name used in the <code>Co-authored-by</code> trailer</small>
          </div>
          <div className="form-group">
            <label htmlFor="commitAuthorEmail">Co-author Email</label>
            <input
              id="commitAuthorEmail"
              type="email"
              value={form.commitAuthorEmail ?? ""}
              placeholder="noreply@runfusion.ai"
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  commitAuthorEmail: e.target.value || undefined,
                }))
              }
            />
            <small>Email used in the <code>Co-authored-by</code> trailer</small>
          </div>
        </>
      )}

      <div className="form-group">
        <label htmlFor="autoResolveConflicts" className="checkbox-label">
          <input
            id="autoResolveConflicts"
            type="checkbox"
            checked={form.autoResolveConflicts !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, autoResolveConflicts: e.target.checked }))
            }
          />
          Auto-resolve conflicts in lock files and generated files
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.), generated files (dist/*, *.gen.ts), and trivial whitespace conflicts are resolved automatically without AI intervention. Complex code conflicts still require AI review.</small>
        </details>
      </div>
      {(form.merger?.mode ?? "ai") !== "ai" && (
      <>
      <div className="form-group">
        <label htmlFor="smartConflictResolution" className="checkbox-label">
          <input
            id="smartConflictResolution"
            type="checkbox"
            checked={form.smartConflictResolution !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, smartConflictResolution: e.target.checked }))
            }
          />
          Smart conflict resolution
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>When enabled, lock files (package-lock.json, pnpm-lock.yaml, etc.) are resolved using 'ours' strategy, generated files (dist/*, *.gen.ts) using 'theirs' strategy, and trivial whitespace conflicts are auto-resolved without spawning an AI agent. Complex code conflicts still require AI review.</small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="mergeConflictStrategy">Conflict Fallback Strategy</label>
        <select
          id="mergeConflictStrategy"
          value={form.mergeConflictStrategy ?? "smart-prefer-main"}
          onChange={(e) =>
            setForm((f) => ({ ...f, mergeConflictStrategy: e.target.value as "smart-prefer-main" | "smart-prefer-branch" | "ai-only" | "abort" }))
          }
        >
          <option value="smart-prefer-main">Smart, prefer main on fallback — fetch+ff origin → AI → auto-resolve → -X ours (default; protects just-merged sibling work)</option>
          <option value="smart-prefer-branch">Smart, prefer task on fallback — fetch+ff origin → AI → auto-resolve → -X theirs (legacy "smart" behavior; task branch wins)</option>
          <option value="ai-only">AI only — AI → auto-resolve → AI retry; never silently pick a side</option>
          <option value="abort">Abort — one AI attempt; require manual resolution if it fails</option>
        </select>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>
            Both <strong>Smart</strong> options start with a best-effort <code>git fetch</code> + fast-forward of local main from <code>origin</code> (so a freshly-pushed sibling commit doesn't get clobbered), then run an AI agent, then auto-resolve handles lock/generated/trivial files. They differ only in the <em>final fallback</em>:
            {" "}
            <strong>Smart, prefer main</strong> uses <code>-X ours</code> so main wins — protects just-merged sibling work and is the new default.
            {" "}
            <strong>Smart, prefer task</strong> uses <code>-X theirs</code> so the task branch wins — fast, but can resurrect code an earlier sibling task deleted (the FN-2887 class of regression).
            {" "}
            <strong>AI only</strong> retries the AI agent rather than auto-picking a side.
            {" "}
            <strong>Abort</strong> stops after the first AI attempt and waits for a human.
            {" "}
            <em>Legacy <code>"smart"</code> and <code>"prefer-main"</code> values from older settings are migrated automatically.</em>
          </small>
        </details>
      </div>
      <div className="form-group">
        <label htmlFor="mergeStrategyOverlapBehavior">Smart Prefer Main Overlap Guard</label>
        <select
          id="mergeStrategyOverlapBehavior"
          value={form.mergeStrategyOverlapBehavior ?? "flip-to-prefer-branch"}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              mergeStrategyOverlapBehavior: e.target.value as "flip-to-prefer-branch" | "warn-only" | "ignore",
            }))
          }
        >
          <option value="flip-to-prefer-branch">Flip overlapping files to prefer the task branch (default)</option>
          <option value="warn-only">Warn only — keep legacy main-wins fallback</option>
          <option value="ignore">Ignore overlap detection — preserve legacy behavior</option>
        </select>
        <small>
          When using smart-prefer-main, automatically prefer the branch side for files that main has recently modified to avoid silently discarding branch work.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="postMergeAuditMode">Post-merge audit mode</label>
        <select
          className="select"
          id="postMergeAuditMode"
          value={form.postMergeAuditMode ?? "warn"}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              postMergeAuditMode: e.target.value as "block" | "warn" | "off",
            }))
          }
        >
          <option value="block">Block (strict)</option>
          <option value="warn">Warn (default; log findings, continue)</option>
          <option value="off">Off (skip audit)</option>
        </select>
        <small>
          Controls the post-merge audit gate. <strong>Warn</strong> (default) logs findings but auto-completes the merge. <strong>Block</strong> is the stricter opt-in mode that refuses to auto-complete merges with duplicate-subject or touched-file overlap risks. <strong>Off</strong> skips the audit entirely. Switching to Off is recommended only if you trust your branches don&apos;t silently drop edits.
        </small>
      </div>
      </>
      )}
      <div className="form-group">
        <label htmlFor="pushAfterMerge" className="checkbox-label">
          <input
            id="pushAfterMerge"
            type="checkbox"
            checked={form.pushAfterMerge === true}
            onChange={(e) =>
              setForm((f) => ({ ...f, pushAfterMerge: e.target.checked }))
            }
          />
          Push to remote after merge
        </label>
        <details className="settings-option-details">
          <summary>More details</summary>
          <small>When enabled, the merged result is automatically pushed to the configured git remote. This includes pulling the latest from the remote first (rebase) and resolving any conflicts with AI if needed.</small>
        </details>
      </div>

      {form.pushAfterMerge && (
        <div className="form-group">
          <label htmlFor="pushRemote">Push Remote</label>
          <input
            id="pushRemote"
            type="text"
            placeholder="origin"
            value={form.pushRemote || ""}
            onChange={(e) =>
              setForm((f) => ({ ...f, pushRemote: e.target.value || undefined }))
            }
          />
          <details className="settings-option-details">
            <summary>More details</summary>
            <small>Git remote to push to (e.g. "origin"). Can include branch name (e.g. "origin main"). Default: "origin".</small>
          </details>
        </div>
      )}
    </>
  );
}

export default MergeSection;
