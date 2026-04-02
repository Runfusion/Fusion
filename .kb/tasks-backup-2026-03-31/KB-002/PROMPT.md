# Task: KB-002 - Per-Project Runtime Abstraction and Hybrid Executor Lifecycle

**Created:** 2026-03-31
**Size:** L

## Review Level: 3 (Full)

**Assessment:** This task introduces foundational architectural abstractions for multi-project execution with hybrid isolation modes. Changes affect how the engine instantiates schedulers and executors, introduces process isolation, and establishes the bridge between KB-001's central infrastructure and per-project execution. Full review required for runtime lifecycle safety, IPC protocol design, and backward compatibility with existing single-project behavior.

**Score:** 6/8 — Blast radius: 2, Pattern novelty: 2, Security: 1, Reversibility: 1

## Mission

Create a per-project runtime abstraction that enables kb to manage multiple projects with different execution isolation modes. Build a `ProjectRuntime` system that supports both "in-process" execution (shared memory, single Node.js process) and "child-process" execution (subprocess isolation, IPC communication) as defined by each project's configuration.

This task works in tandem with KB-001: KB-001 establishes the central registry and types, while this task creates the engine-side execution layer that consumes those types. The abstraction cleanly separates project-specific execution state (TaskStore, Scheduler, Executor instances) from global coordination.

Key deliverables:
- **ProjectRuntime interface/abstraction**: Unified interface for project execution regardless of isolation mode
- **InProcessRuntime**: Current behavior — project runs in same Node.js process with shared memory
- **ChildProcessRuntime**: New capability — project runs in isolated subprocess with IPC communication  
- **ProjectRuntimeManager**: Manages runtime lifecycle for multiple projects
- **IPC protocol**: Parent-child communication for subprocess isolation
- **Engine integration**: Refactor engine entry to support multi-project coordination

## Dependencies

- **Task:** KB-001 — Project types (`Project`, `ProjectIsolationMode`, `ProjectStatus`, `ProjectCreateInput`) must be exported from `@kb/core`. The central database infrastructure should exist but the full CentralCoreStore API can be partially mocked if needed for development.

## Context to Read First

1. `/packages/core/src/types.ts` — Verify `Project` and `ProjectIsolationMode` types exist (from KB-001)
2. `/packages/core/src/index.ts` — Verify types are exported from `@kb/core`
3. `/packages/engine/src/scheduler.ts` — Scheduler already takes TaskStore in constructor; review current event handling
4. `/packages/engine/src/executor.ts` — TaskExecutor already takes TaskStore in constructor; review lifecycle
5. `/packages/engine/src/concurrency.ts` — AgentSemaphore for global concurrency sharing
6. `/packages/engine/src/index.ts` — Current engine exports

## File Scope

### New Files
- `packages/engine/src/project-runtime.ts` — ProjectRuntime interface and types
- `packages/engine/src/in-process-runtime.ts` — InProcessRuntime implementation
- `packages/engine/src/child-process-runtime.ts` — ChildProcessRuntime implementation (parent side)
- `packages/engine/src/child-process-main.ts` — Child subprocess entry point
- `packages/engine/src/runtime-manager.ts` — ProjectRuntimeManager for coordinating multiple projects
- `packages/engine/src/runtime-ipc.ts` — IPC protocol types and helpers
- `packages/engine/src/runtime.test.ts` — Tests for InProcessRuntime and RuntimeManager
- `packages/engine/src/runtime-child.test.ts` — Tests for ChildProcessRuntime and IPC

### Modified Files
- `packages/engine/src/index.ts` — Export new runtime classes and types
- `packages/engine/src/scheduler.ts` — Add optional `projectId` for logging context
- `packages/engine/src/executor.ts` — Add optional `projectId` for logging context

## Steps

### Step 0: Preflight

- [ ] Read all Context files listed above
- [ ] **Verify KB-001 types exist**: Check that `Project`, `ProjectIsolationMode`, `ProjectStatus`, `ProjectCreateInput` are exported from `@kb/core`:
  ```bash
  grep -q "export.*ProjectIsolationMode" packages/core/src/types.ts && \
  grep -q "export.*ProjectCreateInput" packages/core/src/types.ts && \
  grep -q "export.*ProjectStatus" packages/core/src/types.ts && \
  echo "KB-001 types verified" || echo "ERROR: KB-001 types not found - dependency not satisfied"
  ```
