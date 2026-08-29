import "./dashboard-view.css";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Play, RefreshCw, ShieldCheck } from "lucide-react";
import { ViewHeader } from "@fusion/dashboard/app/components/ViewHeader";
import {
  artifactMediaUrlWithToken,
  type ArtifactWithTask,
} from "@fusion/dashboard/app/api/tasks/task-content";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";

/*
FNXC:Quality 2026-07-14-21:45:
Quality hub dashboard view — project-wide run history and preset catalog.
Host registers this via registerBundledPluginViews (static registry).

FNXC:Quality 2026-07-15-23:30:
Layout matches native main-content views: shared ViewHeader (ShieldCheck + title),
flex column root, tokenized body inset, card + table for run history, btn-sm header
actions. Removes ad-hoc padding/h2/inline table styles that made Quality look unlike
Insights / Compound Engineering / Goals.
*/

export type QualityDashboardViewContext = Pick<
  PluginDashboardViewContext,
  "projectId" | "tasks" | "openTaskDetail"
>;

type ReviewArtifactsMode = "off" | "user-facing" | "on";

/** Returns true only for executor-produced system verification videos. */
export function isVerificationVideo(artifact: ArtifactWithTask): boolean {
  return artifact.type === "video" && artifact.authorType === "system" && artifact.authorId === "executor";
}

interface RunRow {
  id: string;
  status: string;
  command: string;
  durationMs?: number;
  presetId?: string;
  createdAt: string;
  taskId?: string;
}

async function responseError(res: Response): Promise<Error> {
  const text = await res.text();
  let message = text || res.statusText;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) {
      message = parsed.error;
    }
  } catch {
    // keep text body
  }
  return new Error(message);
}

