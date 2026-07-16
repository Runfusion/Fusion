import { createElement, useCallback, useEffect, useState, type ReactElement } from "react";

/*
FNXC:Quality 2026-07-14-21:45:
Quality hub dashboard view — project-wide run history and preset catalog.
Host registers this via registerBundledPluginViews (static registry).
*/

export interface QualityDashboardViewContext {
  projectId?: string;
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

async function fetchRuns(projectId: string): Promise<RunRow[]> {
  const res = await fetch(`/api/plugins/fusion-plugin-quality/runs?projectId=${encodeURIComponent(projectId)}`);
  if (!res.ok) return [];
  const data = (await res.json()) as { runs?: RunRow[] };
  return data.runs ?? [];
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
    const res = await fetch(`/api/plugins/fusion-plugin-quality/runs?projectId=${encodeURIComponent(projectId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, preset, source: "hub", confirmFullSuite }),
    });
    if (!res.ok) {
      const text = await res.text();
      setError(text || res.statusText);
      return;
    }
    await refresh();
  };

  return createElement(
    "div",
    { className: "quality-hub", "data-testid": "quality-hub", style: { padding: 16 } },
    createElement("h2", { style: { marginTop: 0 } }, "Quality"),
    createElement(
      "p",
      { style: { opacity: 0.8, maxWidth: 640 } },
      "Project-wide test runs. Advisory only — does not change merge eligibility. Prefer Task QA for worktree-scoped preview, screenshots, and suggested cases.",
    ),
    !projectId
      ? createElement("p", null, "Select a project to view Quality data.")
      : createElement(
          "div",
          null,
          createElement(
            "div",
            { style: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 } },
            createElement("button", { type: "button", className: "btn btn-sm", onClick: () => void startPreset("verify-fast") }, "Run verify:fast"),
            createElement("button", { type: "button", className: "btn btn-sm", onClick: () => void startPreset("test-gate") }, "Run test:gate"),
            createElement("button", { type: "button", className: "btn btn-sm", onClick: () => void startPreset("project-test") }, "Run project test"),
            createElement("button", { type: "button", className: "btn btn-sm", onClick: () => void refresh() }, "Refresh"),
          ),
          loading ? createElement("p", null, "Loading…") : null,
          error ? createElement("p", { role: "alert", style: { color: "var(--error, #c00)" } }, error) : null,
          createElement(
            "table",
            { style: { width: "100%", borderCollapse: "collapse", fontSize: 13 } },
            createElement(
              "thead",
              null,
              createElement(
                "tr",
                null,
                createElement("th", { style: { textAlign: "left", padding: 6 } }, "Status"),
                createElement("th", { style: { textAlign: "left", padding: 6 } }, "Preset"),
                createElement("th", { style: { textAlign: "left", padding: 6 } }, "Command"),
                createElement("th", { style: { textAlign: "left", padding: 6 } }, "Duration"),
                createElement("th", { style: { textAlign: "left", padding: 6 } }, "When"),
              ),
            ),
            createElement(
              "tbody",
              null,
              runs.length === 0
                ? createElement(
                    "tr",
                    null,
                    createElement("td", { colSpan: 5, style: { padding: 6, opacity: 0.7 } }, "No runs yet."),
                  )
                : runs.map((run) =>
                    createElement(
                      "tr",
                      { key: run.id },
                      createElement("td", { style: { padding: 6 } }, run.status),
                      createElement("td", { style: { padding: 6 } }, run.presetId ?? "—"),
                      createElement("td", { style: { padding: 6, fontFamily: "monospace" } }, run.command),
                      createElement(
                        "td",
                        { style: { padding: 6 } },
                        run.durationMs != null ? `${Math.round(run.durationMs / 1000)}s` : "—",
                      ),
                      createElement("td", { style: { padding: 6 } }, run.createdAt),
                    ),
                  ),
            ),
          ),
        ),
  );
}

export default QualityDashboardView;
