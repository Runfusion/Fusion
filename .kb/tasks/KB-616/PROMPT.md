# Task: KB-616 - Per-Project Runtime Abstraction

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This creates the foundational abstraction for multi-project support, affecting how all engine components are instantiated and orchestrated. The IPC protocol and child process isolation introduce significant complexity and failure modes that require full review.
**Score:** 8/8 — Blast radius: 2 (affects entire engine architecture), Pattern novelty: 2 (new IPC protocol, process management), Security: 2 (child process spawning, IPC boundaries), Reversibility: 2 (database schema changes in dependency KB-615)

## Mission

Create the ProjectRuntime abstraction that allows the kb engine to manage multiple project instances, each with its own TaskStore, Scheduler, Executor, and WorktreePool. This is the core infrastructure for the multi-project feature.

Each project instance runs as a ProjectRuntime — either in-process (default) or in an isolated child process (opt-in). The ProjectManager orchestrates all runtimes and enforces global concurrency limits from CentralCore.

This work follows KB-615 which creates the CentralCore with the central database and project registry.

## Dependencies

- **Task:** KB-615 (Multi-Project Core Infrastructure: CentralCore, central database, and project registry must be complete)

## Context to Read First

- `packages/engine/src/executor.ts` — TaskExecutor lifecycle, event handling, and options interface
- `packages/engine/src/scheduler.ts` — Scheduler implementation and event patterns
- `packages/engine/src/worktree-pool.ts` — WorktreePool patterns for resource management
- `packages/engine/src/concurrency.ts` — AgentSemaphore for global concurrency control
- `packages/engine/src/logger.ts` — Logger patterns used across engine subsystems
- `packages/engine/src/index.ts` — Current exports to understand the engine's public API
- `packages/core/src/store.ts` — TaskStore event system (EventEmitter pattern)
- `packages/core/src/types.ts` — Type patterns, especially Settings and Task types
- `packages/core/src/index.ts` — CentralCore exports to be added by KB-615

## File Scope

- `packages/engine/src/project-runtime.ts` (new — ProjectRuntime interface and types)
- `packages/engine/src/runtimes/in-process-runtime.ts` (new — InProcessRuntime implementation)
- `packages/engine/src/runtimes/child-process-runtime.ts` (new — ChildProcessRuntime implementation)
- `packages/engine/src/ipc/ipc-protocol.ts` (new — IPC message type definitions)
- `packages/engine/src/ipc/ipc-host.ts` (new — Host-side IPC handler)
- `packages/engine/src/ipc/ipc-worker.ts` (new — Worker-side IPC handler)
- `packages/engine/src/project-manager.ts` (new — ProjectManager orchestrator)
- `packages/engine/src/index.ts` (modified — export new types)
- `packages/engine/src/project-runtime.test.ts` (new — tests for all runtime components)
- `packages/engine/src/runtimes/` (new directory)
- `packages/engine/src/ipc/` (new directory)

## Steps

### Step 1: Define ProjectRuntime Interface and Types

- [ ] Create `ProjectRuntime` interface in `packages/engine/src/project-runtime.ts`:
  - `start(): Promise<void>` — lifecycle start
  - `stop(): Promise<void>` — lifecycle stop with graceful shutdown
  - `getStatus(): RuntimeStatus` — return current status (active, paused, errored, stopped, starting, stopping)
  - `getTaskStore(): TaskStore` — access project's TaskStore instance
  - `getScheduler(): Scheduler` — access project's Scheduler instance
  - `getMetrics(): RuntimeMetrics` — in-flight task count, active agent count, last activity timestamp, memory usage
  - EventEmitter interface: `on(event, handler)`, `off(event, handler)`, `emit(event, data)`
  - Events: `task:created`, `task:moved`, `task:updated`, `error`, `health-changed`
