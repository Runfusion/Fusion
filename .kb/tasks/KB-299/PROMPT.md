# Task: KB-299 - Add Server-Side SSE Events for Agent Lifecycle

**Created:** 2026-03-31
**Size:** S

## Review Level: 0 (None)

**Assessment:** Straightforward extension of existing SSE infrastructure to emit AgentStore events. Follows established patterns from task:* events, minimal blast radius on dashboard server only.
**Score:** 1/8 — Blast radius: 0, Pattern novelty: 0, Security: 0, Reversibility: 1

## Mission

Extend the dashboard's SSE endpoint (`/api/events`) to emit agent lifecycle events from AgentStore. The frontend hooks (`useAgents`, `useAgentDetail`) created in KB-291 already listen for `agent:created`, `agent:updated`, `agent:deleted`, and `agent:heartbeat` events, but the server currently only emits `task:*` events. This task wires up the server-side event emission.

Key changes required:
1. Create a shared `AgentStore` instance in the server (currently routes create per-request instances)
2. Extend `createSSE()` to accept and listen to `AgentStore` events
3. Emit agent events to SSE clients in the same format as task events
4. Update `createApiRoutes()` to use the shared `AgentStore` instance

## Dependencies

- **Task:** KB-291 — Refinement: Agent Dashboard UI (frontend hooks must exist to consume these events)

## Context to Read First

**Existing SSE Implementation:**
- `packages/dashboard/src/sse.ts` — Current SSE handler, only listens to TaskStore

**AgentStore Events:**
- `packages/core/src/agent-store.ts` — AgentStore emits: `agent:created`, `agent:updated`, `agent:deleted`, `agent:heartbeat`, `agent:stateChanged`

**Server Setup:**
- `packages/dashboard/src/server.ts` — Where `createSSE(store)` is called and routes are wired

**Route Handler Pattern:**
- `packages/dashboard/src/routes.ts` — Currently creates per-request AgentStore instances (lines with `const agentStore = new AgentStore(...)`)

## File Scope

**Modified Files:**
- `packages/dashboard/src/sse.ts` — Extend to listen to AgentStore events
- `packages/dashboard/src/server.ts` — Create shared AgentStore, pass to createSSE and routes
- `packages/dashboard/src/routes.ts` — Accept and use shared AgentStore instead of creating per-request instances

## Steps

### Step 1: Update Server to Create Shared AgentStore

- [ ] In `packages/dashboard/src/server.ts`, import `AgentStore` from `@kb/core`
- [ ] Create shared `AgentStore` instance in `createServer()` using `store.getRootDir()`
- [ ] Initialize the store with `await agentStore.init()`
- [ ] Update `ServerOptions` interface to include optional `agentStore?: AgentStore` parameter
- [ ] Use passed `options.agentStore` if provided, otherwise create new instance

**Code pattern:**
```typescript
const { AgentStore } = await import("@kb/core");
const agentStore = options?.agentStore ?? new AgentStore({ rootDir: store.getRootDir() });
await agentStore.init();
```

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)

### Step 2: Extend createSSE to Support AgentStore

- [ ] Update `createSSE` function signature to accept both stores: `createSSE(store: TaskStore, agentStore?: AgentStore)`
- [ ] Add event listeners for all AgentStore events: `agent:created`, `agent:updated`, `agent:deleted`, `agent:heartbeat`
- [ ] Emit SSE events in same format as task events: `event: agent:created\ndata: {...}\n\n`
- [ ] Clean up listeners in the `req.on("close")` handler
- [ ] Add heartbeat comment handling for agent events (same 30s heartbeat as existing)

**Event payloads to emit:**
- `agent:created` → full Agent object
- `agent:updated` → full Agent object (include `previousState` in payload if available)
- `agent:deleted` → `{ id: agentId }`
- `agent:heartbeat` → `{ agentId, event: AgentHeartbeatEvent }`

**Artifacts:**
- `packages/dashboard/src/sse.ts` (modified)

### Step 3: Update Route Registration to Pass AgentStore

- [ ] Update `createSSE()` call in server.ts to pass the agentStore: `createSSE(store, agentStore)`
- [ ] Update `createApiRoutes()` call to pass the agentStore as a new parameter

**Artifacts:**
- `packages/dashboard/src/server.ts` (modified)

### Step 4: Update createApiRoutes to Accept and Use AgentStore

- [ ] Modify `createApiRoutes()` signature to accept `agentStore?: AgentStore` parameter
- [ ] In each agent route handler (`/agents`, `/agents/:id`, etc.), use the passed `agentStore` instead of creating new instances
- [ ] Remove the inline `new AgentStore({ rootDir: store.getRootDir() })` pattern from all agent routes
- [ ] Keep the `await agentStore.init()` call if the store wasn't pre-initialized, or skip if already initialized

**Routes to update (all use AgentStore):**
- `GET /agents` — list agents
- `POST /agents` — create agent  
- `GET /agents/:id` — get agent detail
- `PATCH /agents/:id` — update agent
- `PATCH /agents/:id/state` — update agent state
- `DELETE /agents/:id` — delete agent

