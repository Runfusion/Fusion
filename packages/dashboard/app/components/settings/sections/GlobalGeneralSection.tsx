/**
 * Global General section (U9 / KTD-10).
 *
 * The global default tracking repo, CLI binary panel, agent-log persistence
 * toggles (tool output + thinking logs), the `fn` binary probe toggle, and the
 * update-check controls. The tracking-repo option list/loading/error live in
 * the shell (fetched on demand) and are relayed as props. The thinking-log
 * resolution helper is imported directly from core.
 */
import type { ReactNode } from "react";
import { resolvePersistAgentThinkingLog } from "@fusion/core";
import { TrackingRepoSelect, type TrackingRepoOption } from "../../TrackingRepoSelect";
import { CliBinaryPanel } from "../../CliBinaryPanel";
import type { SectionBaseProps } from "./context";

export interface GlobalGeneralSectionProps extends SectionBaseProps {
  scopeBanner: ReactNode;
  globalTrackingRepoOptions: TrackingRepoOption[];
  globalTrackingRepoLoading: boolean;
  globalTrackingRepoError: string | null;
}

export function GlobalGeneralSection({
  scopeBanner,
  form,
  setForm,
  globalTrackingRepoOptions,
  globalTrackingRepoLoading,
  globalTrackingRepoError,
}: GlobalGeneralSectionProps) {
  return (
    <>
      {scopeBanner}
      <h4 className="settings-section-heading">General</h4>
      <div className="form-group">
        <label htmlFor="globalGithubTrackingDefaultRepo">Global default tracking repo</label>
        <TrackingRepoSelect
          id="globalGithubTrackingDefaultRepo"
          ariaLabel="Global default tracking repo"
          value={form.githubTrackingDefaultRepo ?? ""}
          options={globalTrackingRepoOptions}
          loading={globalTrackingRepoLoading}
          error={globalTrackingRepoError ?? undefined}
          placeholder="owner/repo"
          onChange={(nextValue) =>
            setForm((f) => ({ ...f, githubTrackingDefaultRepo: nextValue || undefined }))
          }
        />
        <small>Projects inherit this value when they do not set a project default tracking repo.</small>
      </div>
      <CliBinaryPanel />
      <div className="form-group">
        <label htmlFor="persistAgentToolOutput" className="checkbox-label">
          <input
            id="persistAgentToolOutput"
            type="checkbox"
            checked={form.persistAgentToolOutput !== false}
            onChange={(e) => setForm((f) => ({ ...f, persistAgentToolOutput: e.target.checked }))}
          />
          Save tool output in agent logs
        </label>
        <small>
          When disabled, tool rows are still logged but detailed tool payloads are omitted.
          Very large tool payloads may still be clipped even when this stays enabled.
        </small>
      </div>
      <div className="form-group">
        <h5 className="settings-section-heading">Save AI thinking logs</h5>
        <label htmlFor="persistAgentThinkingLogPermanent" className="checkbox-label">
          <input
            id="persistAgentThinkingLogPermanent"
            type="checkbox"
            checked={resolvePersistAgentThinkingLog(form, { ephemeral: false })}
            onChange={(e) =>
              setForm((f) => ({ ...f, persistAgentThinkingLogPermanent: e.target.checked }))
            }
          />
          Save AI thinking for permanent agents
        </label>
        <label htmlFor="persistAgentThinkingLogEphemeral" className="checkbox-label">
          <input
            id="persistAgentThinkingLogEphemeral"
            type="checkbox"
            checked={resolvePersistAgentThinkingLog(form, { ephemeral: true })}
            onChange={(e) =>
              setForm((f) => ({ ...f, persistAgentThinkingLogEphemeral: e.target.checked }))
            }
          />
          Save AI thinking for ephemeral / task-worker agents
        </label>
        <small>
          Leave both thinking toggles off to keep the original default behavior.
          This only controls persisted <code>thinking</code> rows and does not affect assistant text or tool rows.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="fnBinaryCheckEnabled" className="checkbox-label">
          <input
            id="fnBinaryCheckEnabled"
            type="checkbox"
            checked={form.fnBinaryCheckEnabled !== false}
            onChange={(e) => setForm((f) => ({ ...f, fnBinaryCheckEnabled: e.target.checked }))}
          />
          Check for the <code>fn</code> CLI binary on PATH
        </label>
        <small>
          When enabled, the dashboard probes for a globally-installed{" "}
          <code>fn</code> / <code>fusion</code> CLI by spawning{" "}
          <code>&lt;bin&gt; --version</code>. Disable this if your local
          dev process is the source of truth and you don&apos;t want any
          outdated globally-installed binary executed during the probe.
        </small>
      </div>
      <h4 className="settings-section-heading settings-section-heading--spaced">Updates</h4>
      <div className="form-group">
        <label htmlFor="updateCheckEnabled" className="checkbox-label">
          <input
            id="updateCheckEnabled"
            type="checkbox"
            checked={form.updateCheckEnabled !== false}
            onChange={(e) => setForm((f) => ({ ...f, updateCheckEnabled: e.target.checked }))}
          />
          Check for updates automatically
        </label>
        <small>
          When enabled, Fusion checks npm for new versions of{" "}
          <code>@runfusion/fusion</code> and shows update notices in the CLI and dashboard.
          Cadence is governed by the frequency below.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="updateCheckFrequency">Frequency</label>
        <select
          id="updateCheckFrequency"
          value={form.updateCheckFrequency ?? "daily"}
          onChange={(e) =>
            setForm((f) => ({
              ...f,
              updateCheckFrequency: e.target.value as "manual" | "on-startup" | "daily" | "weekly",
            }))
          }
          disabled={form.updateCheckEnabled === false}
        >
          <option value="manual">Manual only — never auto-check</option>
          <option value="on-startup">On startup — once per server launch</option>
          <option value="daily">Daily (recommended)</option>
          <option value="weekly">Weekly</option>
        </select>
        <small>
          Controls how often the dashboard re-fetches the npm registry.
          Use the version + refresh control in the header to trigger an
          immediate check at any time.
        </small>
      </div>
      <div className="form-group">
        <label htmlFor="autoReloadOnVersionChange" className="checkbox-label">
          <input
            id="autoReloadOnVersionChange"
            type="checkbox"
            checked={form.autoReloadOnVersionChange !== false}
            onChange={(e) => setForm((f) => ({ ...f, autoReloadOnVersionChange: e.target.checked }))}
          />
          Auto-reload dashboard on version change
        </label>
        <small>
          When enabled (default), the dashboard automatically reloads when it
          detects a new build version — either from server rebuilds or service
          worker updates. Disable this to stay on the current version until you
          manually refresh.
        </small>
      </div>
    </>
  );
}

export default GlobalGeneralSection;