- [ ] Verify existing tests pass: `pnpm test`
- [ ] Verify build passes: `pnpm build`

**If KB-001 types are missing:** Define minimal inline types in Step 1 (mark with `// KB-001: migrate to @kb/core when available`)

### Step 1: ProjectRuntime Interface and Types

Define the abstraction that all runtime implementations must satisfy.

- [ ] Create `packages/engine/src/project-runtime.ts`:
  ```typescript
  // If KB-001 types not available, define inline (temporary):
  export type ProjectIsolationMode = "in-process" | "child-process";
  export type ProjectStatus = "active" | "paused" | "errored" | "disabled";
  
  export interface Project {
    id: string;
    name: string;
    path: string;
    enabled: boolean;
    isolationMode: ProjectIsolationMode;
    status: ProjectStatus;
    maxConcurrent?: number;
    metadata?: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  }
  
  export interface ProjectCreateInput {
    name: string;
    path: string;
    enabled?: boolean;
    isolationMode?: ProjectIsolationMode;
    maxConcurrent?: number;
    metadata?: Record<string, unknown>;
  }
  
  export interface ProjectContext {
    projectId: string;
    projectPath: string;
    isolationMode: ProjectIsolationMode;
  }

  export type RuntimeState = 
    | "initializing" 
    | "idle" 
    | "running" 
    | "pausing" 
    | "paused" 
    | "stopping" 
    | "stopped" 
    | "error";

  export interface RuntimeStatus {
    state: RuntimeState;
    activeTasks: number;
    queuedTasks: number;
    lastError?: string;
    startedAt?: string;
  }

  export interface ProjectRuntimeEvents {
    "state:changed": [{ from: RuntimeState; to: RuntimeState; projectId: string }];
    "task:started": [taskId: string, projectId: string];
    "task:completed": [taskId: string, projectId: string];
    "task:failed": [taskId: string, projectId: string, error: string];
    "error": [error: Error, projectId: string];
  }
  
  export interface ProjectRuntime {
    readonly projectId: string;
    readonly state: RuntimeState;
    
    /** Initialize the runtime (create TaskStore, load settings, etc.) */
    init(): Promise<void>;
    
    /** Start the runtime's scheduler and executor */
    start(): Promise<void>;
    
    /** Stop the runtime gracefully (finish in-flight, no new work) */
    stop(): Promise<void>;
    
    /** Terminate immediately (kill active agents) */
    terminate(): Promise<void>;
    
    /** Pause all activity for this project */
    pause(): Promise<void>;
    
    /** Resume activity for this project */
    resume(): Promise<void>;
    
    /** Get the TaskStore for this project */
    getStore(): Promise<TaskStore>;
    
    /** Execute a specific task */
    executeTask(taskId: string): Promise<void>;
    
    /** Get current status summary */
    getStatus(): Promise<RuntimeStatus>;
  }
  ```

- [ ] Import `TaskStore` from `@kb/core` at the top of the file
- [ ] Add clear comments marking inline types for migration to @kb/core when KB-001 is complete

**Artifacts:**
- `packages/engine/src/project-runtime.ts` (new)

### Step 2: InProcessRuntime Implementation

Create the in-process runtime that encapsulates current behavior.

- [ ] Create `packages/engine/src/in-process-runtime.ts` with `InProcessRuntime` class:
  - Extends `EventEmitter<ProjectRuntimeEvents>`
  - Constructor signature:
    ```typescript
    interface InProcessRuntimeOptions {
      semaphore?: AgentSemaphore;
      maxConcurrent?: number;
      maxWorktrees?: number;
      pollIntervalMs?: number;
    }
    
    constructor(project: Project, options?: InProcessRuntimeOptions)
    ```
  
  - Private properties:
    - `private store: TaskStore | null = null`
    - `private scheduler: Scheduler | null = null`
    - `private executor: TaskExecutor | null = null`
    - `private _state: RuntimeState = "initializing"`
    - `private projectId: string` (from project.id)

- [ ] Implement `init()`:
  - Create TaskStore: `this.store = new TaskStore(this.project.path)`
  - Call `await this.store.init()`
  - Set state to `idle`
  - Emit `state:changed` event

- [ ] Implement `start()`:
  - Transition state: `idle` → `running`
  - Create Scheduler with this.store and options
  - Create TaskExecutor with this.store and options
  - Wire up event forwarding (store events → runtime events)
  - Call `this.scheduler.start()`
  - Call `this.executor.resumeOrphaned()`