async function fetchRuns(projectId: string): Promise<RunRow[]> {
  /*
  FNXC:Quality 2026-07-15-23:17:
  Surface HTTP failures (including the experimental gate) instead of silently
  rendering an empty history that looks like "no runs yet".
  */
  const res = await fetch(`/api/plugins/fusion-plugin-quality/runs?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) throw await responseError(res);
  const data = (await res.json()) as { runs?: RunRow[] };
  return data.runs ?? [];
}

function reviewArtifactsMode(scopes: { global?: Record<string, unknown>; project?: Record<string, unknown> }): ReviewArtifactsMode {
  const value = scopes.project?.reviewArtifacts ?? scopes.global?.reviewArtifacts;
  return value === "user-facing" || value === "on" ? value : "off";
}

function formatWhen(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDuration(durationMs?: number): string {
  if (durationMs == null) return "—";
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${Math.round(durationMs / 1000)}s`;
}

function StatusPill({ status }: { status: string }): ReactElement {
  const normalized = status.toLowerCase().replace(/\s+/g, "_");
  return (
    <span className={`quality-status quality-status--${normalized}`} data-status={normalized}>
      {status}
    </span>
  );
}

export function QualityDashboardView({
  context,
}: {
  context?: QualityDashboardViewContext;
}): ReactElement {
  const projectId = context?.projectId;
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyPreset, setBusyPreset] = useState<string | null>(null);
  const [reviewArtifacts, setReviewArtifacts] = useState<ReviewArtifactsMode>("off");
  const [verificationVideos, setVerificationVideos] = useState<ArtifactWithTask[]>([]);
  const [verificationVideosProjectId, setVerificationVideosProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) {
      setReviewArtifacts("off");
      setVerificationVideos([]);
      setVerificationVideosProjectId(null);
      return;
    }

    // FNXC:Quality 2026-07-19-19:30: Do not render a prior project's verification
    // evidence while the newly selected project's settings and artifacts are loading.
    setReviewArtifacts("off");
    setVerificationVideos([]);
    setVerificationVideosProjectId(null);

    const controller = new AbortController();
    const loadVerificationVideos = async () => {
      try {
        const query = `projectId=${encodeURIComponent(projectId)}`;
        const [settingsResponse, artifactsResponse] = await Promise.all([
          fetch(`/api/settings/scopes?${query}`, { signal: controller.signal }),
          fetch(`/api/artifacts?type=video&${query}`, { signal: controller.signal }),
        ]);
        if (!settingsResponse.ok) throw await responseError(settingsResponse);
        if (!artifactsResponse.ok) throw await responseError(artifactsResponse);

        const scopes = (await settingsResponse.json()) as { global?: Record<string, unknown>; project?: Record<string, unknown> };
        const artifacts = (await artifactsResponse.json()) as ArtifactWithTask[];
        if (!controller.signal.aborted) {
          setReviewArtifacts(reviewArtifactsMode(scopes));
          setVerificationVideos(artifacts.filter(isVerificationVideo));
          setVerificationVideosProjectId(projectId);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };

    void loadVerificationVideos();
    return () => controller.abort();
  }, [projectId]);

  const verificationVideosEnabled = verificationVideosProjectId === projectId && reviewArtifacts !== "off";

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      setRuns(await fetchRuns(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startPreset = async (preset: string, confirmFullSuite = false) => {
    if (!projectId) return;
    setBusyPreset(preset);
    setError(null);
    try {
      const res = await fetch(`/api/plugins/fusion-plugin-quality/runs?projectId=${encodeURIComponent(projectId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, preset, source: "hub", confirmFullSuite }),
      });
      if (!res.ok) {
        /*
        FNXC:Quality 2026-07-15-23:17:
        Surface structured plugin route errors (e.g. experimental gate) without dumping raw JSON.
        */
        const text = await res.text();
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error.trim()) {
            setError(parsed.error);
            return;
          }
        } catch {
          // fall through
        }
        setError(text || res.statusText);
        return;
      }
      await refresh();
    } finally {
      setBusyPreset(null);
    }
  };

  const actions = projectId ? (
    <>
      <span className="quality-header-count" data-testid="quality-run-count">
        {runs.length} {runs.length === 1 ? "run" : "runs"}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void startPreset("verify-fast")}
        data-testid="quality-run-verify-fast"
      >
        <Play size={14} aria-hidden="true" />
        verify:fast
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void startPreset("test-gate")}
        data-testid="quality-run-test-gate"
      >
        <Play size={14} aria-hidden="true" />
        test:gate
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void startPreset("project-test")}
        data-testid="quality-run-project-test"
      >
        <Play size={14} aria-hidden="true" />
        project test
      </button>
      <button
        type="button"
        className="btn btn-icon btn-sm"
        disabled={loading || busyPreset != null}
        onClick={() => void refresh()}
        aria-label="Refresh Quality runs"
        title="Refresh"
        data-testid="quality-refresh"
      >
        <RefreshCw size={14} className={loading ? "spin" : undefined} aria-hidden="true" />
      </button>
    </>
  ) : null;

  return (
    <div className="quality-view" data-testid="quality-hub">
      <ViewHeader icon={ShieldCheck} title="Quality" actions={actions} titleId="quality-view-title" />
      <div className="quality-view-body">
        <p className="quality-view-lede">
          Project-wide test runs. Advisory only — does not change merge eligibility. Prefer Task QA for
          worktree-scoped preview, screenshots, and suggested cases.
        </p>

        {!projectId ? (
          <p className="quality-view-empty-project">Select a project to view Quality data.</p>
        ) : (
          <>
            {error ? (
              <p className="quality-view-error" role="alert">
                {error}
              </p>
            ) : null}

            <section className="quality-runs-card card" data-testid="quality-runs-card">
              <header className="quality-runs-card__header">
                <h3>Run history</h3>
                <span className="quality-runs-card__count">
                  {loading && runs.length === 0 ? "Loading…" : `${runs.length} total`}
                </span>
              </header>
              <div className="quality-runs-table-wrap">
                <table className="quality-runs-table">
                  <thead>
                    <tr>
                      <th scope="col">Status</th>
                      <th scope="col">Preset</th>
                      <th scope="col">Command</th>
                      <th scope="col">Duration</th>
                      <th scope="col">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="quality-runs-table__empty">
                          {loading ? "Loading runs…" : "No runs yet. Start a preset from the header."}
                        </td>
                      </tr>
                    ) : (
                      runs.map((run) => (
                        <tr key={run.id} data-testid="quality-run-row">
                          <td>
                            <StatusPill status={run.status} />
                          </td>
                          <td>{run.presetId ?? "—"}</td>
                          <td className="quality-runs-table__command">{run.command}</td>
                          <td>{formatDuration(run.durationMs)}</td>
                          <td>{formatWhen(run.createdAt)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/*
            FNXC:Quality 2026-07-19-12:00:
            Quality surfaces task feature-video verification evidence only while reviewArtifacts is enabled.
            Executor/system provenance prevents operator uploads from appearing as verification evidence; native video
            loads use the tokenized media URL, and source tasks open through the host context rather than a URL route.
            */}
            {verificationVideosEnabled ? (
              <section className="quality-verification-videos-card card" data-testid="quality-verification-videos">
                <header className="quality-verification-videos-card__header">
                  <h3>Verification videos</h3>
                  <span className="quality-verification-videos-card__count">{verificationVideos.length} total</span>
                </header>
                {verificationVideos.length === 0 ? (
                  <p className="quality-verification-videos-card__empty" data-testid="quality-verification-videos-empty">
                    No verification videos captured yet.
                  </p>
                ) : (
                  <div className="quality-verification-videos-list">
                    {verificationVideos.map((artifact) => {
                      const task = context?.tasks.find((candidate) => candidate.id === artifact.taskId);
                      return (
                        <article className="quality-verification-video-row" key={artifact.id} data-testid="quality-verification-video-row">
                          <video
                            className="quality-verification-video-row__media"
                            controls
                            preload="metadata"
                            src={artifactMediaUrlWithToken(artifact.id, projectId)}
                          />
                          <div className="quality-verification-video-row__details">
                            <h4>{artifact.title}</h4>
                            {task ? (
                              <button
                                type="button"
                                className="btn btn-sm"
                                onClick={() => context?.openTaskDetail(task)}
                                data-testid="quality-verification-video-open-task"
                              >
                                Open task
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            ) : (
              <p className="quality-verification-videos-disabled" data-testid="quality-verification-videos-disabled">
                Verification videos appear here when Review Artifacts is enabled.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default QualityDashboardView;
