---
"@runfusion/fusion": minor
---

summary: Idle heartbeat agents now cost a one-line question and wake less often, up to a 30-minute cap.
category: feature
dev: An unassigned heartbeat whose only wake signal is a change in the auto-claim candidate table is answered by a compact tool-less turn (constant system head + candidate ids, <5k chars) instead of the full briefing; answering "NOOP" completes the run with the same wake cursor the full path writes. Consecutive acknowledged no-work heartbeats stretch that agent's dispatch cadence base → 2× → 4× → capped by the new `heartbeatIdleBackoffCapMs` setting (default 1800000), and the first run that finds work resets it. Dashboard Unresponsive timing and next-heartbeat countdowns, plus a manager's Reports Health briefing, stretch by that same agent's own rung; agents that are not idling keep their previous thresholds exactly. Real signals — unread messages, room entries, new steering comments, assigned-row changes, manual wakes — are never deferred and never answered by the compact turn. New per-agent fields `heartbeatIdleStreak` / `heartbeatLastNoWorkAt`; audit event `agent:heartbeat-idle-ladder`; run result reason `idle_preflight_noop`.
