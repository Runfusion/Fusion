# AgentPulse integration into Fusion

Status: active implementation. No phase acceptance gate has passed. See **Branch state** below for what is built but not merged, deployed or accepted.
Prepared: 2026-09-15.
Last reconciled with fork `main`: 2026-09-26, `e4fd6ec42` against branch `claude/remote-agents-visibility-20260923` at `7870e8f02`.

## Branch state (2026-09-26)

<!--
FNXC:RemoteAgents 2026-09-26-20:48:
Keep built, merged, deployed and accepted as four separate claims. The header previously read as if Phases 2-6 had no
work at all, while the branch carries most of Phases 2, 3 and 5. The deployment notes in the ledger below are a
historical record of earlier rollouts; they are not evidence of what runs on any host today.
-->

Built on the branch, not merged to fork `main`, not deployed, not accepted:

- Phase 2: turn history rendering in the Remote agents panel, with prompts, responses, tool counts and expandable file patches.
- Phase 3: per-turn cost and context use, effective-dated rates priced per revision, frozen cost stamps with an audited operator restamp, expensive session and turn rankings, and a date-range overview.
- Phase 5: full-text search over collected output, per-server collector health, and operator-triggered AI session summaries.
- Reconciliation of collected sessions against Fusion's own task runs by native session ID.

Absent on both fork `main` `e4fd6ec42` and the branch `7870e8f02`: deep links into sessions and turns, turn history in linked Fusion task detail, and the accessible cost popup. Ownership of these three is undecided; do not start them without an explicit assignment.

Not built by decision: session controls, launch requests, managed sessions and Ask threads (see the used-feature inventory). Phase 6 import, cutover and AgentPulse retirement are held for separate approval.
Baseline: Fusion fork `a58b374c7`, including upstream `6e6adf393`; AgentPulse fork `04f0dcf`.

## Outcome

Use Fusion as the single dashboard for Fusion-managed work and Codex/Claude sessions started independently on m3, m5 and J. Show host, project, live activity, prompt/result history, elapsed work time, file changes, model, context, token breakdown and estimated cost. Allow feedback and session controls when the owning runtime supports them. Preserve the historical data collected by AgentPulse.

“Session” and “Fusion task” must remain distinct: one task can have several sessions, and an external session need not be a scheduled task. Observing a session must never enroll it in Fusion's planning, execution, review or merge workflow. Link sessions to tasks explicitly or through verified native identifiers; matching a project path or title alone is insufficient.

## Reuse and gaps

| Capability | Existing foundation | Integration work |
| --- | --- | --- |
| Authentication and access | Fusion dashboard authentication, route registrars and node infrastructure | Host-scoped collector credentials and session access rules |
| Live sessions across hosts | AgentPulse observers, hooks and durable relay; Fusion live events and mesh | External-session ingestion, stable identities, reconciliation and Sessions view |
| Managed agents and controls | Fusion runtime adapters, agents and CLI session transport | Unified capability display and routing to the owning host |
| Prompts, results, elapsed time, diffs | AgentPulse turn-result parser; Fusion task/session UI | Durable imported turns and shared presentation |
| Tokens and costs | Fusion token analytics, TaskCostTab, pricing overrides and refresh support | Provider-normalized accounting, turn breakdowns, cost popup and rankings |
| Feedback to external sessions | AgentPulse feedback queue | Delivery acknowledgements, host routing and supported runtime injection |
| AI summaries | Fusion AI configuration; selected Qwen3.5-2B-4bit on m3 | Bounded summary jobs, provenance and last-summarized position |
| Historical data | AgentPulse session/event store and native transcripts | Resumable import, reconciliation and retention controls |

Scope includes the AgentPulse features used in this deployment. Before implementation, inventory additional AgentPulse surfaces—search, alerts, session notes, launch templates and workspace actions—and map each to a Fusion equivalent or a named follow-up. Do not declare complete parity while a used feature has no replacement.

## Architecture

Implement a Sessions feature within Fusion's existing application. Keep provider transcript parsers and host collectors isolated behind a versioned contract, while reusing Fusion's database, authentication, event delivery, pricing and UI components.

A bundled plugin is an option for collector registration and provider adapters, but it does not remove all Fusion changes: the current plugin UI needs explicit registration in the host's static view registry. Confirm module ownership during phase 0; do not build another dashboard or introduce a second live database.

