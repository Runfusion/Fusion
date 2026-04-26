# Agent Paperclip-Style Gap Analysis

## Executive Summary
Fusion already has the core *shape* of a heartbeat-driven agent runtime: agents have lifecycle state, heartbeat runs are tracked, heartbeats can be triggered by timer/assignment/on-demand events, and agents can create follow-up tasks. This gives Fusion a strong baseline for the Paperclip execution model, especially around short-lived run execution (`HeartbeatMonitor.executeHeartbeat()`), agent persistence (`AgentStore`), and lightweight communication (`MessageStore`, task comments).

The largest gaps are ownership and coordination semantics. Paperclip’s model depends on explicit checkout leasing, inbox-driven work picking, blocked-task dedup, wake-context handling (including mention-triggered behavior), and budget-aware escalation rules. Fusion currently executes assigned work, but it does not enforce checkout-first locking or the comment/inbox contract that makes Paperclip runs predictable and conflict-safe.

Recommended priority: first add ownership/inbox primitives (checkout + inbox-lite + wake context), then add policy layers (blocked dedup, self-assignment constraints, communication conventions), and finally add advanced governance parity (budget controls, richer approval/doc workflows). Several adjacent foundations are already covered by existing Fusion tasks (assignment, hierarchy, permissions), so new work should build on those rather than duplicate them.

## Pattern Inventory

### Implemented Patterns

| Pattern | Fusion Implementation | Location in Code |
|---|---|---|
| Heartbeat run execution loop | Wake → task resolution → agent session → run completion | `packages/engine/src/agent-heartbeat.ts` |
| Heartbeat trigger mechanisms | Timer, assignment, and on-demand trigger scheduling | `packages/engine/src/agent-heartbeat.ts` (`HeartbeatTriggerScheduler`), `packages/dashboard/src/routes.ts` (`POST /agents/:id/runs`) |
| Attachment CRUD | Upload/list/download/delete task attachments | `packages/dashboard/src/routes.ts` (`/tasks/:id/attachments*`), `packages/core/src/store.ts` |

### Partial Implementations

| Pattern | What Exists | What's Missing | Packages Affected | Complexity |
|---|---|---|---|---|
| Heartbeat Procedure (9-step) | Simplified wake→check assignment→work→exit | No approval-follow-up, inbox prioritization, checkout, blocked dedup, delegation semantics parity | engine, core, dashboard | M |
| Wake context variables | `contextSnapshot`, `source`, `triggerDetail`, optional `taskId` | No `PAPERCLIP_WAKE_COMMENT_ID`, approval context vars, or env-style propagation | engine, dashboard, core | M |
| Communication model | Task comments + `MessageStore` mailboxes | No mention-routing semantics, no required ticket-link markdown rules | core, dashboard, engine | M |
| Delegation model | `spawn_agent` + `task_create` + dependencies | No `parentId`/`goalId` issue graph semantics, no workspace inheritance flags | core, engine, dashboard | M |
| Chain of command | `reportsTo` hierarchy and `/agents/:id/children` | No explicit `chainOfCommand` resolution/escalation policy in heartbeat flow | core, engine, dashboard | M |
| Routines | Automation schedules and manual runs exist | Not agent-inbox-native routines with webhook/api triggers + catch-up/concurrency policies | core, engine, dashboard | L |
| Planning mode docs | Planning sessions and summary-based task creation | No issue document key/revision API parity (`plan` doc revisions) | core, dashboard, engine | M |
| Approval workflow | `requirePlanApproval`, approve/reject-plan routes | No approval entity model with linked issues and resolution-first heartbeat handling | core, engine, dashboard | M |
| Status model parity | Fusion columns + task status fields | Missing direct parity with `backlog/in_progress/blocked/cancelled` lifecycle model | core, dashboard, engine | M |
| Error-handling policy | Run failure/termination handling and state transitions | No hard rule enforcement (checkout-first, mandatory end-comment, no cross-team cancel) | engine, core | M |
| Agent identity endpoint | `/agents/:id` and run stats exist | No `/agents/me` contract with company-scoped identity + budget fields | dashboard, core | S |
| Instructions-path API parity | `/agents/:id/instructions` supports path/text updates | No dedicated `/agents/:id/instructions-path` endpoint semantics | dashboard, core | S |

### Missing Patterns