**Artifacts:**
- `packages/dashboard/src/routes.ts` (modified)

### Step 5: Testing & Verification

> ZERO test failures allowed. Full test suite as quality gate.

- [ ] Run `pnpm test` — all tests must pass
- [ ] Run `pnpm build` — all packages must compile
- [ ] Verify SSE endpoint connects without errors: `curl http://localhost:3000/api/events`
- [ ] Create an agent via API and verify `agent:created` event is received
- [ ] Update an agent state and verify `agent:updated` event is received
- [ ] Record a heartbeat and verify `agent:heartbeat` event is received
- [ ] Delete an agent and verify `agent:deleted` event is received
- [ ] Verify existing `task:*` events still work correctly
- [ ] Verify multiple SSE clients receive events independently

### Step 6: Documentation & Delivery

- [ ] Create changeset file:
```bash
cat > .changeset/agent-sse-events.md << 'EOF'
---
"@dustinbyrne/kb": patch
---

Add server-side SSE events for agent lifecycle (agent:created, agent:updated, agent:deleted, agent:heartbeat).
EOF
```

## Implementation Details

### AgentStore Event Reference

From `packages/core/src/agent-store.ts`:

```typescript
export interface AgentStoreEvents {
  "agent:created": (agent: Agent) => void;
  "agent:updated": (agent: Agent, previousState?: AgentState) => void;
  "agent:deleted": (agentId: string) => void;
  "agent:heartbeat": (agentId: string, event: AgentHeartbeatEvent) => void;
  "agent:stateChanged": (agentId: string, from: AgentState, to: AgentState) => void;
}
```

### SSE Event Format

Follow the exact pattern from existing task events:

```typescript
// In sse.ts, add inside createSSE return function:

const onAgentCreated = (agent: Agent) => {
  res.write(`event: agent:created\ndata: ${JSON.stringify(agent)}\n\n`);
};

const onAgentUpdated = (agent: Agent, previousState?: AgentState) => {
  const payload = previousState ? { ...agent, previousState } : agent;
  res.write(`event: agent:updated\ndata: ${JSON.stringify(payload)}\n\n`);
};

const onAgentDeleted = (agentId: string) => {
  res.write(`event: agent:deleted\ndata: ${JSON.stringify({ id: agentId })}\n\n`);
};

const onAgentHeartbeat = (agentId: string, event: AgentHeartbeatEvent) => {
  res.write(`event: agent:heartbeat\ndata: ${JSON.stringify({ agentId, event })}\n\n`);
};

agentStore.on("agent:created", onAgentCreated);
agentStore.on("agent:updated", onAgentUpdated);
agentStore.on("agent:deleted", onAgentDeleted);
agentStore.on("agent:heartbeat", onAgentHeartbeat);

// Cleanup in req.on("close"):
agentStore.off("agent:created", onAgentCreated);
agentStore.off("agent:updated", onAgentUpdated);
agentStore.off("agent:deleted", onAgentDeleted);
agentStore.off("agent:heartbeat", onAgentHeartbeat);
```

### ServerOptions Update

```typescript
export interface ServerOptions {
  // ... existing options
  /** Optional AgentStore for agent management — if not provided, one is created internally */
  agentStore?: AgentStore;
}
```

### createApiRoutes Signature Update

```typescript
export function createApiRoutes(
  store: TaskStore, 
  options?: ServerOptions,
  agentStore?: AgentStore
): Router {
  // Use provided agentStore or create per-request instances as fallback
}
```

## Completion Criteria

- [ ] All steps complete
- [ ] All tests passing (`pnpm test`)
- [ ] Build passes (`pnpm build`)
- [ ] SSE endpoint emits `agent:created` when agents are created
- [ ] SSE endpoint emits `agent:updated` when agents are updated
- [ ] SSE endpoint emits `agent:deleted` when agents are deleted
- [ ] SSE endpoint emits `agent:heartbeat` when heartbeats are recorded
- [ ] Existing `task:*` events continue to work
- [ ] Changeset file created

## Git Commit Convention

Commits at step boundaries. All commits include the task ID:

- **Step completion:** `feat(KB-299): complete Step N — description`
- **Bug fixes:** `fix(KB-299): description`

Example:
```
feat(KB-299): complete Step 1 — create shared AgentStore in server
feat(KB-299): complete Step 2 — extend createSSE with AgentStore events
feat(KB-299): complete Step 3 — wire AgentStore through to routes
feat(KB-299): complete Step 4 — update routes to use shared AgentStore
feat(KB-299): complete Step 5 — testing and verification
feat(KB-299): complete Step 6 — documentation and changeset
```

## Do NOT

- Change the event payload formats from what AgentStore emits
- Modify AgentStore itself — it already emits the right events
- Add new event types beyond what AgentStore already provides
- Skip updating the route handlers to use the shared store
- Break existing TaskStore SSE functionality
- Add authentication/authorization changes
- Skip tests
