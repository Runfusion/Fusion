---
"@gsxdsm/fusion": patch
---

Fix false "Unresponsive" agent health status in dashboard views

## What Changed

Agent health status in the dashboard now correctly handles several edge cases that previously caused false "Unresponsive" labels:

### Bug Fixes

1. **Agents with monitoring disabled** — Agents with `runtimeConfig.enabled === false` now display "Disabled" instead of being falsely labeled as "Unresponsive"

2. **Inconsistent timeout handling** — `AgentListModal` previously used a hardcoded 60-second timeout, while other views respected per-agent `runtimeConfig.heartbeatTimeoutMs` settings. All views now use the same centralized health evaluation logic

3. **Health badges now stay current** — Dashboard views poll for fresh agent data every 30 seconds to keep health status accurate while views are open

### Technical Details

- New centralized `getAgentHealthStatus()` utility in `packages/dashboard/app/utils/agentHealth.ts`
- All dashboard surfaces (AgentsView, AgentListModal, AgentDetailView) now use the shared utility
- Per-agent timeout overrides (`runtimeConfig.heartbeatTimeoutMs`) are properly respected
- Proper timer cleanup on unmount prevents memory leaks

## How It Works

Health labels are determined in priority order:
- **Terminated/Error/Paused/Running** — based on agent state
- **Disabled** — when heartbeat monitoring is disabled
- **Starting.../Idle** — when no heartbeat data exists
- **Healthy/Unresponsive** — based on elapsed time since last heartbeat vs configured timeout