Data flow:

```text
m3 / m5 / J
  Native transcripts + hooks + runtime handles
       -> local collector and durable spool
       -> authenticated Fusion ingestion on the central server
       -> PostgreSQL session/turn/usage records
       -> Fusion live events -> Sessions view and task detail

Fusion feedback/control request
       -> durable command -> owning host -> provider adapter -> acknowledgement

Session changes -> bounded summary queue -> m3 Qwen3.5-2B-4bit
```

Prefer the current central-server placement on J, subject to verifying the serving Fusion instance and its database. Mesh discovery is useful for host identity and routing; it does not replace transcript delivery. Fusion's shared mesh snapshots currently exclude transcript blobs and local runtime handles.

### Data contract

- **Session:** internal id, stable host id, provider, native session id, project identity, optional Fusion task/run link, observed/managed origin, capabilities, status, last event time and last collector heartbeat.
- **Turn:** native turn id, ordered user prompts, final response, start/end timestamps, duration with source, completion state and collected tool-call count.
- **File change:** turn id, repository-relative path, add/delete/modify operation, patch, added/removed lines, truncation and availability flags. Do not substitute the current working-tree diff for a historical turn's diff.
- **Usage:** native request id where available, model/provider, input/output/cache read/cache write counts, cache lifetime where reported, reasoning count, service tier, context size/capacity and provenance. Preserve unknown values; zero must mean a reported zero.
- **Delivery:** event id, collector version, cursor/sequence and acknowledgement position. Retries and backfill must be idempotent; late events must not overwrite newer state.
- **Command:** request id, session and host identity, requested operation, creation/expiry times and queued/delivered/applied/failed status. Accepted into a queue does not mean applied by the agent.

PostgreSQL migrations should follow Fusion's existing migration ownership and numbering. Keep imported sessions outside task lifecycle tables unless linked. Bound patch sizes, request bodies and retention; paginate history and large output. Reuse current secret-redaction boundaries and never expose arbitrary host filesystem reads through the diff viewer.

### Accounting rules

1. Normalize provider input/cache semantics before totaling. Claude cache creation/read and Codex inclusive input totals cannot be summed using the same raw formula.
2. Use request deltas or a canonical cumulative-counter reconciliation; never add both for the same work. Deduplicate Fusion-native and externally collected observations of the same session.
3. Reasoning is included in output when the provider reports it that way. Cached output is not a separate billable category.
4. Reuse and extend Fusion's pricing service; do not retain independent Fusion and AgentPulse rate tables. Preserve unknown-model and unsupported-tier indicators.
5. Support cache-write lifetime and service-tier differences without guessing unsupported rates. Show counts, per-million rates, charge by category, source and effective date in the popup.
6. Add versioned/effective-dated rates and distinguish cost at recorded rates from a recalculation at current rates. Existing histories lacking applicable rates remain explicitly estimated.
7. Rankings show their date range and coverage. Whole-session totals and individual-turn totals must disclose missing usage and excluded unknown prices. Explain expensive work using measured request volume, context size, output and cache charges rather than invented causes.

## Delivery phases and acceptance gates

Implementation ledger (historical record of earlier rollouts; not current deployment evidence):

- Phase 0: the architecture and recovery path are recorded. The used-feature inventory, sanitized native fixtures and baseline reconciliation are still incomplete.
- Phase 1: authenticated Codex/Claude collectors on J, m3 and m5, durable observation replay, host-aware live cards and feedback are deployed. All three host heartbeats advanced after the 2026-09-22 rollout. Identity/reconnect acceptance and the latency targets have not been measured across all hosts.
- Phase 2: migration 0088, the bounded turn contract, project-scoped paginated reads and revision-idempotent ingestion are deployed in the J application artifact `9739042c8`. Codex and Claude transcript parsers and durable turn delivery were deployed to the three host collectors from `d556695d0`. Collector tests passed 18/18 and focused core/dashboard tests passed 42/42 and 22/22. At the 2026-09-23 check, PostgreSQL contained real turn rows from J and m5; m3's repaired spool still had 361 older observations ahead of 1,750 queued turn revisions. Project-scoped reads and browser presentation still need acceptance checks. The results UI, representative native comparisons and turn-history backfill remain unimplemented.
- Phase 3: session-level usage and estimated cost with category rates exist in the Remote agents panel. Current context/capacity, effective-dated rates, an accessible compact cost popup, turn costs and expensive-task rankings are not complete.
- Phase 4: queued external feedback and delivery receipts exist. Capability-gated stop/resume and full cross-host control acceptance are not complete.
- Phase 5: an AI-overview foundation exists on a separate branch, but Qwen3.5-2B summaries are not deployed or accepted. Search and collector operations UI remain open.
- Phase 6: historical AgentPulse import, parity reconciliation, primary-entry cutover and the 24-hour observation gate have not been completed. Standalone AgentPulse remains available for recovery.