| Pattern | Description | Packages Affected | Complexity | Dependencies |
|---|---|---|---|---|
| Checkout mechanism | Exclusive checkout API with 409 conflict semantics and no-retry policy | core, dashboard, engine | L | Task-agent assignment foundation (FN-1096/1098/1099) |
| Inbox-lite work selection | Compact assignment inbox with `in_progress` then `todo` priority and blocked handling | core, dashboard, engine | M | Checkout mechanism |
| Blocked-task dedup | Skip redundant blocked comments when no new context | core, engine | M | Inbox/comment cursor support |
| Budget management | Per-agent budget tracking, 80% throttling, 100% auto-pause | core, engine, dashboard | L | Agent metrics foundations (FN-1184 family) |
| Self-assignment mention handoff rules | Restrict self-assignment to explicit mention-triggered ownership transfer | engine, dashboard, core | M | Inbox + mention wake context |
| Issue search parity | Full-text search across title/identifier/description/comments | core, dashboard | M | Unified indexing strategy |
| Run audit trail header semantics | Uniform mutating-action run correlation equivalent to `X-Paperclip-Run-Id` policy | engine, dashboard, core | M | Checkout + identity context |
| Comment link policy enforcement | Auto-link ticket IDs and enforce company-prefixed internal URL style | dashboard, engine | S | Issue identifier conventions |
| Send-back-to-user handoff | Support assigning tasks back to user (`assigneeUserId`) with `in_review` handoff pattern | core, dashboard, engine | M | Expanded assignee model |

### Not Applicable

| Pattern | Reason it doesn't apply |
|---|---|
| Commit co-author rule (`Co-Authored-By: Paperclip`) | Paperclip-specific governance requirement; Fusion uses task-scoped commit conventions (`feat(FN-xxx): ...`) |
| OpenClaw invite workflow | Paperclip/OpenClaw org provisioning concern, not a Fusion board runtime concern |
| Paperclip company skills workflow APIs | Fusion has no company-level skill package registry model matching Paperclip |
| Paperclip project/workspace setup API shape | Fusion project registration exists but not via Paperclip issue-workflow endpoints |
| Full Paperclip control-plane API parity | Fusion is a different product surface; only overlapping agent-runtime patterns are relevant |

## Detailed Analysis

### 1) Heartbeat Procedure (9-step)
**Status:** PARTIAL  
**Description:** Paperclip requires identity/approval/inbox/pick/checkout/context/work/status/delegate every wake.  
**Current State:** Fusion executes a compact heartbeat run (`executeHeartbeat`) with task fetch and tool-enabled session.  
**Gap:** Missing approval-first branch, inbox-lite prioritization, explicit checkout, and blocked dedup policy.  
**Recommendation:** Extend `executeHeartbeat()` into explicit policy stages and persist per-stage telemetry in run metadata.  
**Files Affected:** `packages/engine/src/agent-heartbeat.ts`, `packages/core/src/types.ts`

### 2) Checkout mechanism (409 no-retry)
**Status:** MISSING  
**Description:** Must claim ownership before work; 409 means abandon and pick different work.  
**Current State:** Fusion relies on scheduler movement/assignment; no explicit lease endpoint.  
**Gap:** No first-class lock/lease primitive with conflict semantics.  
**Recommendation:** Add checkout/release APIs and enforce checkout-before-work in heartbeat + executor flows.  
**Files Affected:** `packages/core/src/agent-store.ts`, `packages/core/src/store.ts`, `packages/dashboard/src/routes.ts`, `packages/engine/src/agent-heartbeat.ts`

### 3) Inbox-lite work selection
**Status:** MISSING  
**Description:** Compact assignment view with priority ordering and blocked filtering.  
**Current State:** Heartbeat resolves a single assigned task (`agent.taskId`).  
**Gap:** No ranked inbox endpoint or work-selection strategy.  
**Recommendation:** Introduce `/agents/:id/inbox-lite` equivalent and priority resolver in heartbeat scheduler.  
**Files Affected:** `packages/core/src/agent-store.ts`, `packages/dashboard/src/routes.ts`, `packages/engine/src/agent-heartbeat.ts`, `packages/engine/src/scheduler.ts`

### 4) Blocked-task dedup
**Status:** MISSING  
**Description:** Avoid repeated blocked updates unless new context appears.  
**Current State:** No built-in dedup against last blocked comment + comment cursor.  
**Gap:** Repetitive blocked churn is possible.  
**Recommendation:** Store last-blocked-comment metadata per task/agent and gate repeated updates.  
**Files Affected:** `packages/core/src/store.ts`, `packages/engine/src/agent-heartbeat.ts`