- [ ] Define supporting types:
  - `RuntimeStatus` union type: `"active" | "paused" | "errored" | "stopped" | "starting" | "stopping"`
  - `RuntimeMetrics` interface with `inFlightTasks`, `activeAgents`, `lastActivityAt`, `memoryBytes?`
  - `ProjectRuntimeConfig` interface with `projectId`, `workingDirectory`, `isolationMode` ("in-process" | "child-process"), `maxConcurrent`, `maxWorktrees`, plus optional overrides
- [ ] Add logger export in `packages/engine/src/logger.ts`: `export const runtimeLog = createLogger("runtime")`
- [ ] Run typecheck to verify no TypeScript errors

**Artifacts:**
- `packages/engine/src/project-runtime.ts` (new)
- `packages/engine/src/logger.ts` (modified — add runtimeLog)

### Step 2: Implement IPC Protocol

- [ ] Create `packages/engine/src/ipc/ipc-protocol.ts` with message type definitions:
  - Base interface `IpcMessage` with `type: string`, `id: string` (correlation ID), `payload: unknown`
  - Command types: `START_RUNTIME`, `STOP_RUNTIME`, `GET_STATUS`, `GET_METRICS`, `GET_TASK_STORE`, `GET_SCHEDULER`
  - Response types: `OK`, `ERROR` with error message
  - Event types for worker→host forwarding: `TASK_CREATED`, `TASK_MOVED`, `TASK_UPDATED`, `ERROR`, `HEALTH_CHANGED`
  - Payload interfaces for each command/response type
- [ ] Create `packages/engine/src/ipc/ipc-host.ts` for host-side IPC handling:
  - Class `IpcHost` extends EventEmitter
  - Constructor takes `childProcess: ChildProcess` and sets up IPC message listeners
  - Methods: `sendCommand(type, payload): Promise<unknown>` with request/response correlation
  - Event forwarding: listens to child process messages, validates them, emits typed events
  - Error handling for IPC disconnections and malformed messages
- [ ] Create `packages/engine/src/ipc/ipc-worker.ts` for worker-side IPC handling:
  - Class `IpcWorker` extends EventEmitter
  - Detects `process.send` availability (throws if not in IPC mode)
  - Methods: `sendResponse(id, payload)` and `sendEvent(type, payload)` for worker→host communication
  - Command handler registration: `onCommand(type, handler)`
  - Graceful shutdown signal handling (SIGTERM)
- [ ] Add IPC error logger: `export const ipcLog = createLogger("ipc")` in logger.ts
- [ ] Write unit tests for IPC protocol in `packages/engine/src/ipc/ipc-protocol.test.ts`:
  - Test message type safety
  - Test command/response correlation
  - Test serialization/deserialization

**Artifacts:**
- `packages/engine/src/ipc/ipc-protocol.ts` (new)
- `packages/engine/src/ipc/ipc-host.ts` (new)
- `packages/engine/src/ipc/ipc-worker.ts` (new)
- `packages/engine/src/ipc/ipc-protocol.test.ts` (new)
- `packages/engine/src/logger.ts` (modified — add ipcLog)

### Step 3: Implement InProcessRuntime

- [ ] Create `packages/engine/src/runtimes/in-process-runtime.ts`:
  - Class `InProcessRuntime` extends EventEmitter implements ProjectRuntime
  - Constructor takes `ProjectRuntimeConfig` and `CentralCore` reference
  - Properties: private `taskStore: TaskStore`, `scheduler: Scheduler`, `executor: TaskExecutor`, `worktreePool: WorktreePool`
  - Implements `start()`:
    1. Initialize TaskStore with `config.workingDirectory`
    2. Initialize WorktreePool
    3. Initialize Scheduler with TaskStore and optional PrMonitor (null for now)
    4. Initialize TaskExecutor with TaskStore, worktree pool, and global semaphore from CentralCore
    5. Resume orphaned in-progress tasks via `executor.resumeOrphaned()`
    6. Start scheduler via `scheduler.start()`
    7. Set status to "active", emit "health-changed"
  - Implements `stop()`:
    1. Set status to "stopping"
    2. Stop scheduler via `scheduler.stop()`
    3. Wait for executor to finish active tasks (with 30s timeout)
    4. Drain and cleanup worktree pool
    5. Set status to "stopped", emit "health-changed"
  - Implements `getStatus()`, `getTaskStore()`, `getScheduler()`, `getMetrics()`
  - Event forwarding: forward all TaskStore events (`task:created`, `task:moved`, `task:updated`) to runtime listeners
  - Error handling: catch and emit `error` events, transition to "errored" status on fatal errors
