# Task: KB-501 - Per-Project Runtime Abstraction and Hybrid Executor Lifecycle

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This is foundational infrastructure for multi-project execution that creates a new runtime abstraction layer. High blast radius as it restructures how tasks are executed across multiple projects. Security implications around child-process isolation and IPC. Pattern novelty in the hybrid lifecycle management.
**Score:** 7/8 — Blast radius: 2, Pattern novelty: 2, Security: 2, Reversibility: 1

## Mission

Build the per-project runtime abstraction that enables kb to execute tasks across multiple projects with configurable isolation modes. Create a `ProjectRuntime` interface with two implementations:

1. **InProcessProjectRuntime** — runs tasks in the current Node.js process (current behavior, efficient for trusted projects)
2. **ChildProcessProjectRuntime** — runs tasks in a forked child process (isolation for untrusted or resource-intensive projects)

Implement a `HybridExecutor` that manages the lifecycle of project runtimes, handles switching between isolation modes, and coordinates task execution across all registered projects. This layer sits between the `CentralCore` (KB-500) and the existing `TaskExecutor`, enabling the engine to route tasks to the appropriate runtime based on project configuration.

## Dependencies

- **Task:** KB-500 (Core Infrastructure: Central database, project registry, unified activity feed)
  - Must provide: `CentralCore`, `ProjectRegistry`, `RegisteredProject.isolationMode`, `RegisteredProject.id`
  - Must expose: project registry API, global concurrency tracking

## Context to Read First

- `packages/engine/src/executor.ts` — Current `TaskExecutor` implementation (lines 1-300 for structure)
- `packages/engine/src/scheduler.ts` — How tasks are scheduled and dispatched
- `packages/engine/src/concurrency.ts` — `AgentSemaphore` for concurrency control
- `packages/engine/src/worktree-pool.ts` — Worktree pooling patterns
- `packages/core/src/types.ts` — Types including `IsolationMode`, `Task`, `Settings`
- `packages/engine/src/index.ts` — Current engine exports
- KB-500's `packages/core/src/central-core.ts` (when complete) — Central orchestration API

## File Scope

### New Files
- `packages/engine/src/project-runtime.ts` — `ProjectRuntime` interface definition
- `packages/engine/src/in-process-runtime.ts` — `InProcessProjectRuntime` class
- `packages/engine/src/child-process-runtime.ts` — `ChildProcessProjectRuntime` class
- `packages/engine/src/runtime-ipc.ts` — IPC protocol types and message handlers
- `packages/engine/src/hybrid-executor.ts` — `HybridExecutor` main orchestrator
- `packages/engine/src/runtime-worker.ts` — Child process entry point script
- `packages/engine/src/__tests__/in-process-runtime.test.ts` — In-process runtime tests
- `packages/engine/src/__tests__/child-process-runtime.test.ts` — Child process runtime tests
- `packages/engine/src/__tests__/hybrid-executor.test.ts` — Hybrid executor tests
- `packages/engine/src/__tests__/runtime-ipc.test.ts` — IPC protocol tests

### Modified Files
- `packages/engine/src/index.ts` — Export new runtime classes and types
- `packages/engine/src/scheduler.ts` — Refactor to use `ProjectRuntime` abstraction
- `packages/engine/src/executor.ts` — Extract project-specific logic to runtime

## Steps

### Step 1: ProjectRuntime Interface Definition

- [ ] Define `ProjectRuntime` interface in `packages/engine/src/project-runtime.ts`:
  ```typescript
  export interface ProjectRuntime {
    readonly projectId: string;
    readonly projectPath: string;
    readonly isolationMode: IsolationMode;
    readonly status: RuntimeStatus; // 'starting' | 'ready' | 'busy' | 'error' | 'shutdown'
    
    // Lifecycle
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    
    // Task execution
    executeTask(taskId: string): Promise<TaskExecutionResult>;
    
    // Health & monitoring
    getHealth(): Promise<RuntimeHealth>;
    on(event: RuntimeEventType, handler: (data: unknown) => void): void;
    off(event: RuntimeEventType, handler: (data: unknown) => void): void;
  }
  ```
- [ ] Define supporting types:
  - `RuntimeStatus`: 'starting' | 'ready' | 'busy' | 'error' | 'shutdown'
  - `RuntimeHealth`: { status, activeTasks, memoryUsage, lastActivityAt, errorCount }
  - `TaskExecutionResult`: { success, taskId, error?, stepsCompleted? }
  - `RuntimeEventType`: 'task:started' | 'task:completed' | 'task:failed' | 'health:changed' | 'error'