### 5) Wake context (`PAPERCLIP_*` parity)
**Status:** PARTIAL  
**Description:** Runs carry trigger reason, task/comment/approval context.  
**Current State:** `contextSnapshot` includes wake reason/trigger detail/taskId in run APIs.  
**Gap:** No structured comment-trigger and approval-resolution context model.  
**Recommendation:** Formalize wake context schema in `AgentHeartbeatRun.contextSnapshot` and propagate to prompts/tools.  
**Files Affected:** `packages/core/src/types.ts`, `packages/engine/src/agent-heartbeat.ts`, `packages/dashboard/src/routes.ts`

### 6) Communication model (comments, mentions, link style)
**Status:** PARTIAL  
**Description:** Paperclip uses issue comments, mention-driven wakes, and strict ticket-link markdown conventions.  
**Current State:** Fusion has task comments and message inbox/outbox APIs.  
**Gap:** No mention-to-wake semantics in task comments; no enforced link formatting conventions.  
**Recommendation:** Add mention parser and optional markdown linting for task comment references.  
**Files Affected:** `packages/core/src/message-store.ts`, `packages/core/src/store.ts`, `packages/dashboard/src/routes.ts`, `packages/engine/src/agent-heartbeat.ts`

### 7) Delegation model (`parentId`, `goalId`, workspace inheritance)
**Status:** PARTIAL  
**Description:** Delegation creates structured child/follow-up issues preserving goal/workspace lineage.  
**Current State:** Fusion supports `spawn_agent` and `task_create` with dependencies.  
**Gap:** No explicit parent/goal fields or non-child workspace inheritance marker.  
**Recommendation:** Extend task schema with optional parent/goal/workspace-link fields and expose in creation APIs.  
**Files Affected:** `packages/core/src/types.ts`, `packages/core/src/store.ts`, `packages/engine/src/agent-tools.ts`, `packages/dashboard/src/routes.ts`

### 8) Chain of command escalation
**Status:** PARTIAL  
**Description:** Escalation follows explicit `chainOfCommand`.  
**Current State:** `reportsTo` relationship exists with child lookup route.  
**Gap:** No computed chain traversal/escalation helper in runtime policies.  
**Recommendation:** Add `resolveChainOfCommand(agentId)` utility and escalation tool usage pattern in heartbeat instructions.  
**Files Affected:** `packages/core/src/agent-store.ts`, `packages/engine/src/agent-heartbeat.ts`, `packages/dashboard/src/routes.ts`

### 9) Budget management
**Status:** MISSING  
**Description:** Budget controls (80% focus narrowing, 100% auto-pause).  
**Current State:** Token usage totals are tracked, but no budget thresholds/policies exist.  
**Gap:** No budget envelope or policy enforcement.  
**Recommendation:** Add budget config to agent schema and gate trigger scheduler/execution when budget thresholds are crossed.  
**Files Affected:** `packages/core/src/types.ts`, `packages/core/src/agent-store.ts`, `packages/engine/src/agent-heartbeat.ts`, `packages/dashboard/src/routes.ts`

### 10) Routines
**Status:** PARTIAL  
**Description:** Recurring task triggers integrated with agent inbox pickup and routine policies.  
**Current State:** Fusion automations support cron-like scheduling and manual runs.  
**Gap:** No routine-to-agent-assignment model with dedicated catch-up/concurrency policy vocabulary.  
**Recommendation:** Either map routines onto automation primitives with explicit policy fields or add dedicated routine entities.  
**Files Affected:** `packages/core` (automation domain), `packages/engine` (trigger integration), `packages/dashboard/src/routes.ts`

### 11) Planning mode document revisions
**Status:** PARTIAL  
**Description:** Plan documents keyed by identifier with revision history.  
**Current State:** Planning sessions and summaries exist; task prompt persists spec text.  
**Gap:** No key-based issue document API with base-revision concurrency control.  
**Recommendation:** Add per-task document store (`plan`, etc.) and revision endpoints.  
**Files Affected:** `packages/core/src/store.ts`, `packages/core/src/types.ts`, `packages/dashboard/src/routes.ts`

