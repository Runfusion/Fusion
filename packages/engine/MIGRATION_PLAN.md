# ProjectEngine Migration Plan

Status: In progress
Last updated: 2026-04-12

## Goal

Consolidate all engine subsystem wiring into `ProjectEngine` so that every code path
(single-project CLI, multi-project ProjectManager, child-process worker) gets the full
subsystem set from one place. This eliminates the class of bugs where a subsystem is
added in one code path but forgotten in another (e.g., TriageProcessor was missing from
InProcessRuntime for multi-project mode).

## Current architecture

```
Single-project CLI (serve.ts / dashboard.ts)
  └─ Creates subsystems inline + passes to createServer

Multi-project (ProjectManager)
  └─ InProcessRuntime / ChildProcessRuntime / RemoteNodeRuntime
       └─ ChildProcessRuntime → child-process-worker.ts → ProjectEngine
```

## What ProjectEngine now handles

These subsystems are managed by ProjectEngine and should NOT be duplicated inline:

| Subsystem | Source |
|---|---|
| InProcessRuntime (TaskStore, Scheduler, TaskExecutor, TriageProcessor, StuckTaskDetector, AgentSemaphore, WorktreePool, UsageLimitPauser, AgentStore) | via InProcessRuntime |
| PrMonitor + PrCommentHandler | ProjectEngine |
| NtfyNotifier | ProjectEngine |
| CronRunner + AutomationStore | ProjectEngine |
| Auto-merge queue (with conflict retry, verification error handling, cooldown retry, buffer failure healing) | ProjectEngine |
| Settings event listeners (global pause, unpause, engine unpause, stuck timeout, insight extraction sync) | ProjectEngine |

## What remains inline in serve.ts / dashboard.ts

These components are CLI-specific and NOT yet in ProjectEngine. Future migration
candidates are marked with priority.

### High priority (shared across serve.ts and dashboard.ts)

| Component | Why it's inline | Migration path |
|---|---|---|
| **MissionAutopilot** | Needs scheduler ref (circular dep via `setScheduler`). Created before engine start. | Add to ProjectEngine. Break circular dep by having ProjectEngine call `setScheduler()` internally after runtime start. |
| **MissionExecutionLoop** | Coupled to MissionAutopilot. Needs taskStore + missionStore + rootDir. | Move alongside MissionAutopilot into ProjectEngine. |
| **SelfHealingManager** | Needs executor + triage refs for recovery callbacks. Currently uses late-binding `executorRef`/`triageRef`. | Add to ProjectEngine. Wire callbacks to internal runtime's executor/triage. Expose `recoverCompletedTask` etc. |

### Medium priority (shared but with CLI-specific behavior)

| Component | Why it's inline | Migration path |
|---|---|---|
| **HeartbeatMonitor** | Utility path (no semaphore). Needs agentStore, taskStore, rootDir, and CLI-specific callbacks (`onMissed`, `onTerminated` log to console). | Add to ProjectEngine with configurable callbacks. Keep as utility (no semaphore gating). |
| **HeartbeatTriggerScheduler** | Paired with HeartbeatMonitor. Needs agentStore + callback to HeartbeatMonitor. | Move alongside HeartbeatMonitor. |
| **AuthStorage + ModelRegistry + extension loading** | Pi-coding-agent specific. Discovers extensions, registers providers, syncs OpenRouter models. | Keep in CLI layer — this is auth/model wiring, not engine orchestration. Not a ProjectEngine concern. |

### Low priority (CLI-specific, keep inline)

| Component | Reason to keep inline |
|---|---|
| **PluginStore + PluginLoader** | Plugin system is a dashboard/CLI concern, not engine. |
| **`createServer()` call** | HTTP server setup is CLI-specific. |
| **Diagnostic utilities** | Process monitoring, memory logging — CLI concern. |
| **Port selection** | Interactive prompt — CLI concern. |
| **CentralCore node registration** | Registers local node status — serve.ts specific. |
| **`onMemoryInsightRunProcessed` callback** | Already passed via `onInsightRunProcessed` to ProjectEngine. The detailed `processAndAuditInsightExtraction` call can stay as the callback impl. |

## Migration sequence

### Phase 1 (current — in progress)
- [x] Add TriageProcessor to InProcessRuntime
- [x] Create ProjectEngine wrapper
- [x] Migrate child-process-worker to ProjectEngine
- [x] Shared global semaphore from ProjectManager
- [x] Move richer merge logic (verification handling, cooldown retry) into ProjectEngine
- [ ] Migrate serve.ts to use ProjectEngine (agent in progress)
- [ ] Migrate dashboard.ts to use ProjectEngine (agent in progress)

### Phase 2 (next)
- [ ] Move MissionAutopilot + MissionExecutionLoop into ProjectEngine
  - Add `missionStore` to ProjectEngineOptions
  - Create MissionAutopilot internally, wire setScheduler after start
  - Expose via `getMissionAutopilot()` / `getMissionExecutionLoop()`
- [ ] Move SelfHealingManager into ProjectEngine
  - Wire callbacks to internal runtime's executor/triage
  - No external configuration needed

### Phase 3 (later)
- [ ] Move HeartbeatMonitor + HeartbeatTriggerScheduler into ProjectEngine
  - Add heartbeat callbacks to ProjectEngineOptions
  - Keep as utility path (no semaphore)
  - Expose via `getHeartbeatMonitor()`
- [ ] Audit serve.ts / dashboard.ts for remaining inline engine wiring
- [ ] Consider making `createServer` accept a ProjectEngine directly

## Design principles

1. **ProjectEngine is the single source of truth** for engine subsystem composition
2. **CLI layer** only handles: HTTP server, auth, plugins, diagnostics, UI-specific callbacks
3. **Callbacks over hardcoding** — ProjectEngine accepts option callbacks for CLI-specific behavior (merge strategy, PR merge, insight processing, etc.)
4. **No duplicate subsystems** — if ProjectEngine creates it, CLI must not also create it
5. **Dev mode** — dashboard.ts `opts.dev` skips engine start entirely; ProjectEngine handles this via not calling `start()`