- [ ] Implement `stop()`:
  - Transition state: `running` → `stopping` → `stopped`
  - Stop scheduler (let it finish current tasks)
  - Stop executor gracefully

- [ ] Implement `terminate()`:
  - Transition state directly to `stopped`
  - Terminate executor sessions immediately
  - Stop scheduler immediately

- [ ] Implement `pause()`:
  - Update store settings: `globalPause = true`
  - State: `running` → `pausing` → `paused`

- [ ] Implement `resume()`:
  - Update store settings: `globalPause = false`
  - State: `paused` → `running`

- [ ] Implement `getStore()`:
  - Return `Promise.resolve(this.store)` (async for interface consistency)
  - Throw if called before init()

- [ ] Implement `executeTask(taskId: string)`:
  - Get task from store
  - Move to "in-progress" via store.moveTask
  - Executor will pick it up automatically via event

- [ ] Implement `getStatus()`:
  - Query store for task counts (in-progress, todo)
  - Return RuntimeStatus object

- [ ] State transition method for consistency:
  ```typescript
  private setState(newState: RuntimeState): void {
    const oldState = this._state;
    this._state = newState;
    this.emit("state:changed", { from: oldState, to: newState, projectId: this.projectId });
  }
  ```

- [ ] Write tests in `packages/engine/src/runtime.test.ts`:
  - `InProcessRuntime` init creates store and initializes it
  - `InProcessRuntime` start creates scheduler and executor
  - State transitions emit events
  - Pause/resume update store settings
  - Stop transitions through states correctly
  - GetStore returns working TaskStore
  - GetStatus returns correct counts

**Artifacts:**
- `packages/engine/src/in-process-runtime.ts` (new)
- `packages/engine/src/runtime.test.ts` (new, InProcessRuntime tests)

### Step 3: IPC Protocol for Child-Process Runtime

Define the communication protocol between parent and child processes.

- [ ] Create `packages/engine/src/runtime-ipc.ts`:
  ```typescript
  // Request messages (parent → child)
  export type ParentMessage =
    | { type: "init"; projectId: string; projectPath: string }
    | { type: "start" }
    | { type: "stop" }
    | { type: "terminate" }
    | { type: "pause" }
    | { type: "resume" }
    | { type: "executeTask"; taskId: string }
    | { type: "getStatus" }
    | { type: "storeCall"; callId: string; method: string; args: unknown[] };

  // Response/notification messages (child → parent)
  export type ChildMessage =
    | { type: "initialized" }
    | { type: "started" }
    | { type: "stopped" }
    | { type: "stateChanged"; from: RuntimeState; to: RuntimeState }
    | { type: "taskStarted"; taskId: string }
    | { type: "taskCompleted"; taskId: string }
    | { type: "taskFailed"; taskId: string; error: string }
    | { type: "statusResult"; callId: string; status: RuntimeStatus }
    | { type: "storeResult"; callId: string; result: unknown; error?: string }
    | { type: "error"; message: string; stack?: string };
  ```

- [ ] Add IPC utilities:
  ```typescript
  export class IpcMessenger {
    constructor(
      private sendFn: (msg: ParentMessage | ChildMessage) => void,
      private onMessageFn: (handler: (msg: ParentMessage | ChildMessage) => void) => void
    ) {}
    
    // Promise-based request/response with timeout
    request<T>(message: Omit<ParentMessage, "callId">, timeoutMs?: number): Promise<T>
    
    // Send notification (no response expected)
    notify(message: Omit<ParentMessage, "callId">): void
    
    // Set up message handler
    onRequest(handler: (msg: ParentMessage) => Promise<ChildMessage>): void
  }
  ```

**Artifacts:**
- `packages/engine/src/runtime-ipc.ts` (new)

### Step 4: ChildProcessRuntime Implementation

Create the child-process runtime for true isolation.