### 12) Approval workflows
**Status:** PARTIAL  
**Description:** Approval entities linked to issues, reviewed first on wake.  
**Current State:** Planned tasks can require manual approval (`awaiting-approval` + approve/reject routes).  
**Gap:** No standalone approval objects with linked issue resolution metadata.  
**Recommendation:** Add optional approval domain only if needed beyond existing planning approval.  
**Files Affected:** `packages/engine/src/planning.ts`, `packages/dashboard/src/routes.ts`, `packages/core/src/types.ts`

### 13) Self-assignment constraints
**Status:** MISSING  
**Description:** Self-assignment allowed only for explicit mention handoff context.  
**Current State:** Explicit task assignment exists (`PATCH /tasks/:id/assign`) without mention-gated policy.  
**Gap:** Ownership can be changed without mention-driven context checks.  
**Recommendation:** Add policy checks in assignment route/runtime for mention-handoff mode when agent-initiated.  
**Files Affected:** `packages/dashboard/src/routes.ts`, `packages/core/src/store.ts`, `packages/engine/src/agent-heartbeat.ts`

### 14) Status value parity
**Status:** PARTIAL  
**Description:** Paperclip issue statuses differ from Fusion’s board columns/status fields.  
**Current State:** Fusion has columns (`planning`, `todo`, `in-progress`, `in-review`, `done`, `archived`) and ad-hoc task status strings.  
**Gap:** No direct `blocked/cancelled/backlog` canonical lifecycle.  
**Recommendation:** Decide whether to add a normalized execution status enum alongside board columns.  
**Files Affected:** `packages/core/src/types.ts`, `packages/core/src/store.ts`, `packages/dashboard/src/routes.ts`, `packages/engine/src/scheduler.ts`

### 15) Error-handling policy rules
**Status:** PARTIAL  
**Description:** Paperclip enforces checkout-first, mandatory heartbeat comments, and cross-team cancellation restrictions.  
**Current State:** Fusion tracks run failures and transitions states robustly.  
**Gap:** Governance rules are not codified as hard guards.  
**Recommendation:** Add policy middleware in heartbeat execution and task mutation routes.  
**Files Affected:** `packages/engine/src/agent-heartbeat.ts`, `packages/dashboard/src/routes.ts`, `packages/core/src/store.ts`

### 16) Issue search across comments
**Status:** MISSING  
**Description:** Full-text search over title/identifier/description/comments.  
**Current State:** Task list endpoint supports pagination; no query search parameter.  
**Gap:** No index-backed search route covering comments.  
**Recommendation:** Add SQLite FTS index (or equivalent) for task/comment fields and `q=` API.  
**Files Affected:** `packages/core/src/store.ts`, `packages/dashboard/src/routes.ts`

### 17) Attachments API
**Status:** IMPLEMENTED  
**Description:** Upload/list/get/delete artifact attachments per work item.  
**Current State:** Fusion supports attachment upload, retrieval, listing, and deletion for tasks.  
**Gap:** Endpoint shape differs from Paperclip, but core capability exists.  
**Recommendation:** Keep as-is unless external API parity is required.  
**Files Affected:** `packages/dashboard/src/routes.ts`, `packages/core/src/store.ts`

### 18) Agent identity (`GET /me`, role, budget)
**Status:** PARTIAL  
**Description:** Single identity endpoint returns effective role, company scope, budget, chain-of-command metadata.  
**Current State:** Fusion provides `GET /agents/:id` and list endpoints; role/state metadata exists.  
**Gap:** No canonical `/agents/me` and no company/budget identity payload.  
**Recommendation:** Add authenticated `/agents/me` route and extend identity model if budget features are adopted.  
**Files Affected:** `packages/dashboard/src/routes.ts`, `packages/core/src/types.ts`

### 19) Run audit trail mutation header parity
**Status:** MISSING  
**Description:** Every mutating action should be tied to current run identity for auditability.  
**Current State:** Run IDs are persisted for heartbeats, but mutation APIs do not require run-scoped correlation headers.  
**Gap:** Hard to trace all side effects to one heartbeat transaction.  
**Recommendation:** Add optional/required run-correlation metadata for agent-initiated mutations.  
**Files Affected:** `packages/dashboard/src/routes.ts`, `packages/core/src/store.ts`, `packages/engine/src/agent-heartbeat.ts`

### 20) Commit co-author governance
**Status:** NOT APPLICABLE  
**Description:** Paperclip requires a specific co-author line in git commits.  
**Current State:** Fusion enforces task ID commit conventions.  
**Gap:** Governance mismatch is intentional.  
**Recommendation:** No action unless product policy changes.  
**Files Affected:** None