- [ ] Write unit tests for interface compliance (using a mock implementation)
- [ ] Run targeted tests: `pnpm test packages/engine/src/__tests__/project-runtime.test.ts`

**Artifacts:**
- `packages/engine/src/project-runtime.ts` (new)
- `packages/engine/src/__tests__/project-runtime.test.ts` (new)

### Step 2: In-Process Runtime Implementation

- [ ] Create `InProcessProjectRuntime` class in `packages/engine/src/in-process-runtime.ts`:
  - Wraps existing `TaskExecutor` and `Scheduler` patterns
  - Constructor takes `projectId`, `projectPath`, `CentralCore`, and options
  - Creates internal `TaskStore` instance for the project path
  - Creates internal `TaskExecutor` with appropriate options
  - Creates internal `Scheduler` with the store
  - Maintains current in-process execution behavior exactly
- [ ] Implement lifecycle methods:
  - `initialize()`: Start scheduler polling, resume orphaned tasks
  - `shutdown()`: Stop scheduler, wait for active tasks, cleanup
- [ ] Implement `executeTask(taskId)`:
  - Validate task exists and is in 'todo' column
  - Move to 'in-progress' via store
  - Return result when task completes (success/fail)
- [ ] Implement event forwarding:
  - Forward TaskStore events as Runtime events
  - Maintain EventEmitter pattern
- [ ] Write comprehensive tests:
  - Initialize/shutdown lifecycle
  - Task execution flow
  - Event emission
  - Health reporting
- [ ] Run targeted tests: `pnpm test packages/engine/src/__tests__/in-process-runtime.test.ts`

**Artifacts:**
- `packages/engine/src/in-process-runtime.ts` (new)
- `packages/engine/src/__tests__/in-process-runtime.test.ts` (new)

### Step 3: IPC Protocol for Child Process Runtime

- [ ] Create `packages/engine/src/runtime-ipc.ts` with IPC protocol:
  ```typescript
  export type IPCMessage = 
    | { type: 'init'; projectId: string; projectPath: string; settings: Settings }
    | { type: 'init:result'; success: boolean; error?: string }
    | { type: 'execute'; taskId: string }
    | { type: 'execute:result'; success: boolean; error?: string }
    | { type: 'health:get' }
    | { type: 'health:result'; health: RuntimeHealth }
    | { type: 'shutdown' }
    | { type: 'shutdown:result' }
    | { type: 'event'; eventType: RuntimeEventType; data: unknown }
    | { type: 'log'; level: 'log' | 'error' | 'warn'; message: string }
    ;
  ```
- [ ] Implement `IPCChannel` class:
  - Wraps `process.send()` / `process.on('message')` in child
  - Wraps `ChildProcess.send()` / `child.on('message')` in parent
  - Promise-based request/response pattern with timeout (30s default)
  - Request ID tracking for correlation
- [ ] Implement message validation using Zod or runtime checks
- [ ] Write tests for IPC protocol:
  - Message serialization/deserialization
  - Request/response correlation
  - Timeout handling
  - Error propagation
- [ ] Run targeted tests: `pnpm test packages/engine/src/__tests__/runtime-ipc.test.ts`

**Artifacts:**
- `packages/engine/src/runtime-ipc.ts` (new)
- `packages/engine/src/__tests__/runtime-ipc.test.ts` (new)

### Step 4: Child Process Runtime Implementation

- [ ] Create `ChildProcessProjectRuntime` class in `packages/engine/src/child-process-runtime.ts`:
  - Spawns new Node.js process via `child_process.fork()`
  - Entry point: `packages/engine/src/runtime-worker.ts`
  - Uses `IPCChannel` for all communication
- [ ] Implement `initialize()`:
  - Fork child process with project configuration
  - Wait for 'init:result' message
  - Set status to 'ready' on success, 'error' on failure
- [ ] Implement `executeTask(taskId)`:
  - Send 'execute' message to child
  - Wait for 'execute:result'
  - Return result
- [ ] Implement `shutdown()`:
  - Send 'shutdown' message
  - Wait for graceful shutdown (30s timeout)
  - Force kill if needed (SIGTERM → SIGKILL after 5s)
- [ ] Implement health monitoring:
  - Poll health every 5 seconds via 'health:get' message
  - Emit 'health:changed' events on status changes
  - Auto-restart on persistent errors (configurable)
