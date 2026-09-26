# AgentPulse used-feature inventory (Phase 0 gate)

Measured: 2026-09-24, against the live production AgentPulse on J
(`agentpulse.service`, `agentpulse-supervisor.service`, `agentpulse-private-relay.service`,
SQLite at `/home/ubuntu/.agentpulse/data/agentpulse.db`, 1,013,276,672 bytes).

The integration plan scopes parity to "the AgentPulse features **used in this deployment**".
This inventory answers that from data rather than from the source tree: a feature whose tables
hold zero rows after the deployment's whole lifetime is not in use here. Row counts are the
evidence; the code surface exists for all of them.

## Used — these need a Fusion equivalent

| AgentPulse capability | Evidence (rows) | Fusion status |
| --- | --- | --- |
| Session observation | `sessions` 556 | **Done.** Phase 1; `external_sessions`, Remote agents panel. |
| Session events | `events` 96,006 | **Done.** Observation ingestion with durable replay. |
| Turn history / results | covered by `events` | **Done.** Turn history renders with per-turn cost and context. |
| Full-text search over output | `search_events_fts` 67,148 docs; `search_sessions_fts` 556 | **Done.** Migration 0089 GIN index and the search panel. |
| AI watcher runs | `ai_watcher_runs` 817 | **Superseded.** Zero durable output here (see correction). Summaries were built on request as a NEW capability, not a port. |
| Session control actions | `control_actions` 7 | **Missing.** Phase 4 stop/resume, capability-gated. |
| Managed sessions | `managed_sessions` 4 | **Partial.** Fusion owns its own sessions; external managed-session control is Phase 4. |
| Launch requests | `launch_requests` 4 | **Missing.** Low usage; candidate for a named follow-up rather than parity. |
| Supervisors + credentials | `supervisors` 3, `supervisor_credentials` 3 | **Equivalent.** Fusion host-scoped collector credentials cover host identity/auth. |
| Ask threads | `ask_threads` 1, `ask_messages` 2 | **Near-unused.** Fusion Chat is the equivalent; propose follow-up, not parity. |
| Settings | `settings` 9 | **Equivalent.** Fusion global settings. |
| LLM providers | `llm_providers` 1 | **Equivalent.** Fusion provider/credential settings. |
| API keys | `api_keys` 1 | **Equivalent.** Collector credentials. |
| Cost overview | `CostOverview.tsx` | **Built on branch.** Session and card totals, per-turn costs, effective-dated rates, rankings, and the range overview with day/model/server breakdown. |
| Cost popover | `CostPopover.tsx` | **Missing.** Costs render as inline text only; there is no hover/click/focus popup with token categories, rates and charges (plan Phase 3). |

## Not used in this deployment — zero rows, not parity requirements

`watcher_proposals`, `watcher_configs`, `users`, `supervisor_enrollment_tokens`,
`session_templates`, `projects`, `project_alert_rules`, `project_alert_rule_fires`,
`notification_channels` (Telegram), `event_embeddings` (vector search), `auth_sessions`,
`ai_qa_cache`, `ai_pending_project_drafts`, `ai_inbox_snoozes`.

This retires a large amount of assumed scope: Telegram channels, project alert rules, session
templates, vector/semantic search, the HITL inbox snooze flow and AgentPulse's own user/auth
model carry no data here. Each is recorded as a **named follow-up**, not a blocker, per the
Phase 0 gate wording ("no unassigned used capability"). If any is later switched on in
AgentPulse, it re-enters scope and this table must be re-measured.

## Correction, measured 2026-09-24: row counts over-counted usage

The first pass of this inventory treated a non-zero row count as evidence of use. That was wrong, and it
over-stated four capabilities. Re-measured by timestamp and by durable output:

**Everything except sessions and events is confined to one 4-minute commissioning window.**

| Table | Rows | First → last |
| --- | --- | --- |
| `events` | 96,180 | 2026-07-12 → 2026-09-23 (ongoing) |
| `ask_threads` / `ask_messages` | 1 / 2 | 2026-09-15 09:11:01 → 09:11:13 |
| `launch_requests` | 4 | 2026-09-15 09:13:22 → 09:17:03 |
| `managed_sessions` | 4 | 2026-09-15 09:13:26 → 09:17:08 |
| `control_actions` | 7 | 2026-09-15 09:14:50 → 09:17:25 |

The control actions carry the synthetic prompt "Reply exactly: follow-up control passed. Do not use tools.",
and their `metadata_json.executionState` is `failed` ("No conversation found with session ID") even though the
outer row status is `succeeded`. These are commissioning tests of the control path, not operator use.

**The AI watcher runs but retains nothing.** All 817 runs are `status=succeeded`, `trigger_kind=idle`, with no
error sub-type, and they continue daily (162 on 09-19, 3 on 09-23). But:

- `proposal_id` is set on **0** of them, and `watcher_proposals` holds 0 rows.
- `sessions.plan_summary`, `current_task`, `semantic_status`, `watcher_state` and `watcher_last_run_at` are
  populated on **0** of 556 sessions.