### 21) Company-prefixed ticket-link conventions
**Status:** MISSING  
**Description:** All ticket references should be markdown links with company prefix paths.  
**Current State:** No automatic formatting/linting of task comment references.  
**Gap:** Linking behavior is user-dependent and inconsistent.  
**Recommendation:** Add optional comment formatter/linter for task/agent outputs.  
**Files Affected:** `packages/dashboard/src/routes.ts`, `packages/engine/src/agent-heartbeat.ts`

### 22) OpenClaw invite workflow
**Status:** NOT APPLICABLE  
**Description:** CEO-only OpenClaw invite prompt generation and approval.  
**Current State:** Not part of Fusion’s domain model.  
**Gap:** Out of product scope.  
**Recommendation:** None.  
**Files Affected:** None

### 23) Company skills workflow parity
**Status:** NOT APPLICABLE  
**Description:** Company skill import/scan/sync APIs.  
**Current State:** Fusion has local skill references/instructions, not Paperclip company skill registry APIs.  
**Gap:** Different product boundaries.  
**Recommendation:** None (unless Fusion adopts company-level skill governance).  
**Files Affected:** None

### 24) Instructions-path dedicated endpoint parity
**Status:** PARTIAL  
**Description:** Dedicated endpoint to update only instruction file path.  
**Current State:** Fusion supports generic instruction updates on `/agents/:id/instructions` and full patch route.  
**Gap:** No endpoint-level parity with adapter-key semantics.  
**Recommendation:** Add alias route only if external parity/testing needs it.  
**Files Affected:** `packages/dashboard/src/routes.ts`

### 25) Send-back-to-user handoff
**Status:** MISSING  
**Description:** Explicit handoff from agent back to requesting user (`in_review`, assigneeUserId).  
**Current State:** Task assignment supports `assignedAgentId` only.  
**Gap:** No user assignee field or handoff policy.  
**Recommendation:** Add user-assignment fields and route support for review handoff workflows.  
**Files Affected:** `packages/core/src/types.ts`, `packages/core/src/store.ts`, `packages/dashboard/src/routes.ts`, `packages/engine/src/agent-heartbeat.ts`

## Recommended Implementation Order

1. **Ownership foundation:** implement checkout/release semantics and conflict handling (409 no-retry rule).  
2. **Work selection foundation:** add inbox-lite endpoint + deterministic prioritization + wake-context schema upgrades.  
3. **Policy layer:** blocked-task dedup, self-assignment mention guardrails, and run-audit correlation metadata.  
4. **Communication layer:** mention-triggered wake routing and ticket-link formatting helpers.  
5. **Escalation and governance:** chain-of-command runtime helpers + budget thresholds/auto-pause behavior.  
6. **Workflow parity upgrades:** planning document revisions + richer approval entities (if needed beyond current `awaiting-approval`).  
7. **Search and UX parity:** full-text issue/task search and optional `/agents/me` identity endpoint.  
8. **Deferred/optional parity:** instructions-path alias route and any Paperclip-specific API-shape harmonization.

## Existing Related Tasks

- **FN-1085 (end-to-end agent review):** General agent behavior consistency and bug fixes; relevant umbrella but not a direct replacement for checkout/inbox/budget features.
- **FN-1096 / FN-1098 / FN-1099 (task-agent assignment):** Foundational for checkout/inbox ownership semantics. New work should depend on these conventions rather than redefine assignment.
- **FN-1119 (agent API keys):** Covers auth substrate useful for any future `/agents/me` and run-audit identity policies.
- **FN-1122 (agent permissions):** Relevant for self-assignment restrictions, checkout authorization, and escalation actions.
- **FN-1164 / FN-1165 / FN-1167 (org chart / chain of command):** Direct overlap with escalation-chain gap; avoid duplicate hierarchy modeling.
- **FN-1170 / FN-1172 / FN-1173 (agent instructions):** Overlaps with instructions-path parity and prompt-policy rollout.
- **FN-1181 / FN-1182 / FN-1183 (agent self-reflection):** Can complement blocked dedup and policy-aware heartbeat decisions.
- **FN-1184 / FN-1185 / FN-1186 / FN-1187 (agent performance ratings):** Useful dependency/input for budget-governance and execution throttling logic.