- [ ] Add runtime logger entries for lifecycle events
- [ ] Write unit tests in `packages/engine/src/runtimes/in-process-runtime.test.ts`:
  - Test start/stop lifecycle
  - Test event forwarding
  - Test metrics collection
  - Test error handling and status transitions

**Artifacts:**
- `packages/engine/src/runtimes/in-process-runtime.ts` (new)
- `packages/engine/src/runtimes/in-process-runtime.test.ts` (new)

### Step 4: Implement ChildProcessRuntime

- [ ] Create `packages/engine/src/runtimes/child-process-runtime.ts`:
  - Class `ChildProcessRuntime` extends EventEmitter implements ProjectRuntime
  - Constructor takes `ProjectRuntimeConfig` and `centralCore: CentralCore`
  - Properties: private `child: ChildProcess | null`, `ipcHost: IpcHost | null`, `healthMonitor: HealthMonitor`
  - Implements `start()`:
    1. Set status to "starting"
    2. Spawn child process via `fork()` pointing to a worker entry point
    3. Set up IPC host with the child process
    4. Send START_RUNTIME command with serialized config
    5. Wait for OK response or timeout (10s)
    6. Start health monitoring heartbeat
    7. Set status to "active", emit "health-changed"
  - Implements `stop()`:
    1. Set status to "stopping"
    2. Stop health monitoring
    3. Send STOP_RUNTIME command with 30s timeout
    4. Kill child process if graceful shutdown fails
    5. Set status to "stopped", emit "health-changed"
  - Implements `getStatus()`, `getTaskStore()` (throws — not accessible in child mode), `getScheduler()` (throws), `getMetrics()` (queries via IPC)
  - Event forwarding: forward IPC events from IpcHost to runtime listeners
  - Health monitoring: `HealthMonitor` class with heartbeat every 5s, tracks missed heartbeats, auto-restart on 3 consecutive misses with exponential backoff (1s, 5s, 15s max)
  - Auto-restart: on child crash/exit, attempt restart up to 3 times, then transition to "errored"
- [ ] Create `packages/engine/src/runtimes/child-process-worker.ts` (the worker entry point):
  - Module that detects if it's running as a forked child (checks `process.send`)
  - Creates IpcWorker instance
  - Handles START_RUNTIME command: creates InProcessRuntime internally, starts it
  - Handles STOP_RUNTIME command: stops runtime gracefully
  - Forwards all runtime events via IpcWorker.sendEvent
  - Implements heartbeat response
  - Error handling: catches unhandled errors, reports via IPC, attempts graceful shutdown
- [ ] Write unit tests in `packages/engine/src/runtimes/child-process-runtime.test.ts`:
  - Test process spawning and IPC setup
  - Test health monitoring and heartbeat protocol
  - Test auto-restart with backoff
  - Test graceful shutdown
  - Test error handling for process crashes

**Artifacts:**
- `packages/engine/src/runtimes/child-process-runtime.ts` (new)
- `packages/engine/src/runtimes/child-process-worker.ts` (new)
- `packages/engine/src/runtimes/child-process-runtime.test.ts` (new)

### Step 5: Implement ProjectManager