- [ ] Create `packages/engine/src/child-process-main.ts` — subprocess entry point:
  ```typescript
  #!/usr/bin/env node
  import { InProcessRuntime } from "./in-process-runtime.js";
  import { IpcMessenger } from "./runtime-ipc.js";
  
  // This file runs inside the forked child process
  // It receives IPC messages from the parent and manages an InProcessRuntime
  
  async function main() {
    const messenger = new IpcMessenger(
      (msg) => process.send?.(msg),
      (handler) => process.on("message", handler)
    );
    
    let runtime: InProcessRuntime | null = null;
    
    messenger.onRequest(async (msg) => {
      switch (msg.type) {
        case "init":
          const project = { id: msg.projectId, path: msg.projectPath } as Project;
          runtime = new InProcessRuntime(project);
          await runtime.init();
          return { type: "initialized" };
          
        case "start":
          await runtime?.start();
          return { type: "started" };
          
        // ... handle all ParentMessage types
      }
    });
  }
  
  main();
  ```

- [ ] Create `packages/engine/src/child-process-runtime.ts` with two exports:
  - `ChildProcessRuntime` — parent-side runtime implementation
  - Helper functions for process management

- [ ] `ChildProcessRuntime` class:
  - Implements `ProjectRuntime` interface
  - Constructor: `constructor(project: Project, options?: ChildProcessRuntimeOptions)`
  - Private properties:
    - `private child: ChildProcess | null = null`
    - `private messenger: IpcMessenger | null = null`
    - `private pendingRequests = new Map<string, Deferred<unknown>>()`
    - `private _state: RuntimeState = "initializing"`

- [ ] Implement subprocess lifecycle:
  ```typescript
  private async spawn(): Promise<void> {
    // Fork this same module but execute child-process-main.ts
    const childPath = new URL("./child-process-main.js", import.meta.url).pathname;
    this.child = fork(childPath, [], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, KB_PROJECT_ID: this.project.id },
    });
    
    // Set up IPC messenger
    this.messenger = new IpcMessenger(
      (msg) => this.child?.send?.(msg),
      (handler) => this.child?.on("message", handler)
    );
    
    // Handle subprocess exit
    this.child.on("exit", (code) => this.handleChildExit(code));
    this.child.on("error", (err) => this.handleChildError(err));
  }
  ```

- [ ] Implement ProjectRuntime methods via IPC:
  - `init()`: Spawn child, send "init" message, wait for "initialized"
  - `start()`: Send "start", wait for "started"
  - `stop()`: Send "stop", wait for "stopped", disconnect
  - `terminate()`: Send "terminate", then `child.kill()` if needed
  - `pause()`, `resume()`: Send corresponding messages
  - `getStore()`: Returns a Proxy that serializes store calls over IPC
  - `executeTask()`: Send "executeTask", don't wait for response
  - `getStatus()`: Send "getStatus", return statusResult

- [ ] Handle store proxy:
  ```typescript
  // In getStore()
  return new Proxy({} as TaskStore, {
    get: (target, prop) => {
      if (typeof prop !== "string") return target[prop as keyof TaskStore];
      return (...args: unknown[]) => {
        const callId = generateId();
        this.messenger?.request({ type: "storeCall", callId, method: prop, args });
        // Return promise that resolves when storeResult received
      };
    },
  });
  ```

- [ ] Implement crash recovery:
  - On unexpected child exit: Log error, transition to "error" state
  - Optional: Auto-restart with exponential backoff (configurable)

- [ ] Write tests in `packages/engine/src/runtime-child.test.ts`:
  - ChildProcessRuntime spawns subprocess and initializes
  - Lifecycle commands work via IPC
  - Store proxy calls execute remotely
  - Subprocess crash detection
  - Graceful shutdown sequence

**Artifacts:**
- `packages/engine/src/child-process-main.ts` (new)
- `packages/engine/src/child-process-runtime.ts` (new)
- `packages/engine/src/runtime-child.test.ts` (new)

### Step 5: ProjectRuntimeManager

Create the coordinator that manages all project runtimes.

- [ ] Create `packages/engine/src/runtime-manager.ts` with `ProjectRuntimeManager` class:
  - Extends `EventEmitter` for cross-runtime events
  - Constructor: `constructor(options?: RuntimeManagerOptions)`
  - Properties:
    - `private runtimes = new Map<string, ProjectRuntime>()`
    - `private globalSemaphore: AgentSemaphore`
    - `private projects: Map<string, Project>` (in-memory registry until KB-001 integration)

- [ ] Key methods:
  - `async addProject(project: Project): Promise<void>` — Create runtime based on isolationMode
  - `async removeProject(projectId: string): Promise<boolean>` — Stop runtime and remove
  - `getRuntime(projectId: string): ProjectRuntime | undefined`
  - `listRuntimes(): ProjectRuntime[]`
  - `async startAll(): Promise<void>` — Start all enabled projects
  - `async stopAll(): Promise<void>` — Gracefully stop all runtimes