### Next work, in order

1. Let m3's repaired observation spool drain, then verify turn acknowledgements and project-scoped PostgreSQL reads from real Codex and Claude sessions. Diagnose the isolated CLI smoke's `External session project storage unavailable` response; the live J API and focused route/store tests are healthy.
2. Render the persisted turns in Remote agents and linked Fusion task detail: prompt above result, elapsed work time, tool activity, expandable historical file patches, pagination, deep links and explicit unavailable/truncated states. Compare real turns with native output, including the 20-file example if its transcript is available.
3. Complete context size/capacity, normalized request and turn usage, effective-dated model prices, accessible detailed cost popup, and expensive-session/turn explanations with unknown-price coverage.
4. Add only supported host-routed stop/resume controls, prove feedback delivery and command idempotency on disposable sessions across J, m3 and m5, and show queued/unsupported states clearly.
5. Land and configure bounded Qwen3.5-2B summaries; add searchable output and operations health for lag, spool depth, acknowledgements, parser failures and summary failures.
6. Import AgentPulse history with resumable native identities and provenance; reconcile counts, text, patches, usage and prices. Run the 24-hour acceptance window and rehearse rollback before switching the primary entry point. Retiring standalone AgentPulse requires separate explicit approval.

### Phase 0 — Confirm contracts and preserve recovery data

- Audit the current Fusion deployment, database, host identities, auth and live-event mechanism.
- Inventory all used AgentPulse features and existing Fusion equivalents.
- Capture sanitized native transcript fixtures from both providers, including model changes, compacted context, resumed sessions and file edits.
- Record AgentPulse counts and cost coverage by host/provider; take supported database backups and preserve collector configuration.
- Select native feature/plugin ownership and document source licensing/attribution for copied components.

**Gate:** approved technical contract and a feature checklist with no unassigned used capability. No production ingestion changes yet.

### Phase 1 — Collect and list external sessions

- Implement storage, authenticated ingestion, durable acknowledgements and heartbeat reporting.
- Adapt existing collectors on m3/m5/J. Keep replay cursors and delivery acknowledgements independent for Fusion and AgentPulse during comparison.
- Add Sessions navigation, host/project/provider/status filters and stable live cards.
- Reconcile native Fusion sessions with observations to avoid duplicate cards.
- Show working, waiting, completed, disconnected and stale states without transient label flicker. Collector connectivity and agent activity are separate signals.

**Gate:** existing and newly started Codex/Claude sessions on every available host appear once, show the correct host and survive disconnect/reconnect plus replay. Target p95 under 3 seconds for hook-driven updates and under 35 seconds for polling fallback; measure these as acceptance targets, not assumed current performance.

### Phase 2 — Turn history, results and changes

- Port AgentPulse's bounded transcript parsing and durable result ingestion.
- Render each user prompt above its response, measured work duration, tool activity and expandable file patches.
- Support completed and ongoing turns, older-history pagination, deep links and clear unavailable/truncated states.
- Reuse Fusion presentation in linked task detail rather than maintaining two versions of the same result UI.

**Gate:** compare representative turns against native Codex/Claude output, including the known 20-file, +663/-42 example if its source transcript remains available. Replayed or out-of-order delivery must not duplicate turns or lose newer patches.

### Phase 3 — Usage, pricing and expensive-work overview

