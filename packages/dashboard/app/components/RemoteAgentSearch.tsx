import { useCallback, useRef, useState } from "react";
import type { ExternalSessionTurnSearchHit, ExternalSessionTurnSearchPage } from "@fusion/core";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";

/*
FNXC:ExternalSessionSearch 2026-09-23-23:05:
Search over collected output. The deployment this replaces keeps 67,148 indexed documents, so opening
sessions one at a time was never a substitute for asking "where did we discuss X?".

ts_headline returns a highlighted excerpt delimited by <mark>. It is session transcript text, which is
untrusted, so it is SPLIT and rendered as React elements rather than injected as HTML. Never switch this to
dangerouslySetInnerHTML: the delimiters are the only trusted part of that string.
*/
const MARK = /<mark>([\s\S]*?)<\/mark>/g;

export function highlightSegments(snippet: string): { text: string; match: boolean }[] {
  const segments: { text: string; match: boolean }[] = [];
  let index = 0;
  for (const found of snippet.matchAll(MARK)) {
    if (found.index > index) segments.push({ text: snippet.slice(index, found.index), match: false });
    segments.push({ text: found[1] ?? "", match: true });
    index = found.index + found[0].length;
  }
  if (index < snippet.length) segments.push({ text: snippet.slice(index), match: false });
  return segments;
}

function Snippet({ snippet }: { snippet: string }) {
  return <p className="remote-search-snippet">
    {highlightSegments(snippet).map((segment, i) => segment.match
      ? <mark key={i}>{segment.text}</mark>
      : <span key={i}>{segment.text}</span>)}
  </p>;
}

export function RemoteAgentSearch({ projectId, hostId, onOpenSession }: {
  projectId: string; hostId?: string; onOpenSession: (sessionId: string) => void;
}) {
  const [term, setTerm] = useState("");
  const [page, setPage] = useState<ExternalSessionTurnSearchPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const run = useCallback(async (value: string) => {
    const current = ++generation.current;
    if (!value.trim()) { setPage(null); setError(null); return; }
    setBusy(true);
    try {
      const query = new URLSearchParams({ q: value });
      if (hostId) query.set("hostId", hostId);
      const result = await api<ExternalSessionTurnSearchPage>(withProjectId(`/external-sessions/search?${query}`, projectId));
      if (current !== generation.current) return;
      setPage(result); setError(null);
    } catch (e) {
      if (current === generation.current) { setError(e instanceof Error ? e.message : "Search unavailable"); setPage(null); }
    } finally { if (current === generation.current) setBusy(false); }
  }, [hostId, projectId]);
  const hits: ExternalSessionTurnSearchHit[] = page?.hits ?? [];
  return <section className="remote-agent-search" aria-labelledby="remote-search-heading">
    <h3 id="remote-search-heading">Search collected output</h3>
    <form role="search" onSubmit={e => { e.preventDefault(); void run(term); }}>
      <label htmlFor="remote-search-input">Search prompts and responses</label>
      <input id="remote-search-input" type="search" value={term} onChange={e => setTerm(e.target.value)}
        placeholder="words, &quot;exact phrase&quot;, -exclude" />
      <button className="btn btn-sm" type="submit" disabled={busy || !term.trim()}>{busy ? "Searching…" : "Search"}</button>
    </form>
    {error && <p role="alert" aria-label="Search error">{error}</p>}
    <p className="remote-agent-meta" role="status" aria-label="Search status">
      {!page ? "" : page.query === null
        ? "That search had no searchable words. Try a more specific term."
        : `${hits.length}${page.more ? "+" : ""} ${hits.length === 1 && !page.more ? "match" : "matches"} for ${page.query}.`}
    </p>
    {!!hits.length && <ul className="remote-search-results" aria-label="Search results">
      {hits.map(hit => <li key={`${hit.sessionId}:${hit.nativeTurnId}`} className="card remote-search-hit">
        <button onClick={() => onOpenSession(hit.sessionId)}>
          <strong>{hit.title || hit.sessionId.slice(0, 12)}</strong>
          <span className="remote-agent-meta">{hit.hostId} · {hit.provider} · turn {hit.ordinal + 1}</span>
        </button>
        <Snippet snippet={hit.snippet} />
      </li>)}
    </ul>}
    {page?.more && <p className="remote-agent-meta">More turns matched than are shown. Narrow the search to see the rest.</p>}
  </section>;
}