- [ ] Handle child process crashes:
  - Listen for 'exit'/'error' events
  - Attempt restart with exponential backoff (max 3 retries)
  - Set status to 'error' if restart fails
- [ ] Write comprehensive tests with mock child processes:
  - Spawn/initialize flow
  - Task execution via IPC
  - Health monitoring
  - Crash recovery
  - Shutdown cleanup
- [ ] Run targeted tests: `pnpm test packages/engine/src/__tests__/child-process-runtime.test.ts`

**Artifacts:**
- `packages/engine/src/child-process-runtime.ts` (new)
- `packages/engine/src/__tests__/child-process-runtime.test.ts` (new)

### Step 5: Runtime Worker (Child Process Entry Point)

- [ ] Create `packages/engine/src/runtime-worker.ts`:
  - Entry point script for forked child processes
  - Sets up signal handlers (SIGTERM for graceful shutdown)
  - Creates `InProcessProjectRuntime` internally (child acts like in-process)
  - Listens for IPC messages from parent
  - Forwards all runtime events to parent via 'event' messages
  - Forwards logs to parent via 'log' messages
- [ ] Implement message handlers:
  - 'init': Initialize the in-process runtime
  - 'execute': Execute a task, return result
  - 'health:get': Return current health metrics
  - 'shutdown': Graceful shutdown
- [ ] Handle parent disconnect:
  - If parent exits unexpectedly, self-terminate after cleanup
  - Log the condition before exit
- [ ] Test the worker script in isolation:
  - Fork worker in test, send messages, verify responses
  - Test graceful shutdown on parent disconnect
- [ ] Run targeted tests: `pnpm test packages/engine/src/__tests__/runtime-worker.test.ts`

**Artifacts:**
- `packages/engine/src/runtime-worker.ts` (new)
- `packages/engine/src/__tests__/runtime-worker.test.ts` (new)

### Step 6: Hybrid Executor Implementation

- [ ] Create `HybridExecutor` class in `packages/engine/src/hybrid-executor.ts`:
  - Manages all project runtimes (Map<projectId, ProjectRuntime>)
  - Integrates with `CentralCore` from KB-500
  - Listens to `CentralCore` events: 'project:registered', 'project:unregistered', 'project:updated'
- [ ] Implement `initialize()`:
  - Load all registered projects from `CentralCore`
  - Create appropriate runtime for each (based on `isolationMode`)
  - Initialize all 'active' project runtimes
- [ ] Implement project lifecycle management:
  - `addProject(projectId)`: Create and initialize runtime for new project
  - `removeProject(projectId)`: Shutdown and remove runtime
  - `updateProject(projectId)`: Handle isolation mode changes (shutdown old, start new)
- [ ] Implement global task scheduling:
  - Poll all runtimes for 'todo' tasks
  - Respect global concurrency limits from `CentralCore`
  - Prioritize tasks based on project priority and creation time
  - Route task execution to appropriate runtime via `executeTask()`
- [ ] Implement health aggregation:
  - Aggregate health from all runtimes
  - Report to `CentralCore` for global health tracking
  - Detect and handle runtime failures
- [ ] Implement graceful shutdown:
  - Stop accepting new tasks
  - Wait for active tasks to complete (with timeout)
  - Shutdown all runtimes in parallel
- [ ] Write comprehensive tests:
  - Multi-project initialization
  - Runtime mode switching
  - Global concurrency enforcement
  - Health aggregation
  - Graceful shutdown
- [ ] Run targeted tests: `pnpm test packages/engine/src/__tests__/hybrid-executor.test.ts`

**Artifacts:**
- `packages/engine/src/hybrid-executor.ts` (new)
- `packages/engine/src/__tests__/hybrid-executor.test.ts` (new)

### Step 7: Scheduler Refactoring

- [ ] Update `packages/engine/src/scheduler.ts`:
  - Extract project-specific scheduling logic into `ProjectScheduler` class
  - Keep `Scheduler` as a thin wrapper or deprecate in favor of HybridExecutor
  - Ensure backward compatibility with existing tests
- [ ] Make `Scheduler` work with `TaskStore` abstraction (unchanged interface)
- [ ] Ensure single-project mode still works without `HybridExecutor`
- [ ] Run targeted tests: `pnpm test packages/engine/src/scheduler.test.ts`

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified)