- Connect normalized external usage to Fusion analytics without double-counting existing task telemetry.
- Show model and total estimated cost on cards; provide an accessible hover/click/focus popup with token categories, rates and charges.
- Show current context and capacity when reported, separately from lifetime tokens.
- Extend price overrides/refresh with effective dates and provenance; keep unsupported models visibly unpriced.
- Add session and turn rankings, date/host/model filters, coverage totals and measured cost drivers.

**Gate:** provider fixture counters reconcile exactly; cost arithmetic matches category rates; repeated imports leave totals unchanged. Compare against AgentPulse over the same records and pricing date, documenting intentional differences.

### Phase 4 — Feedback and controls

- Reuse Fusion controls for sessions it owns. Route external commands through the owning host adapter.
- Port external feedback delivery with explicit capability and delivery state.
- Show stop, resume and send-feedback only where supported; describe queued feedback that requires the session to resume.
- Prevent duplicate command execution after retries. Expired commands must not affect a later session or a reused process id.

**Gate:** disposable sessions on each host verify delivery, cancellation, offline queues, restart recovery and unsupported actions. An observed session must never acquire full-control status merely because a transcript was found.

### Phase 5 — Summaries and operational reliability

- Use Qwen3.5-2B-4bit through the existing m3 endpoint for short summaries, with thinking disabled.
- Summarize only changed content; coalesce work, cap input/output and retry busy responses with bounded backoff.
- Display summary timestamp and covered turn range. Preserve the previous summary during inference outages and indicate when it is stale.
- Add collector lag, spool depth, last acknowledgement, parse errors, command failures and summary failures to operational health.
- Add searchable collected output and any remaining used notes/notification functionality identified in phase 0.

**Gate:** summaries preserve failures and unfinished work; endpoint outages do not block session display. Burst load and an extended disconnect drain successfully without duplicate output or costs.

### Phase 6 — Historical import and cutover

- Run a resumable importer from a consistent AgentPulse snapshot through the same normalization rules as live data.
- Preserve native identities, hosts, timestamps, turns and patches; retain original usage provenance. Do not fabricate missing historical telemetry.
- Compare counts, representative text/diffs, usage totals and price coverage while both dashboards receive data.
- Run at least a 24-hour observation window including host/service restarts and a network outage.
- Switch the primary entry point to Fusion after parity gates pass. Stop AgentPulse ingestion/services only after explicit retirement approval, retaining the recovery snapshot and configuration.

**Gate:** all used features have verified replacements, the reconciliation report explains every discrepancy, and rollback has been rehearsed.

## Validation and rollout discipline

Run one resource-heavy command at a time, with bounded workers. Use focused parser, persistence, route-auth, accounting and command-delivery tests during implementation. Before landing each slice, run Fusion's required lint/typecheck/build and merge gate as applicable; execute concurrent gate lanes serially on this Mac. Browser checks must cover desktop/mobile, keyboard-operated popups, disconnected hosts, missing prices and stable live refresh.

Use feature flags for ingestion, navigation and controls so phases can ship independently. Keep schema changes additive through the comparison period. Rollback disables Fusion collectors/controls and restores the prior entry point; AgentPulse's independently acknowledged spool remains usable. Never replay accepted control commands as part of rollback.

## Existing source anchors

Fusion:
- `packages/core/src/board/token-analytics.ts`
- `packages/core/src/ai/model-pricing.ts`
- `packages/dashboard/app/components/TaskCostTab.tsx`
- `packages/dashboard/app/utils/taskTokenCost.ts`
- `packages/dashboard/src/routes/` and existing CLI session transport
- `docs/PLUGIN_AUTHORING.md`, `docs/storage.md`, `docs/architecture.md`

AgentPulse:
- `scripts/session-results.py`, `scripts/session-usage-backfill.py`, `scripts/relay.ts`
- `src/supervisor/services/codex-observer.ts`
- `src/server/services/session-results.ts`, `src/server/services/session-feedback.ts`
- `src/shared/session-results.ts`, `src/shared/session-telemetry.ts`, `src/shared/model-pricing.ts`
- `src/web/components/CostOverview.tsx`, `src/web/components/CostPopover.tsx`

## Current execution checkpoint

Start with item 1 in **Next work, in order**. Do not advance the Phase 2 gate merely because turn records are queued locally: verify server acknowledgement, project-scoped reads and the browser presentation against native sessions. Keep AgentPulse available through the later parity and rollback gates.
