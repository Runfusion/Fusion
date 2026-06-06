/**
 * Worktrees section (U9 / KTD-10).
 *
 * Project-scoped worktree limits/naming/dir, pre-merge rebase options, and the
 * Worktrunk integration block (install affordance + binary path + failure mode).
 * The worktrunk install status hook result is owned by the shell (its
 * `installed` flag also gates the save flow) and relayed as props alongside the
 * fetched git-remotes list, the worktrees-dir picker, and the approvals opener.
 * Keys, conditional disabling, and the install-state affordance markup are
 * preserved verbatim from the original inline JSX.
 */
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

export function WorktreesSection({
  scopeBanner,
  form,
  setForm,
  gitRemotes,
  worktrunkInstall,
  worktrunkInstallVerified,
  onOpenWorktreesDirPicker,
  onOpenApprovals,
}: WorktreesSectionProps) {
  const { t } = useTranslation("app");
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">Worktrees</h4>
      <div className="form-group">
        <label htmlFor="maxWorktrees">Max Worktrees</label>
        <input
          id="maxWorktrees"
          type="number"
          min={1}
          max={20}
          value={form.maxWorktrees ?? ""}
          onChange={(e) => {
            const val = e.target.value;
            setForm((f) => ({ ...f, maxWorktrees: val === "" ? undefined : Number(val) } as SettingsFormState));
          }}
        />
        <small>Limits total git worktrees including in-review tasks</small>
      </div>
      <div className="form-group">
        <label htmlFor="worktreeInitCommand">Worktree Init Command</label>
        <input
          id="worktreeInitCommand"
          type="text"
          placeholder="pnpm install --frozen-lockfile"
          value={form.worktreeInitCommand || ""}
          onChange={(e) =>
            setForm((f) => ({ ...f, worktreeInitCommand: e.target.value }))
          }
        />
        <small>Shell command to run in each new worktree after creation</small>
      </div>
      <div className="form-group">
        <label htmlFor="recycleWorktrees" className="checkbox-label">
          <input
            id="recycleWorktrees"
            type="checkbox"
            checked={form.recycleWorktrees}
            onChange={(e) =>
              setForm((f) => ({ ...f, recycleWorktrees: e.target.checked }))
            }
          />
          Recycle worktrees
        </label>
        <small>Off by default (opt-in). When enabled, completed task worktrees are returned to an idle pool instead of being deleted, preserving build caches for faster startup</small>
      </div>
      <div className="form-group">
        <label htmlFor="executorAllowSiblingBranchRename" className="checkbox-label">
          <input
            id="executorAllowSiblingBranchRename"
            type="checkbox"
            checked={form.executorAllowSiblingBranchRename === true}
            onChange={(e) =>
              setForm((f) => ({ ...f, executorAllowSiblingBranchRename: e.target.checked }))
            }
          />
          Allow silent sibling branch rename during executor conflicts
        </label>
        <small>
          Discouraged. This restores the legacy behavior where a live <code>fusion/&lt;task-id&gt;</code> branch collision silently forks work onto sibling branches like <code>-2</code> and can hide prior commits from the default recovery flow.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="worktreeNaming">Worktree Naming Style</label>
        <select
          id="worktreeNaming"
          value={form.worktreeNaming || "random"}
          onChange={(e) =>
            setForm((f) => ({ ...f, worktreeNaming: e.target.value as "random" | "task-id" | "task-title" }))
          }
          disabled={form.recycleWorktrees}
        >
          <option value="random">Random names (e.g., swift-falcon)</option>
          <option value="task-id">Task ID (e.g., FN-042)</option>
          <option value="task-title">Task title (e.g., fix-login-bug)</option>
        </select>
        <small>
          {form.recycleWorktrees
            ? "Naming style is not applicable when recycling worktrees — pooled worktrees retain their existing names"
            : "How to name fresh worktree directories. Only applies when recycling is off."}
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="worktreesDir">Worktrees Directory</label>
        <div className="settings-overlap-ignore-path-controls">
          <input
            id="worktreesDir"
            type="text"
            placeholder="Defaults to .worktrees — leave empty unless overriding"
            value={form.worktreesDir || ""}
            disabled={form.worktrunk?.enabled === true}
            onChange={(e) =>
              setForm((f) => ({ ...f, worktreesDir: e.target.value }))
            }
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={onOpenWorktreesDirPicker}
            aria-label="Browse worktrees directory"
            disabled={form.worktrunk?.enabled === true}
          >
            Browse
          </button>
        </div>
        <small>
          {form.worktrunk?.enabled === true
            ? "Disabled because Worktrunk integration is enabled — worktrunk manages the worktree directory layout. Disable worktrunk integration to use a custom directory."
            : <>
                Optional. Supports <code>~</code> and <code>{"{repo}"}</code>. Defaults to <code>&lt;projectRoot&gt;/.worktrees</code> when unset. Only affects newly-created worktrees.
              </>}
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="worktreeRebaseBeforeMerge" className="checkbox-label">
          <input
            id="worktreeRebaseBeforeMerge"
            type="checkbox"
            checked={form.worktreeRebaseBeforeMerge !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, worktreeRebaseBeforeMerge: e.target.checked }))
            }
          />
          Rebase from remote before merge
        </label>
        <small>When enabled, the merger fetches from the configured remote and rebases the task branch onto the latest default-branch tip before merging — catching concurrent pushes from other collaborators or fusion workers. Any conflicts the rebase surfaces flow into the existing smart/AI resolve pipeline.</small>
      </div>
      {form.worktreeRebaseBeforeMerge !== false && (
        <div className="form-group">
          <label htmlFor="worktreeRebaseRemote">Rebase Remote</label>
          <select
            id="worktreeRebaseRemote"
            value={form.worktreeRebaseRemote ?? ""}
            onChange={(e) =>
              setForm((f) => ({ ...f, worktreeRebaseRemote: e.target.value || undefined }))
            }
          >
            <option value="">Use git default</option>
            {gitRemotes.map((remote) => (
              <option key={remote.name} value={remote.name}>
                {remote.name} ({remote.fetchUrl})
              </option>
            ))}
          </select>
          <small>
            Which remote to fetch for the pre-merge rebase. "Use git default" falls back to the remote configured for the default branch (typically <code>origin</code>).
          </small>
        </div>
      )}
      <div className="form-group">
        <label htmlFor="worktreeRebaseLocalBase" className="checkbox-label">
          <input
            id="worktreeRebaseLocalBase"
            type="checkbox"
            checked={form.worktreeRebaseLocalBase !== false}
            onChange={(e) =>
              setForm((f) => ({ ...f, worktreeRebaseLocalBase: e.target.checked }))
            }
          />
          Also rebase onto local default-branch HEAD
        </label>
        <small>
          In addition to the remote rebase above, also rebase the task branch onto the local default-branch HEAD (rootDir). This catches sibling tasks that merged locally but haven't been pushed yet — without it, two concurrent tasks where one deletes code can have the other silently re-introduce it via the fallback strategy. Enabled by default; only disable if it causes issues with your workflow.
        </small>
      </div>

      <h4 className="settings-section-heading settings-section-heading--spaced">Worktrunk integration</h4>
      <div className="form-group">
        <label htmlFor="worktrunkEnabled" className="checkbox-label">
          <input
            id="worktrunkEnabled"
            type="checkbox"
            checked={form.worktrunk?.enabled === true}
            disabled={!worktrunkInstallVerified && form.worktrunk?.enabled !== true}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                worktrunk: {
                  enabled: e.target.checked,
                  binaryPath: f.worktrunk?.binaryPath ?? "",
                  onFailure: f.worktrunk?.onFailure ?? "fail",
                },
              }))
            }
          />
          Enable worktrunk integration
        </label>
        <small>
          Disabled by default (opt-in). When enabled, Fusion shells out to <code>worktrunk</code> for worktree create, sync, prune, and remove operations and follows worktrunk&apos;s directory layout.
        </small>
        {!worktrunkInstallVerified && form.worktrunk?.enabled !== true && (
          <small className="settings-muted">Install the worktrunk binary below to enable this integration.</small>
        )}
      </div>
      <div className="form-group" data-testid="worktrunk-install-affordance">
        {worktrunkInstall.status === "installed" && (
          <small className="settings-muted">
            worktrunk {worktrunkInstall.version ?? ""} installed at {worktrunkInstall.installPath ?? "~/.fusion/bin/worktrunk"}
          </small>
        )}
        {(worktrunkInstall.status === "missing" || worktrunkInstall.status === "installing") && (
          <>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void worktrunkInstall.requestInstall()}
              disabled={worktrunkInstall.requesting || worktrunkInstall.status === "installing"}
            >
              {t("settings.worktrees.installWorktrunk", "Install worktrunk binary")}
            </button>
            <small className="settings-muted">Enable worktrunk and request approval to install the pinned release.</small>
          </>
        )}
        {worktrunkInstall.status === "pending-approval" && (
          <>
            <small className="settings-muted">{t("settings.worktrees.awaitingApproval", "Awaiting approval — open Approvals to continue.")}</small>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => onOpenApprovals?.(worktrunkInstall.pendingApprovalId)}
            >
              {t("settings.worktrees.openApprovals", "Open Approvals")}
            </button>
          </>
        )}
        {(worktrunkInstall.status === "denied" || worktrunkInstall.status === "failed") && (
          <>
            <small style={{ color: "var(--color-error)" }}>{worktrunkInstall.error ?? "Worktrunk install failed."}</small>
            <button type="button" className="btn btn-secondary" onClick={() => void worktrunkInstall.requestInstall()}>
              {t("settings.worktrees.tryAgain", "Try again")}
            </button>
          </>
        )}
      </div>
      <div className="form-group">
        <label htmlFor="worktrunkBinaryPath">Worktrunk binary path</label>
        <input
          id="worktrunkBinaryPath"
          type="text"
          className="input"
          placeholder="auto-detect (~/.fusion/bin/worktrunk or $PATH)"
          value={form.worktrunk?.binaryPath ?? ""}
          disabled={form.worktrunk?.enabled !== true}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              worktrunk: {
                enabled: f.worktrunk?.enabled === true,
                binaryPath: e.target.value,
                onFailure: f.worktrunk?.onFailure ?? "fail",
              },
            }))
          }
        />
        <small>Optional. Leave blank to auto-resolve; Fusion will offer to install on first use.</small>
      </div>
      <div className="form-group">
        <label htmlFor="worktrunkOnFailure">Worktrunk failure behavior</label>
        <select
          id="worktrunkOnFailure"
          className="select"
          value={form.worktrunk?.onFailure ?? "fail"}
          disabled={form.worktrunk?.enabled !== true}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              worktrunk: {
                enabled: f.worktrunk?.enabled === true,
                binaryPath: f.worktrunk?.binaryPath ?? "",
                onFailure: e.target.value as "fail" | "fallback-native",
              },
            }))
          }
        >
          <option value="fail">Fail and pause the task (default)</option>
          <option value="fallback-native">Fall back to Fusion's native worktree backend</option>
        </select>
        <small>
          <code>fail</code> stops on worktrunk errors for explicit operator recovery; <code>fallback-native</code> keeps progress moving by switching to Fusion&apos;s built-in worktree backend.
        </small>
      </div>
    </>
  );
}

export default WorktreesSection;