- [ ] Create `packages/engine/src/project-manager.ts`:
  - Class `ProjectManager` extends EventEmitter
  - Constructor takes `centralCore: CentralCore`
  - Properties: private `runtimes: Map<string, ProjectRuntime>`, `globalSemaphore: AgentSemaphore`
  - Implements `addProject(config: ProjectRuntimeConfig): Promise<ProjectRuntime>`:
    1. Validate project config (unique ID, valid working directory with `.fusion/`)
    2. Check if runtime already exists (throw if so)
    3. Create appropriate runtime based on `isolationMode`: InProcessRuntime or ChildProcessRuntime
    4. Start the runtime
    5. Store in `runtimes` map
    6. Forward runtime events to ProjectManager listeners with project attribution
    7. Return runtime instance
  - Implements `removeProject(id: string): Promise<void>`:
    1. Look up runtime, throw if not found
    2. Stop the runtime
    3. Remove from `runtimes` map
    4. Clean up references
  - Implements `getRuntime(id: string): ProjectRuntime | undefined`
  - Implements `listRuntimes(): ProjectRuntime[]`
  - Implements `getGlobalMetrics(): GlobalMetrics`:
    - Aggregate metrics across all runtimes (total in-flight tasks, total active agents, runtime count by status)
  - Global concurrency enforcement:
    - Create `AgentSemaphore` with limit from `centralCore.getGlobalConcurrencyLimit()`
    - Pass semaphore to all InProcessRuntime instances
    - For ChildProcessRuntime, semaphore is managed centrally (child processes don't hold slots directly)
  - Activity feed integration:
    - Forward all runtime events to CentralCore's `recordActivity()` method
    - Add project context to each activity entry
  - Error aggregation: collect errors from all runtimes, emit `error` events with project attribution
- [ ] Add project manager logger: `export const projectManagerLog = createLogger("project-manager")`
- [ ] Write unit tests in `packages/engine/src/project-manager.test.ts`:
  - Test add/remove project lifecycle
  - Test runtime type selection (in-process vs child)
  - Test global concurrency limit enforcement
  - Test event forwarding with project attribution
  - Test error handling and metrics aggregation

**Artifacts:**
- `packages/engine/src/project-manager.ts` (new)
- `packages/engine/src/project-manager.test.ts` (new)
- `packages/engine/src/logger.ts` (modified — add projectManagerLog)

### Step 6: Update Engine Exports and Integration

- [ ] Modify `packages/engine/src/index.ts`:
  - Export `ProjectRuntime` interface and related types
  - Export `InProcessRuntime` class
  - Export `ChildProcessRuntime` class (for advanced use)
  - Export `ProjectManager` class
  - Export IPC types: `IpcMessage`, command/response types
  - Re-export `ProjectRuntimeConfig`, `RuntimeStatus`, `RuntimeMetrics` from project-runtime.ts
- [ ] Ensure all type exports are compatible with existing engine consumers
- [ ] Verify no breaking changes to existing exports
- [ ] Add project runtime logger export if needed
- [ ] Run full typecheck across all engine files

**Artifacts:**
- `packages/engine/src/index.ts` (modified)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run all IPC protocol tests: `pnpm test -- packages/engine/src/ipc/`
- [ ] Run all runtime tests: `pnpm test -- packages/engine/src/runtimes/`
- [ ] Run ProjectManager tests: `pnpm test -- packages/engine/src/project-manager.test.ts`
- [ ] Run full engine test suite: `pnpm test -- packages/engine/`
  - Fix any failing tests
  - Ensure no regressions in existing tests
- [ ] Run typecheck: `pnpm typecheck`
  - Fix any type errors in new or existing code
- [ ] Build the engine package: `pnpm build`
  - Ensure no build errors

**Test Coverage Requirements:**
- IPC protocol: 100% of message types tested
- InProcessRuntime: lifecycle, events, error handling, metrics
- ChildProcessRuntime: spawning, IPC communication, health monitoring, auto-restart, graceful shutdown
- ProjectManager: CRUD operations, concurrency enforcement, event aggregation, metrics

### Step 8: Documentation & Delivery

- [ ] Add JSDoc comments to all public interfaces and classes:
  - `ProjectRuntime` interface with usage examples
  - `InProcessRuntime` class explaining it's the default mode
  - `ChildProcessRuntime` class explaining isolation trade-offs
  - `ProjectManager` class for orchestration
  - IPC message types for protocol documentation
- [ ] Update relevant documentation (if any engine architecture docs exist)
- [ ] Create changeset for the new multi-project runtime feature:
  ```bash
  cat > .changeset/add-project-runtime-abstraction.md << 'EOF'
  ---
  "@gsxdsm/fusion": minor
  ---
  
  Add ProjectRuntime abstraction for multi-project support.
  
  New exports:
  - ProjectRuntime interface for project engine lifecycle
  - InProcessRuntime (default) and ChildProcessRuntime (isolation) implementations
  - ProjectManager for orchestrating multiple projects
  - IPC protocol for child-process isolation mode
  - Global concurrency enforcement across all projects
  EOF
  ```
- [ ] Stage changeset with code changes in final commit
- [ ] Out-of-scope findings: if you discover related refactoring needs, create follow-up tasks via `task_create` tool

**Artifacts:**
- `.changeset/add-project-runtime-abstraction.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/engine/src/index.ts` — Add JSDoc to new exports explaining ProjectRuntime, ProjectManager usage

**Check If Affected:**
- `AGENTS.md` — Update if engine architecture documentation needs multi-project references
- `README.md` — No changes needed (internal abstraction)

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (zero failures in engine package)
- [ ] TypeScript typecheck passes
- [ ] Build passes
- [ ] JSDoc comments on all public APIs
- [ ] Changeset created and staged
- [ ] No breaking changes to existing engine exports

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-616): complete Step N — description`
  - Example: `feat(KB-616): complete Step 1 — define ProjectRuntime interface and types`
- **Bug fixes:** `fix(KB-616): description`
- **Tests:** `test(KB-616): add tests for IPC protocol`

## Do NOT

- Expand task scope beyond ProjectRuntime abstraction (do not implement dashboard multi-project UI — that's KB-618)
- Skip tests for any component (IPC, runtimes, ProjectManager all need tests)
- Modify files outside the File Scope without good reason
- Commit without the task ID prefix
- Add CLI commands (that's KB-619)
- Implement auto-migration logic (that's KB-620)
- Use CentralCore features not yet implemented by KB-615 (wait for dependency or add placeholders with TODOs)

## Implementation Notes

**KB-615 Dependency Handling:**
If KB-615 is not yet complete when you start, use placeholder implementations for CentralCore integration:
- Create a `CentralCore` interface stub in your files with the methods you need
- Add TODO comments referencing KB-615 for real implementation
- The real CentralCore from KB-615 will replace your stubs

**Event System Pattern:**
Follow the TaskStore EventEmitter pattern from `packages/core/src/store.ts`:
- Use `extends EventEmitter<RuntimeEvents>` with typed event map
- Emit events synchronously when state changes
- Document event payloads in JSDoc

**Error Handling:**
- Runtime errors should emit `error` events and transition to "errored" status
- Non-fatal errors (e.g., task execution failure) are handled by the executor, not the runtime
- Fatal errors (e.g., database corruption) transition runtime to "errored" status

**Child Process Worker Entry Point:**
The worker entry point (`child-process-worker.ts`) needs to be importable when forked. Consider:
- Use `new URL(import.meta.url).pathname` to get the current file path
- Fork with `fork(new URL('./child-process-worker.ts', import.meta.url).pathname)`
- Ensure the worker module doesn't execute code at import time (guard with `if (process.send)` check)

**IPC Message Correlation:**
Implement request/response correlation using the `id` field:
- Host generates unique ID for each command
- Worker includes same ID in response
- Host matches responses to pending promises
- Timeout pending commands after 30s and reject with error

**Health Monitoring Protocol:**
- Host sends `PING` command every 5 seconds
- Worker must respond with `PONG` within 5 seconds
- If 3 consecutive pings fail, consider runtime unhealthy
- Auto-restart with exponential backoff: 1s, 5s, 15s delays between attempts
- Max 3 restart attempts before giving up and transitioning to "errored"
