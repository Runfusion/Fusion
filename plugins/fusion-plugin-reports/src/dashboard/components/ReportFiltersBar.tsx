import { useEffect, useState } from "react";
import type { ReportFilters } from "../types.js";

export function ReportFiltersBar({ filters, onChange, agents }: { filters: ReportFilters; onChange: (next: ReportFilters) => void; agents: string[] }) {
  const [query, setQuery] = useState(filters.q);
  useEffect(() => {
    const timeout = setTimeout(() => onChange({ ...filters, q: query }), 250);
    return () => clearTimeout(timeout);
  }, [query]);

  return <div className="reports-filters">
    <select className="select" value={filters.cadence} onChange={(e) => onChange({ ...filters, cadence: e.target.value as ReportFilters["cadence"] })}><option value="all">All cadence</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select>
    <select className="select" value={filters.status} onChange={(e) => onChange({ ...filters, status: e.target.value as ReportFilters["status"] })}><option value="all">All status</option><option value="generating">Generating</option><option value="review_pending">Review pending</option><option value="review_in_progress">Review in progress</option><option value="review_complete">Review complete</option><option value="approved">Approved</option><option value="published">Published</option><option value="failed">Failed</option></select>
    <input className="input" type="date" value={filters.from} onChange={(e) => onChange({ ...filters, from: e.target.value })} />
    <input className="input" type="date" value={filters.to} onChange={(e) => onChange({ ...filters, to: e.target.value })} />
    <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title" />
    <select className="select" value={filters.agentId} onChange={(e) => onChange({ ...filters, agentId: e.target.value })}><option value="">All agents</option>{agents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}</select>
  </div>;
}
