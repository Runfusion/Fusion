import { createElement, useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";

/*
FNXC:Quality 2026-07-14-21:45:
Task QA tab — action-first: Preview server | Run tests | Reports | Screenshots | Suggested cases | CI.
Host injects task context via PluginSlot props (taskId, worktree, projectId).
*/

export interface QualityTaskContext {
  taskId?: string;
  worktree?: string;
  projectId?: string;
  title?: string;
  modifiedFiles?: string[];
}

export interface QualityQaTabProps {
  entry?: unknown;
  actions?: unknown;
  /** Host-injected task context (U1 contract) */
  context?: QualityTaskContext;
  taskId?: string;
  worktree?: string;
  projectId?: string;
}

interface RunRow {
  id: string;
  status: string;
  command: string;
  durationMs?: number;
  presetId?: string;
  createdAt: string;
  stdout?: string;
  stderr?: string;
  errorMessage?: string;
}

interface PreviewSession {
  status: string;
  url?: string;
  port?: number;
  command?: string;
  cwd?: string;
  cwdKind?: "worktree" | "qa-worktree";
  ref?: string;
  errorMessage?: string;
}

interface SuggestedCase {
  id: string;
  text: string;
  done: boolean;
}

function Section({ title, children, testId }: { title: string; children?: ReactNode; testId: string }): ReactElement {
  return createElement(
    "section",
    {
      "data-testid": testId,
      style: {
        marginBottom: 20,
        padding: 12,
        border: "1px solid var(--border, #3333)",
        borderRadius: 8,
      },
    },
    createElement("h3", { style: { marginTop: 0, marginBottom: 8, fontSize: 14 } }, title),
    children,
  );
}

export function QualityTaskQaTab(props: QualityQaTabProps): ReactElement {
  const ctx = props.context ?? {};
  const taskId = props.taskId ?? ctx.taskId;
  const projectId = props.projectId ?? ctx.projectId;
  const worktree = props.worktree ?? ctx.worktree;

  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedRun, setSelectedRun] = useState<RunRow | null>(null);
  const [preview, setPreview] = useState<PreviewSession | null>(null);
  const [cases, setCases] = useState<SuggestedCase[]>([]);
  const [loadErrors, setLoadErrors] = useState<Partial<Record<"runs" | "preview" | "suggestions", string>>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const api = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!projectId) throw new Error("projectId required");
      const sep = path.includes("?") ? "&" : "?";
      const url = `/api/plugins/fusion-plugin-quality${path}${sep}projectId=${encodeURIComponent(projectId)}`;
      const res = await fetch(url, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        /*
        FNXC:Quality 2026-07-15-23:17:
        Prefer the structured { error } body from gated plugin routes over raw JSON text.
        */
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
        throw new Error(message);
      }
      return res.json();
    },
    [projectId],
  );

  const refresh = useCallback(async () => {
    if (!projectId || !taskId) return;
    /*
    FNXC:Quality 2026-07-15-13:05:
    Task QA panels are independent backend surfaces. A transient preview error
    must not hide completed runs or suggested cases that loaded successfully.
    */
    const [runsResult, previewResult, suggestionsResult] = await Promise.allSettled([
      api(`/runs?taskId=${encodeURIComponent(taskId)}`),
      api(`/preview/${encodeURIComponent(taskId)}`),
      api(`/suggestions/${encodeURIComponent(taskId)}`),
    ]);
    const nextErrors: Partial<Record<"runs" | "preview" | "suggestions", string>> = {};
    if (runsResult.status === "fulfilled") setRuns((runsResult.value as { runs?: RunRow[] }).runs ?? []);
    else nextErrors.runs = runsResult.reason instanceof Error ? runsResult.reason.message : String(runsResult.reason);
    if (previewResult.status === "fulfilled") setPreview((previewResult.value as { session?: PreviewSession | null }).session ?? null);
    else nextErrors.preview = previewResult.reason instanceof Error ? previewResult.reason.message : String(previewResult.reason);
    if (suggestionsResult.status === "fulfilled") setCases((suggestionsResult.value as { suggestions?: { cases?: SuggestedCase[] } | null }).suggestions?.cases ?? []);
    else nextErrors.suggestions = suggestionsResult.reason instanceof Error ? suggestionsResult.reason.message : String(suggestionsResult.reason);
    setLoadErrors(nextErrors);
  }, [api, projectId, taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startRun = async (preset: string, confirmFullSuite = false) => {
    if (!projectId || !taskId) return;
    setBusy(true);
    setError(null);
    try {
      await api("/runs", {
        method: "POST",
        body: JSON.stringify({
          projectId,
          taskId,
          preset,
          source: "task-tab",
          confirmFullSuite,
        }),
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const startPreview = async () => {
    if (!taskId) return;
    setBusy(true);
    setError(null);
    try {
      const data = (await api(`/preview/${encodeURIComponent(taskId)}/start`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      })) as { session?: PreviewSession };
      setPreview(data.session ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const stopPreview = async () => {
    if (!taskId) return;
    setBusy(true);
    try {
      const data = (await api(`/preview/${encodeURIComponent(taskId)}/stop`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      })) as { session?: PreviewSession };
      setPreview(data.session ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const generateCases = async () => {
    if (!taskId) return;
    setBusy(true);
    try {
      const data = (await api(`/suggestions/${encodeURIComponent(taskId)}/generate`, {
        method: "POST",
        body: JSON.stringify({ projectId }),
      })) as { suggestions?: { cases?: SuggestedCase[] } };
      setCases(data.suggestions?.cases ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!projectId || !taskId) {
    return createElement(
      "div",
      { "data-testid": "quality-qa-tab-missing-context", style: { padding: 12 } },
      createElement("p", null, "Task context is required for the QA tab."),
    );
  }

  return createElement(
    "div",
    { className: "quality-qa-tab", "data-testid": "quality-qa-tab", style: { padding: 4 } },
    error
      ? createElement("p", { role: "alert", style: { color: "var(--error, #c00)", marginBottom: 12 } }, error)
      : null,

    // Preview server
    /*
    FNXC:Quality 2026-07-15-23:23:
    Always offer Start. Done tasks often have no live worktree after cleanup; the
    API creates a disposable QA worktree at the task branch/merge commit so the
    preview runs the done task's code.
    */
    createElement(
      Section,
      { title: "Preview server", testId: "quality-qa-preview" },
      createElement(
        "div",
        null,
        createElement(
          "p",
          { style: { margin: "0 0 8px", fontSize: 13, opacity: 0.85 } },
          preview
            ? `Status: ${preview.status}${preview.url ? ` · ${preview.url}` : ""}${preview.port ? ` · port ${preview.port}` : ""}${
                preview.cwdKind === "qa-worktree"
                  ? ` · QA worktree${preview.ref ? ` @ ${preview.ref.slice(0, 12)}` : ""}`
                  : preview.cwdKind === "worktree"
                    ? " · worktree"
                    : ""
              }`
            : worktree
              ? "No preview server running for this task."
              : "No live worktree — Start will check out this task's branch/merge commit into a temporary QA worktree.",
        ),
        createElement(
          "div",
          { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
          createElement(
            "button",
            { type: "button", className: "btn btn-sm", disabled: busy, onClick: () => void startPreview() },
            "Start",
          ),
          createElement(
            "button",
            { type: "button", className: "btn btn-sm", disabled: busy || !preview, onClick: () => void stopPreview() },
            "Stop",
          ),
          preview?.url
            ? createElement(
                "a",
                { className: "btn btn-sm", href: preview.url, target: "_blank", rel: "noreferrer" },
                "Open URL",
              )
            : null,
        ),
        preview?.errorMessage
          ? createElement("p", { style: { color: "var(--error, #c00)", fontSize: 12 } }, preview.errorMessage)
          : null,
      ),
      loadErrors.preview
        ? createElement("p", { role: "alert", style: { color: "var(--error, #c00)", margin: "8px 0 0" } }, loadErrors.preview)
        : null,
    ),

    // Run tests
    createElement(
      Section,
      { title: "Run tests", testId: "quality-qa-run-tests" },
      createElement(
        "p",
        { style: { margin: "0 0 8px", fontSize: 12, opacity: 0.75 } },
        "Advisory local runs — do not change merge eligibility.",
      ),
      createElement(
        "div",
        { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
        /*
        FNXC:Quality 2026-07-16-10:55:
        Run controls stay enabled without a live worktree. The server creates a
        temporary QA checkout for done/cleaned-up tasks (same as preview Start).
        */
        createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            disabled: busy,
            onClick: () => void startRun("file-scoped"),
          },
          "File-scoped",
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            disabled: busy,
            onClick: () => void startRun("verify-fast"),
          },
          "verify:fast",
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            disabled: busy,
            onClick: () => void startRun("test-gate"),
          },
          "test:gate",
        ),
        createElement(
          "button",
          {
            type: "button",
            className: "btn btn-sm",
            disabled: busy,
            onClick: () => void startRun("project-test"),
          },
          "Project test",
        ),
      ),
      !worktree
        ? createElement(
            "p",
            { style: { marginTop: 8, fontSize: 12, opacity: 0.8 } },
            "No live worktree — runs use a temporary QA checkout of this task's branch/merge commit.",
          )
        : null,
    ),

    // Reports
    createElement(
      Section,
      { title: "Reports", testId: "quality-qa-reports" },
      runs.length === 0
        ? createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13 } }, "No task runs yet.")
        : createElement(
            "ul",
            { style: { listStyle: "none", padding: 0, margin: 0 } },
            ...runs.slice(0, 10).map((run) =>
              createElement(
                "li",
                {
                  key: run.id,
                  style: {
                    padding: "6px 0",
                    borderBottom: "1px solid var(--border, #3333)",
                    cursor: "pointer",
                    fontSize: 13,
                  },
                  onClick: () => setSelectedRun(run),
                },
                createElement("strong", null, run.status),
                ` · ${run.presetId ?? "run"} · ${run.durationMs != null ? `${Math.round(run.durationMs / 1000)}s` : "…"}`,
                createElement("div", { style: { fontFamily: "monospace", fontSize: 11, opacity: 0.8 } }, run.command),
              ),
            ),
          ),
      loadErrors.runs
        ? createElement("p", { role: "alert", style: { color: "var(--error, #c00)", margin: "8px 0 0" } }, loadErrors.runs)
        : null,
      selectedRun
        ? createElement(
            "div",
            {
              "data-testid": "quality-qa-report-detail",
              style: { marginTop: 10, padding: 8, background: "var(--surface-subtle, #0001)", borderRadius: 6, fontSize: 12 },
            },
            createElement("div", null, createElement("strong", null, "Report: "), selectedRun.id),
            createElement("div", null, `Status: ${selectedRun.status}`),
            selectedRun.errorMessage ? createElement("div", null, selectedRun.errorMessage) : null,
            createElement(
              "pre",
              { style: { maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap" } },
              (selectedRun.stdout || selectedRun.stderr || "(no log)") as string,
            ),
          )
        : null,
    ),

    // Screenshots
    createElement(
      Section,
      { title: "Screenshots", testId: "quality-qa-screenshots" },
      createElement(
        "p",
        { style: { margin: 0, fontSize: 13, opacity: 0.8 } },
        "Task image artifacts and design-preview docs appear here when registered. Open the Artifacts view for the full gallery, or enable browser verification to capture evidence.",
      ),
    ),

    // Suggested cases
    createElement(
      Section,
      { title: "Suggested test cases", testId: "quality-qa-suggestions" },
      createElement(
        "div",
        { style: { display: "flex", gap: 8, marginBottom: 8 } },
        createElement(
          "button",
          { type: "button", className: "btn btn-sm", disabled: busy, onClick: () => void generateCases() },
          cases.length ? "Regenerate" : "Generate",
        ),
      ),
      cases.length === 0
        ? createElement("p", { style: { margin: 0, opacity: 0.7, fontSize: 13 } }, "No suggestions yet. Generate from the task prompt and file scope.")
        : createElement(
            "ul",
            { style: { margin: 0, paddingLeft: 18, fontSize: 13 } },
            ...cases.map((c) => createElement("li", { key: c.id }, c.text)),
          ),
      loadErrors.suggestions
        ? createElement("p", { role: "alert", style: { color: "var(--error, #c00)", margin: "8px 0 0" } }, loadErrors.suggestions)
        : null,
    ),

    // CI placeholder
    createElement(
      Section,
      { title: "CI checks", testId: "quality-qa-ci" },
      createElement(
        "p",
        { style: { margin: 0, fontSize: 13, opacity: 0.8 } },
        "PR check status uses the host ",
        createElement("code", null, "GET /api/tasks/:id/pr/checks"),
        " surface when this task has a linked PR (see Task Review tab).",
      ),
    ),
  );
}

/** Slot registry entry component — receives host props */
export function QualityQaTabSlot(props: QualityQaTabProps): ReactElement {
  return createElement(QualityTaskQaTab, props);
}

export default QualityQaTabSlot;
