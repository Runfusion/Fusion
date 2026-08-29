import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { PluginDashboardViewContext } from "@fusion/dashboard/app/plugins/types";
import type { LinearIssue } from "./linear-client.js";
import "./LinearImportView.css";

type StatusState = "loading" | "authenticated" | "missing" | "error";

interface RouteResponse<T> {
  ok?: boolean;
  error?: string;
  code?: string;
  authenticated?: boolean;
  configured?: boolean;
  issues?: LinearIssue[];
  issue?: LinearIssue;
  imported?: boolean | number;
  duplicate?: boolean;
  duplicates?: number;
  taskId?: string;
  results?: Array<{ imported: boolean; duplicate: boolean; taskId?: string; issue: { title: string } }>;
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  value?: T;
}

const PLUGIN_BASE = "/api/plugins/fusion-plugin-linear-import";

function projectPayload(context?: PluginDashboardViewContext): Record<string, string> {
  return context?.projectId ? { projectId: context.projectId } : {};
}

async function postPluginRoute<T>(path: string, body: Record<string, unknown>, context?: PluginDashboardViewContext): Promise<RouteResponse<T>> {
  const response = await fetch(`${PLUGIN_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...projectPayload(context), ...body }),
  });
  const json = await response.json().catch(() => ({})) as RouteResponse<T>;
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `Linear Import request failed with status ${response.status}.`);
  }
  return json;
}

async function getStatus(context?: PluginDashboardViewContext): Promise<RouteResponse<unknown>> {
  const params = new URLSearchParams(projectPayload(context));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const response = await fetch(`${PLUGIN_BASE}/status${suffix}`);
  const json = await response.json().catch(() => ({})) as RouteResponse<unknown>;
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `Linear status failed with status ${response.status}.`);
  }
  return json;
}

function StatusBadge({ state, message }: { state: StatusState; message?: string }) {
  const className = state === "authenticated" ? "auth" : state === "missing" ? "warning" : state === "error" ? "error" : "info";
  const Icon = state === "authenticated" ? CheckCircle2 : state === "loading" ? Loader2 : AlertCircle;
  return (
    <span className={`linear-import-view__status linear-import-view__status--${className}`} aria-live="polite">
      <Icon aria-hidden="true" />
      {message ?? (state === "authenticated" ? "Linear connected" : state === "loading" ? "Checking Linear" : state === "missing" ? "API key needed" : "Linear unavailable")}
    </span>
  );
}

function issueSummary(issue: LinearIssue): string {
  return [issue.team?.key, issue.state?.name, issue.assignee?.name].filter(Boolean).join(" · ") || "No Linear metadata";
}

export function LinearImportView({ context }: { context?: PluginDashboardViewContext }) {
  const [status, setStatus] = useState<StatusState>("loading");
  const [statusMessage, setStatusMessage] = useState<string>();
  const [query, setQuery] = useState("");
  const [teamKey, setTeamKey] = useState("");
  const [state, setState] = useState("active");
  const [assigneeId, setAssigneeId] = useState("");
  const [issues, setIssues] = useState<LinearIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewId, setPreviewId] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "info"; text: string }>();

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getStatus(context)
      .then((result) => {
        if (cancelled) return;
        if (result.authenticated) {
          setStatus("authenticated");
          setStatusMessage("Linear connected");
        } else {
          setStatus("missing");
          setStatusMessage("Add a Linear API key in Plugin Manager settings");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setStatusMessage(error instanceof Error ? error.message : "Linear status check failed");
      });
    return () => { cancelled = true; };
  }, [context?.projectId]);

  const canSearch = status === "authenticated" && !loading;
  const selectedIssues = useMemo(() => issues.filter((issue) => selectedIds.has(issue.id)), [issues, selectedIds]);
  const previewIssue = useMemo(() => issues.find((issue) => issue.id === previewId) ?? selectedIssues[0] ?? issues[0], [issues, previewId, selectedIssues]);

  const browse = useCallback(async () => {
    if (!canSearch) return;
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await postPluginRoute<LinearIssue[]>("/issues", { query, teamKey, state, assigneeId, limit: 50 }, context);
      const nextIssues = result.issues ?? [];
      setIssues(nextIssues);
      setSelectedIds(new Set());
      setPreviewId(nextIssues[0]?.id);
      setMessage(nextIssues.length === 0 ? { type: "info", text: "No Linear issues matched the filters." } : undefined);
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to browse Linear issues." });
    } finally {
      setLoading(false);
    }
  }, [assigneeId, canSearch, context?.projectId, query, state, teamKey]);

  const importOne = useCallback(async (issue: LinearIssue | undefined) => {
    if (!issue || status !== "authenticated") return;
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await postPluginRoute("/issues/import", { issueId: issue.id }, context);
      const text = result.duplicate
        ? `Skipped duplicate ${issue.identifier}; existing task ${result.taskId}.`
        : `Imported ${issue.identifier} as task ${result.taskId}.`;
      setMessage({ type: result.duplicate ? "info" : "success", text });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to import Linear issue." });
    } finally {
      setLoading(false);
    }
  }, [context?.projectId, status]);

  const importSelected = useCallback(async () => {
    if (selectedIssues.length === 0 || status !== "authenticated") return;
    setLoading(true);
    setMessage(undefined);
    try {
      const result = await postPluginRoute("/issues/import-batch", { issueIds: selectedIssues.map((issue) => issue.id) }, context);
      setMessage({ type: "success", text: `Batch import complete: ${result.imported ?? 0} imported, ${result.duplicates ?? 0} duplicates skipped.` });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "Unable to import selected Linear issues." });
    } finally {
      setLoading(false);
    }
  }, [context?.projectId, selectedIssues, status]);

  const toggleIssue = (issueId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
  };

  return (
    <section className="linear-import-view" aria-labelledby="linear-import-heading">
      <header className="linear-import-view__header">
        <div>
          <p className="linear-import-view__eyebrow">Bundled plugin</p>
          <h1 id="linear-import-heading" className="linear-import-view__title">Linear Import</h1>
          <p className="linear-import-view__subtitle">Browse Linear issues and import selected issues into Fusion triage.</p>
        </div>
        <StatusBadge state={status} message={statusMessage} />
      </header>

      {status === "missing" ? (
        <div className="card linear-import-view__message linear-import-view__message--info" role="status">
          Configure the Linear Import plugin in Plugin Manager settings with a Linear API key, then return here to browse issues.
        </div>
      ) : null}

      <form className="card linear-import-view__filters" onSubmit={(event) => { event.preventDefault(); void browse(); }}>
        <label className="linear-import-view__field">
          <span>Search</span>
          <input className="input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title, description, or ENG-123" />
        </label>
        <label className="linear-import-view__field">
          <span>Team key or ID</span>
          <input className="input" value={teamKey} onChange={(event) => setTeamKey(event.target.value)} placeholder="ENG" />
        </label>
        <label className="linear-import-view__field">
          <span>State</span>
          <select className="input" value={state} onChange={(event) => setState(event.target.value)}>
            <option value="active">Active</option>
            <option value="backlog">Backlog</option>
            <option value="started">Started</option>
            <option value="unstarted">Unstarted</option>
            <option value="completed">Completed</option>
            <option value="canceled">Canceled</option>
            <option value="all">All</option>
          </select>
        </label>
        <label className="linear-import-view__field">
          <span>Assignee ID</span>
          <input className="input" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)} placeholder="Optional Linear user UUID" />
        </label>
        <div className="linear-import-view__actions">
          <button className="btn" type="submit" disabled={!canSearch} aria-disabled={!canSearch}>{loading ? "Loading…" : "Browse issues"}</button>
          <button className="btn" type="button" disabled={selectedIssues.length === 0 || loading || status !== "authenticated"} aria-disabled={selectedIssues.length === 0 || loading || status !== "authenticated"} onClick={() => void importSelected()}>Import selected</button>
        </div>
      </form>

      {message ? <div className={`linear-import-view__message linear-import-view__message--${message.type}`} role="status">{message.text}</div> : null}

      <div className="linear-import-view__content">
        <section className="card" aria-label="Linear issue results">
          <h2>Issues</h2>
          {loading ? <p className="linear-import-view__empty"><Loader2 aria-hidden="true" /> Loading Linear issues…</p> : null}
          {!loading && issues.length === 0 ? <p className="linear-import-view__empty">No Linear issues loaded yet. Browse to see matching issues.</p> : null}
          <div className="linear-import-view__issue-list">
            {issues.map((issue) => (
              <article key={issue.id} className="card linear-import-view__issue">
                <input aria-label={`Select ${issue.identifier}`} type="checkbox" checked={selectedIds.has(issue.id)} onChange={() => toggleIssue(issue.id)} />
                <div className="linear-import-view__issue-main">
                  <h3 className="linear-import-view__issue-title"><span className="linear-import-view__identifier">{issue.identifier}</span><span>{issue.title}</span></h3>
                  <p className="linear-import-view__meta">{issueSummary(issue)}</p>
                  <div className="linear-import-view__badges" aria-label="Issue metadata">
                    {issue.team?.key ? <span className="linear-import-view__badge">{issue.team.key}</span> : null}
                    {issue.state?.name ? <span className="linear-import-view__badge">{issue.state.name}</span> : null}
                  </div>
                  <div className="linear-import-view__issue-actions">
                    <button className="btn" type="button" onClick={() => setPreviewId(issue.id)}>Preview</button>
                    <button className="btn" type="button" disabled={loading || status !== "authenticated"} aria-disabled={loading || status !== "authenticated"} onClick={() => void importOne(issue)}>Import</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>

        <aside className="card linear-import-view__preview" aria-label="Linear issue preview">
          <h2>Preview</h2>
          {previewIssue ? (
            <>
              <h3>{previewIssue.identifier}: {previewIssue.title}</h3>
              <p className="linear-import-view__meta">{issueSummary(previewIssue)}</p>
              <pre className="linear-import-view__preview-body">{previewIssue.description?.trim() || "(no description)"}</pre>
              <a href={previewIssue.url} target="_blank" rel="noreferrer">Open in Linear</a>
              <button className="btn" type="button" disabled={loading || status !== "authenticated"} aria-disabled={loading || status !== "authenticated"} onClick={() => void importOne(previewIssue)}>Import previewed issue</button>
            </>
          ) : (
            <p className="linear-import-view__empty">Select or browse an issue to preview its description before importing.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

export default LinearImportView;
