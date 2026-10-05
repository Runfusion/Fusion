import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RemoteUsage } from "../../src/remote-agents/types";
import { api } from "../api/client/client";
import { withProjectId } from "../api/client/health";

type Category = "freshInput" | "cachedInput" | "cacheWrite" | "cacheWriteHour" | "output";
type PricedUsage = RemoteUsage & { charges?: Record<Category, number> | null };
type SessionCost = { usage: PricedUsage[]; estimatedUsd: number | null; partialUsd: number | null; usageComplete: boolean;
  pricingDate: string; pricingSource: string; pricingRecalculated?: boolean; pricedFromIncrements?: boolean };

const money = (n: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(n);
const perMillion = (n: number | null | undefined) => typeof n === "number" ? `${money(n)} / 1M` : "Rate unavailable";

// Disjoint by construction server-side (see categoryCharges), so the rows sum to the model's own total.
const ROWS: Array<{ category: Category; label: string; tokens: (u: RemoteUsage) => number; rate: (u: RemoteUsage) => number | null | undefined }> = [
  { category: "freshInput", label: "Fresh input", tokens: u => u.input, rate: u => u.rates?.inputPer1M },
  { category: "cachedInput", label: "Cached input", tokens: u => u.cached, rate: u => u.rates?.cacheReadPer1M },
  { category: "cacheWrite", label: "Cache writes (5 min)", tokens: u => u.cacheWrite, rate: u => u.rates?.cacheWritePer1M },
  { category: "cacheWriteHour", label: "Cache writes (1 hour)", tokens: u => u.cacheWriteHour, rate: u => u.rates?.cacheWriteHourPer1M },
  { category: "output", label: "Output", tokens: u => u.output, rate: u => u.rates?.outputPer1M },
];

/*
FNXC:RemoteAgents 2026-09-26-23:39:
The operator asked for the plan's accessible cost popup: from a session card, one gesture shows the token
categories, the rate for each and the charge it produced. It opens on hover, on keyboard focus and on click;
a click pins it open, and Escape closes it and returns focus to the trigger. It is a disclosure, not a modal,
so it never traps focus.

The breakdown is fetched only when opened, so a list of cards costs nothing extra. It keeps the card's honesty
rules: an unpriced model says so instead of contributing zero, and a total summed from per-revision increments
says that its rates can differ from the current rates in the rows.
*/
export function RemoteAgentCostPopover({ sessionId, projectId, label }: { sessionId: string; projectId: string; label: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [cost, setCost] = useState<SessionCost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    api<SessionCost>(withProjectId(`/external-sessions/${sessionId}/cost`, projectId), { signal: controller.signal })
      .then(data => { if (!controller.signal.aborted) setCost(data); })
      .catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Cost breakdown unavailable"); });
    return () => controller.abort();
  }, [open, projectId, sessionId]);

  const close = useCallback(() => { setOpen(false); setPinned(false); }, []);

  return <span ref={wrapper} className="remote-cost-popover"
    onMouseEnter={() => setOpen(true)}
    onMouseLeave={() => { if (!pinned) setOpen(false); }}
    onBlur={e => { if (!wrapper.current?.contains(e.relatedTarget as Node | null)) close(); }}
    onKeyDown={e => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" className="remote-cost-trigger remote-agent-cost"
      aria-expanded={open} aria-controls={panelId}
      onFocus={() => setOpen(true)}
      onClick={() => { if (pinned) close(); else { setOpen(true); setPinned(true); } }}>
      {label}
    </button>
    <div id={panelId} role="region" aria-label="Cost breakdown" className="remote-cost-panel card" hidden={!open}>
      {open && (error ? <p role="alert">{error}</p> : !cost ? <p className="remote-agent-meta">Loading cost breakdown…</p> : <>
        <p><strong>{cost.estimatedUsd !== null ? `Total ${money(cost.estimatedUsd)}`
          : cost.partialUsd !== null ? `Priced so far ${money(cost.partialUsd)} (incomplete)` : "Total unavailable"}</strong></p>
        {!cost.usage.length && <p className="remote-agent-meta">No token usage has been reported.</p>}
        {cost.usage.map((u, index) => <table key={`${u.model}:${index}`} className="remote-cost-table">
          <caption>{u.model} · {u.usd === null ? "Unpriced" : money(u.usd)}</caption>
          <thead><tr><th scope="col">Category</th><th scope="col">Tokens</th><th scope="col">Rate</th><th scope="col">Charge</th></tr></thead>
          <tbody>{ROWS.map(row => <tr key={row.category}>
            <th scope="row">{row.label}</th>
            <td>{row.tokens(u).toLocaleString()}</td>
            <td>{perMillion(row.rate(u))}</td>
            {/* A token count with no rate is unpriced, never a $0 charge. */}
            <td>{u.charges && (typeof row.rate(u) === "number" || row.tokens(u) === 0) ? money(u.charges[row.category]) : "Not priced"}</td>
          </tr>)}</tbody>
          {(u.reasoning !== null || !u.charges) && <tfoot><tr><td colSpan={4} className="remote-agent-meta">
            {u.reasoning !== null && `Reasoning ${u.reasoning.toLocaleString()} tokens, included in output. `}
            {!u.charges && (u.reason ?? "No rate is known for this model, so it adds nothing to the total.")}
          </td></tr></tfoot>}
        </table>)}
        {!cost.usageComplete && <p className="remote-agent-meta">Usage is incomplete; unreported tokens are unknown.</p>}
        {cost.pricedFromIncrements && <p className="remote-agent-meta">The total sums each revision at the rates recorded with it, so it can differ from the rows, which use the current rates.</p>}
        {cost.pricingRecalculated && <p className="remote-agent-meta">This session predates the pricing baseline, so these are today's rates, not the rates billed at the time.</p>}
        <p className="remote-agent-meta">Rates: {cost.pricingSource}, {cost.pricingDate}. Estimates from reported tokens, not a provider bill.</p>
      </>)}
    </div>
  </span>;
}