- [ ] Runtime factory:
  ```typescript
  private createRuntime(project: Project): ProjectRuntime {
    if (project.isolationMode === "child-process") {
      return new ChildProcessRuntime(project, { semaphore: this.globalSemaphore });
    }
    return new InProcessRuntime(project, { semaphore: this.globalSemaphore });
  }
  ```

- [ ] Cross-runtime event forwarding:
  - Forward runtime events with project context to manager listeners
  - Enable unified monitoring across all projects

- [ ] Write tests in `packages/engine/src/runtime.test.ts`:
  - AddProject creates runtime of correct type
  - Global semaphore shared across runtimes
  - RemoveProject stops and removes runtime
  - Event forwarding works correctly

**Artifacts:**
- `packages/engine/src/runtime-manager.ts` (new)
- Tests added to `packages/engine/src/runtime.test.ts`

### Step 6: Scheduler and Executor Minor Refinements

Add optional project context for multi-project logging.

- [ ] Modify `packages/engine/src/scheduler.ts`:
  - Add optional `projectId?: string` to `SchedulerOptions`
  - Add `private projectId?: string` property
  - Update log messages to include project context when available:
    ```typescript
    const prefix = this.projectId ? `[${this.projectId}] ` : "";
    schedulerLog.log(`${prefix}Started (poll interval: ${interval}ms)`);
    ```

- [ ] Modify `packages/engine/src/executor.ts`:
  - Add optional `projectId?: string` to `TaskExecutorOptions`
  - Add `private projectId?: string` property
  - Update log messages to include project context

**Note:** Both Scheduler and TaskExecutor already receive TaskStore in their constructors, so they are already decoupled from global state. This step just adds logging context.

**Artifacts:**
- `packages/engine/src/scheduler.ts` (modified — optional projectId)
- `packages/engine/src/executor.ts` (modified — optional projectId)

### Step 7: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run new runtime tests:
  ```bash
  pnpm --filter @kb/engine test -- runtime.test.ts
  pnpm --filter @kb/engine test -- runtime-child.test.ts
  ```
- [ ] Run all existing engine tests:
  ```bash
  pnpm --filter @kb/engine test
  ```
- [ ] Run full test suite:
  ```bash
  pnpm test
  ```
- [ ] Verify build:
  ```bash
  pnpm build
  ```
- [ ] Manual integration verification:
  ```typescript
  // Test script: packages/engine/test-manual/runtime-integration.ts
  import { ProjectRuntimeManager, InProcessRuntime } from "../src/index.js";
  import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  
  async function test() {
    const tmpDir = mkdtempSync(join(tmpdir(), "kb-test-"));
    mkdirSync(join(tmpDir, ".fusion", "tasks"), { recursive: true });
    writeFileSync(join(tmpDir, ".fusion", "config.json"), JSON.stringify({ nextId: 1 }));
    
    const manager = new ProjectRuntimeManager();
    
    const project = {
      id: "proj-001",
      name: "Test Project",
      path: tmpDir,
      enabled: true,
      isolationMode: "in-process" as const,
      status: "active" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    
    await manager.addProject(project);
    
    const runtime = manager.getRuntime("proj-001");
    if (!runtime || !(runtime instanceof InProcessRuntime)) {
      throw new Error("Expected InProcessRuntime");
    }
    
    await runtime.init();
    const status = await runtime.getStatus();
    console.log("Status after init:", status);
    
    await runtime.start();
    const runningStatus = await runtime.getStatus();
    console.log("Status after start:", runningStatus);
    console.assert(runningStatus.state === "running");
    
    await runtime.stop();
    await manager.removeProject("proj-001");
    console.log("✅ Runtime integration test passed");
  }
  
  test().catch(console.error);
  ```

**Artifacts:**
- All tests passing
- Build clean

### Step 8: Documentation & Delivery