### Step 8: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run full engine test suite: `pnpm test packages/engine`
- [ ] Run full core test suite: `pnpm test packages/core`
- [ ] Verify no TypeScript errors: `pnpm build`
- [ ] Integration test: Start HybridExecutor with 2+ test projects
  - One in-process, one child-process
  - Create tasks in both
  - Verify execution completes successfully
  - Verify health monitoring works
- [ ] Check test coverage for new files (aim for >80%)

### Step 9: Documentation & Delivery

- [ ] Add JSDoc comments to all public methods in new files
- [ ] Update `AGENTS.md` — Document the runtime architecture:
  - ProjectRuntime interface and its implementations
  - Isolation modes: in-process vs child-process
  - IPC protocol overview
  - How HybridExecutor coordinates multiple projects
- [ ] Export new types from `packages/engine/src/index.ts`:
  - `ProjectRuntime`, `InProcessProjectRuntime`, `ChildProcessProjectRuntime`
  - `HybridExecutor`, `RuntimeHealth`, `RuntimeStatus`
  - `IPCMessage`, `IPCChannel`
- [ ] Create changeset for the feature:
    ```bash
    cat > .changeset/hybrid-executor-runtime.md << 'EOF'
    ---
    "@kb/engine": minor
    ---
    
    Add per-project runtime abstraction and hybrid executor lifecycle
    
    - New ProjectRuntime interface with in-process and child-process implementations
    - IPC protocol for isolated task execution
    - HybridExecutor for managing multi-project task execution
    - Configurable isolation modes per project (in-process vs child-process)
    EOF
    ```
- [ ] Include changeset in commit
- [ ] Out-of-scope findings created as new tasks via `task_create` tool:
  - Dashboard UI for isolation mode selection (belongs in KB-502)
  - CLI commands for project management (belongs in KB-503)

## Documentation Requirements

**Must Update:**
- `packages/engine/src/index.ts` — Export new public API
- `AGENTS.md` — Add section on "Multi-Project Runtime Architecture" describing:
  - `ProjectRuntime` interface purpose
  - `InProcessProjectRuntime` for same-process execution
  - `ChildProcessProjectRuntime` for isolated execution
  - IPC protocol between parent and child processes
  - `HybridExecutor` as the multi-project orchestrator

**Check If Affected:**
- `packages/engine/README.md` — Update if exists
- `packages/engine/package.json` — No changes expected

## Completion Criteria

- [ ] `ProjectRuntime` interface fully defined and documented
- [ ] `InProcessProjectRuntime` implemented and tested
- [ ] `ChildProcessProjectRuntime` implemented and tested
- [ ] IPC protocol implemented with request/response pattern
- [ ] `runtime-worker.ts` child process entry point working
- [ ] `HybridExecutor` managing multiple projects
- [ ] Runtime health monitoring and aggregation working
- [ ] Crash recovery with exponential backoff implemented
- [ ] All tests passing (>80% coverage for new files)
- [ ] Build passes with no TypeScript errors
- [ ] Integration test with 2+ projects passes
- [ ] Documentation updated
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-501): complete Step N — description`
  - Example: `feat(KB-501): complete Step 1 — ProjectRuntime interface definition`
- **Bug fixes:** `fix(KB-501): description`
- **Tests:** `test(KB-501): description`
- **Docs:** `docs(KB-501): description`

## Do NOT

- Modify the single-project execution behavior (should work as before)
- Break existing TaskExecutor API used by single-project mode
- Skip tests for IPC timeout handling (reliability-critical)
- Allow child processes to persist after parent exit (must self-terminate)
- Expose project secrets or credentials over IPC (security)
- Allow circular project references or path traversal in project registration
- Skip graceful shutdown handling (data corruption risk)
- Remove or deprecate existing exports without migration path

## Security Considerations

- Child process spawn: validate `projectPath` exists and is absolute before forking
- IPC message validation: reject malformed/unknown message types
- No credential passing over IPC: credentials stay in parent, child uses scoped tokens
- Child process sandboxing: consider `cwd` restriction to project path only
- Terminate child on parent exit: prevent orphaned processes
- Input validation on all IPC message payloads
- Prevent path traversal in project path resolution

## Performance Considerations

- Child process startup overhead: ~100-300ms, acceptable for long-running tasks
- Reuse child processes across multiple tasks (don't spawn per-task)
- Monitor memory usage per runtime, enforce limits if configured
- Global concurrency limits prevent resource exhaustion across projects
- IPC overhead minimal for task-level operations (not file I/O level)