- No `event_type` relates to AI or summaries; the 12 types are all transcript/hook events.
- `sum(ai_spend_cents)` is **0** across 0 sessions.

The provider is genuinely configured (`M3 MLX Qwen3.5 2B 4-bit`, openai_compatible, `http://m3:8080/v1`), so
this is not a missing-configuration artifact. The feature executes and produces no durable, user-visible
output in this deployment.

**Consequence.** Porting AI summaries would reproduce a subsystem whose measured output here is nothing, and
Phase 6 could not reconcile it against anything, because there is no stored summary to compare. Likewise,
controls, launches, managed sessions and Ask have no operator-generated history to reconcile. They are
recorded as named follow-ups on the same footing as the zero-row features below, and should be built when
someone wants the capability — not to reach parity with data that does not exist.

Genuinely used, continuously, for two and a half months: **session observation, transcript events, turn
results and the search index built from them**. Those are ported.

## Consequences for ordering

1. Turn history rendering (Phase 2) — DONE.
2. Search over collected output (Phase 5) — DONE. 67k indexed documents, real demonstrated use.
3. Operational health (Phase 5) — collector lag, spool depth, last acknowledgement, parse and command
   failures. Not an AgentPulse port; it is what makes the ported pipeline observable, and it is the only
   remaining item that serves day-to-day operation.
4. Rest of Phase 3 — per-turn costs, context size vs capacity, effective-dated rates, rankings.
5. AI summaries, controls, launches, managed sessions, Ask — build on request, not for parity. See the
   correction above: none has durable operator-generated data in this deployment.

## Session summaries were built on request, as a new capability (2026-09-24)

The operator asked for AI summaries directly (decision F3 = A), explicitly as a NEW Fusion capability rather
than a parity port. The distinction is load-bearing and is recorded in the code: there is no AgentPulse
behaviour to reproduce here, so nothing in the implementation may be justified by "AgentPulse did it this way".

What was built instead is what makes a summary trustworthy on its own terms: one durable summary per session,
stored with the turn range it covered; staleness derived from the session's current turns rather than stored;
and a failed attempt that preserves the previous summary, because during an inference outage the older summary
plus an explicit failure is strictly more useful than an empty pane. Generation is operator-triggered, so
opening a session costs nothing. It uses Fusion's own title-summarizer model lane, not AgentPulse's Qwen
configuration.

Historical import (Phase 6) must carry `sessions` 556 and `events` 96,006, and its
reconciliation report is what proves parity. Retiring AgentPulse still requires separate
explicit approval, and the recovery snapshot is retained regardless.


## Parity status as of 2026-09-24

Every capability measured as genuinely used has a Fusion equivalent built on branch
`claude/remote-agents-visibility-20260923`, except the cost popover:

<!--
FNXC:RemoteAgents 2026-09-26-20:48:
"Built" in this document means committed on the branch above (`7870e8f02`). It does not mean merged, deployed or
accepted; none of those is claimed here. The cost popover was earlier marked Done on the strength of inline cost
labels, which do not provide the accessible popup the plan requires, so it is corrected to Missing.
-->

| Used capability | Fusion equivalent |
| --- | --- |
| Session observation, events | `external_sessions`, durable replay ingestion |
| Turn history / results | Turn history panel, per-turn cost and context |
| Full-text search over output | Migration 0089 GIN index, search panel |
| Cost overview | Card and session totals, per-turn costs, effective-dated rates, rankings, range overview |
| Cost popover | **Missing** — inline cost text only, no accessible popup |
| Supervisors, credentials, settings, providers, API keys | Host-scoped collector credentials, Fusion settings |

Still deliberately NOT built, because the corrected measurement showed their entire recorded use falls inside a
single four-minute commissioning window on 2026-09-15 rather than operational use: **session controls**
(`control_actions` 7), **launch requests** (4), **managed sessions** (4), **Ask threads** (1). These remain
named follow-ups to build on request, exactly as the operator directed — not parity obligations.

Two capabilities were built that AgentPulse does not provide at all, and neither is a parity claim: operational
collector health (F-series groundwork) and AI session summaries (F3 = A).

### The combined task + external total is NOT in parity scope

Worth stating explicitly, because it is easy to assume otherwise. AgentPulse never held Fusion task telemetry,
so its cost overview aggregated its OWN sessions only — which is exactly what the Fusion overview does. The
idea of a single figure spanning `tasks.token_usage_*` and external usage comes from the integration plan's
Phase 3 wording, not from any AgentPulse behaviour.

It also cannot be built honestly yet. F4 attribution proves overlap only where a native session id was written
back into `cli_sessions`, and that table held **0 rows** at the measurement recorded in
docs/external-session-task-telemetry-boundary.md. With nothing to match against, every external session resolves
as unattributed — and unattributed means *unproven*, not *proven separate*. A combined total today would
therefore rest on the same unproven assumption the boundary document rejected. The overview reports the
Fusion-run portion as a split of the external total instead, which is safe because it never adds the two.