- [ ] Update `packages/engine/src/index.ts` exports:
  ```typescript
  // Runtime abstractions
  export type { 
    ProjectRuntime, 
    ProjectContext, 
    RuntimeState, 
    RuntimeStatus,
    ProjectRuntimeEvents,
    Project,
    ProjectIsolationMode,
    ProjectStatus,
    ProjectCreateInput
  } from "./project-runtime.js";
  export { InProcessRuntime, type InProcessRuntimeOptions } from "./in-process-runtime.js";
  export { ChildProcessRuntime, type ChildProcessRuntimeOptions } from "./child-process-runtime.js";
  export { ProjectRuntimeManager, type RuntimeManagerOptions } from "./runtime-manager.js";
  export { 
    type ParentMessage, 
    type ChildMessage, 
    IpcMessenger 
  } from "./runtime-ipc.js";
  ```

- [ ] Create changeset:
  ```bash
  cat > .changeset/runtime-abstraction-multi-project.md << 'EOF'
  ---
  "@dustinbyrne/kb": minor
  ---

  Add per-project runtime abstraction with hybrid executor lifecycle. New `ProjectRuntime` interface enables kb to execute tasks across multiple projects with configurable isolation modes. Includes `InProcessRuntime` for shared-memory execution and `ChildProcessRuntime` for subprocess isolation with IPC communication. The `ProjectRuntimeManager` coordinates multiple project runtimes with a shared concurrency semaphore.
  EOF
  ```

- [ ] Document in engine README:
  - Add "Multi-Project Runtime" section
  - Explain ProjectRuntime interface and lifecycle
  - Document InProcessRuntime vs ChildProcessRuntime tradeoffs
  - Provide ProjectRuntimeManager usage example

- [ ] If types were defined inline (KB-001 not complete), add comment:
  ```typescript
  // NOTE: Inline Project types defined in KB-002. 
  // When KB-001 completes, migrate these to @kb/core and import from there.
  ```

**Artifacts:**
- `packages/engine/src/index.ts` (modified)
- `packages/engine/README.md` (modified)
- `.changeset/runtime-abstraction-multi-project.md` (new)

## Documentation Requirements

**Must Update:**
- `packages/engine/src/index.ts` — Export all new runtime classes and types
- `packages/engine/README.md` — Add "Multi-Project Runtime" section with:
  - ProjectRuntime interface explanation
  - In-process vs child-process isolation comparison
  - ProjectRuntimeManager usage example
  - IPC protocol overview (for contributors)

**Check If Affected:**
- `AGENTS.md` — May need multi-project architecture section reference
- `packages/core/README.md` — If KB-001 types exist, cross-reference them

## Completion Criteria

- [ ] All steps complete (0-8)
- [ ] All tests passing (new + existing)
- [ ] Build passes with no TypeScript errors
- [ ] `ProjectRuntime` interface fully defined in `project-runtime.ts`
- [ ] `InProcessRuntime` implements full interface, passes all tests
- [ ] `ChildProcessRuntime` implements full interface with IPC, passes all tests
- [ ] `ProjectRuntimeManager` coordinates multiple runtimes with shared AgentSemaphore
- [ ] Scheduler and Executor updated with optional projectId logging context
- [ ] Documentation updated with runtime usage examples
- [ ] Changeset created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-002): complete Step N — description`
- **Bug fixes:** `fix(KB-002): description`
- **Tests:** `test(KB-002): description`
- **Docs:** `docs(KB-002): description`

Example commits:
```
feat(KB-002): complete Step 1 — define ProjectRuntime interface and types
feat(KB-002): complete Step 2 — implement InProcessRuntime with full lifecycle
test(KB-002): add InProcessRuntime and RuntimeManager tests
feat(KB-002): implement ChildProcessRuntime with IPC protocol
feat(KB-002): add ProjectRuntimeManager for multi-project coordination
docs(KB-002): document runtime abstraction and isolation modes
```

## Do NOT

- **Do NOT** change the existing single-project behavior when manager is not used — maintain backward compatibility
- **Do NOT** break existing TaskStore, Scheduler, or TaskExecutor APIs — only additive changes (optional projectId)
- **Do NOT** implement dashboard UI or CLI commands — that's KB-003 and KB-004
- **Do NOT** implement automatic project discovery or CentralCoreStore integration — that's future work after KB-001
- **Do NOT** skip child-process tests — IPC and process lifecycle are critical
- **Do NOT** use synchronous process spawning — always async `fork()`
- **Do NOT** allow a crashed child process to hang the manager — implement proper cleanup with timeouts
- **Do NOT** commit without running the full test suite including child-process tests
- **Do NOT** duplicate KB-001 types if they already exist — import from `@kb/core` if available
