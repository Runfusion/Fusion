# Cross-Node Project and Board Management Design Document

**Task:** FN-1833  
**Date:** 2026-04-14  
**Status:** Design Document

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [How the Dashboard Connects to Nodes](#3-how-the-dashboard-connects-to-nodes)
4. [How Projects Tie Into Nodes](#4-how-projects-tie-into-nodes)
5. [How the Board Works Across Nodes](#5-how-the-board-works-across-nodes)
6. [Task Dependency Chain](#6-task-dependency-chain)
7. [Answers to Key Questions](#7-answers-to-key-questions)
8. [Design Recommendations](#8-design-recommendations)
9. [Gap Analysis](#9-gap-analysis)
10. [Verification Checklist](#10-verification-checklist)

---

## 1. Executive Summary

This document describes the cross-node project and board management architecture in Fusion. The system enables a single dashboard instance to connect to and manage projects across multiple Fusion nodes (local or remote). The architecture uses a **proxy-based model** where the local dashboard server forwards API requests to remote nodes.

**Current State:**
- The frontend proxy infrastructure exists (`proxyApi()` in `packages/dashboard/app/api.ts`, `useRemoteNodeData()` hook)
- Node registration and connection testing exists (`CentralCore.connectToRemoteNode()`)
- Project-to-node assignment exists (`CentralCore.assignProjectToNode()`)
- **Critical Gap:** No backend proxy routes exist — the Express server has no `/api/proxy/:nodeId/*` handlers

**The path forward** is to implement the backend proxy routes (FN-1802/FN-1806), wire up project-node assignment through registration (FN-1803), and complete the remaining integration work.

---

## 2. Architecture Overview

### 2.1 Three-Tier Model

```
┌──────────────────────────────────────────────────────────────────────┐
│                        Browser Dashboard                                │
│                                                                       │
│   ┌─────────────────────────────────────────────────────────────────┐ │
│   │  NodeContext (useNodeContext)                                    │ │
│   │  - currentNode: NodeConfig | null                               │ │
│   │  - isRemote: currentNode !== null                               │ │
│   └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│   ┌────────────────────┐       ┌────────────────────┐                 │
│   │   App.tsx          │       │   App.tsx          │                 │
│   │   (Local Mode)     │       │   (Remote Mode)    │                 │
│   │                    │       │                    │                 │
│   │   useTasks() ──────┼───────┼─ useRemoteNodeData│                 │
│   │   useProjects()    │       │   .projects        │                 │
│   │   EventSource()    │       │   .tasks           │                 │
│   └────────────────────┘       │                    │                 │
│                                 │   EventSource()    │                 │
│                                 │   /api/events      │                 │
│                                 └────────────────────┘                 │
└───────────────────────────────────────────────────────────────────────┘
                                     │
                    ┌────────────────┴────────────────┐
                    │                                 │
         Local API Requests              Proxy API Requests
                    │                                 │
                    ▼                                 ▼
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│     Local Dashboard Server          │    │     Local Dashboard Server          │
│                                    │    │                                    │
│  /api/tasks  ─────────────────────│    │  /api/proxy/:nodeId/*  ────────────│
│  /api/projects                      │    │                                    │
│  /api/events                        │    │  (Forward to remote node)          │
│  (TaskStore)                       │    │                                    │
│                                    │    │  /api/proxy/:nodeId/health         │
│                                    │    │  /api/proxy/:nodeId/projects       │
│                                    │    │  /api/proxy/:nodeId/tasks          │
│                                    │    │  /api/proxy/:nodeId/events        │
│                                    │    │  /api/proxy/:nodeId/project-health │
│                                    │    │                                    │
└────────────────────────────────────┘    └────────────────────────────────────┘
                                                         │
                                                         │ HTTP Request
                                                         │ (with optional
                                                         │  Authorization header)
                                                         ▼
                                        ┌────────────────────────────────────┐
                                        │      Remote Fusion Node             │
                                        │      (fn serve --host <host>)      │
                                        │                                     │
                                        │  /api/health                        │
                                        │  /api/projects                      │
                                        │  /api/tasks                         │
                                        │  /api/events                        │
                                        │  (TaskStore)                        │
                                        │                                     │
                                        └────────────────────────────────────┘
```

### 2.2 Key Components

| Component | File | Purpose |
|-----------|------|---------|
| `NodeContext` | `packages/dashboard/app/context/NodeContext.tsx` | Tracks current node in React context |
| `proxyApi()` | `packages/dashboard/app/api.ts` (line 2176) | Rewrites URLs to `/api/proxy/:nodeId/...` |
| `withNodeId()` | `packages/dashboard/app/api.ts` (line 2162) | URL rewriting helper |
| `useRemoteNodeData()` | `packages/dashboard/app/hooks/useRemoteNodeData.ts` | Fetches remote node data |
| `useRemoteNodeEvents()` | `packages/dashboard/app/hooks/useRemoteNodeEvents.ts` | Subscribes to remote SSE |
| `CentralCore` | `packages/core/src/central-core.ts` | Node registry, project registry |
| `NodeConnection` | `packages/core/src/node-connection.ts` | Remote node connection testing |
| `serve.ts` | `packages/cli/src/commands/serve.ts` | Headless node server |

### 2.3 Data Flow

**Local Mode:**
1. Dashboard → `useTasks()`, `useProjects()`
2. Fetch `GET /api/tasks`, `GET /api/projects`
3. Subscribe `EventSource("/api/events")`
4. TaskStore returns local data

**Remote Mode:**
1. Dashboard → `setCurrentNode(node)` in NodeContext
2. `isRemote = true` in App.tsx
3. Fetch `useRemoteNodeData(nodeId)` → `proxyApi("/tasks", { nodeId })`
4. URL rewritten to `/api/proxy/:nodeId/tasks`
5. Backend forwards to remote node at `node.url`
6. Subscribe `EventSource("/api/proxy/:nodeId/events")`
7. Backend forwards SSE stream from remote node

---

## 3. How the Dashboard Connects to Nodes

### 3.1 Connection Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│                     Node Connection Flow                                  │
└─────────────────────────────────────────────────────────────────────────┘

1. User Registration
   ┌─────────────────┐
   │  NodesView      │
   │  AddNodeModal   │
   └────────┬────────┘
            │ POST /api/nodes
            │ { name, host, port, secure?, apiKey? }
            ▼
2. Connection Test (server-side)
   ┌─────────────────────────────────────────┐
   │  CentralCore.connectToRemoteNode()      │
   │  ├── NodeConnection.test()              │
   │  │   GET {url}/api/health               │
   │  │   Returns { status, version, name } │
   │  └── Validates response                 │
   └────────────────┬────────────────────────┘
                    │ Success
                    ▼
3. Node Registration
   ┌─────────────────────────────────────────┐
   │  CentralCore.registerNode()             │
   │  ├── Store in central DB                │
   │  │   nodes.url = resolved URL           │
   │  │   nodes.apiKey = provided key        │
   │  ├── Set status = "offline"             │
   │  └── Emit "node:registered"             │
   └────────────────┬────────────────────────┘
                    │
                    ▼
4. User Views Node
   ┌─────────────────┐
   │  NodeCard       │
   │  click handler  │
   └────────┬────────┘
            │ setCurrentNode(node)
            ▼
5. Context Switch
   ┌─────────────────────────────────────────┐
   │  NodeContext                            │
   │  ├── currentNode = node                 │
   │  ├── currentNodeId = node.id            │
   │  ├── isRemote = true                    │
   │  └── localStorage.setItem(...)          │
   └────────────────┬────────────────────────┘
                    │
                    ▼
6. App Switches Data Source
   ┌─────────────────────────────────────────┐
   │  App.tsx (lines 71-74)                  │
   │  effectiveProjects = remoteData.projects │
   │  effectiveTasks = remoteData.tasks      │
   └────────────────┬────────────────────────┘
                    │
                    ▼
7. Proxy Requests Begin
   ┌─────────────────────────────────────────┐
   │  proxyApi("/tasks", { nodeId })         │
   │  └── withNodeId("/tasks", nodeId)       │
   │       → "/api/proxy/{nodeId}/tasks"     │
   └────────────────┬────────────────────────┘
                    │
                    ▼
8. [BLOCKED] Backend Forwards
   ┌─────────────────────────────────────────┐
   │  [FN-1802] /api/proxy/:nodeId/*        │
   │  ├── Fetch node.url + path              │
   │  ├── Add Authorization header           │
   │  ├── Forward request                    │
   │  └── Return response                   │
   └─────────────────────────────────────────┘
```

### 3.2 Node Types

| Type | Description | URL | API Key |
|------|-------------|-----|---------|
| `local` | Dashboard's own node | N/A (not accessible remotely) | N/A |
| `remote` | Other Fusion nodes | `http(s)://host:port` | Optional |

### 3.3 Authentication

Remote nodes can be protected with API keys:

```typescript
// In CentralCore.connectToRemoteNode() or node-connection.ts:
const response = await fetch(healthUrl, {
  headers: node.apiKey
    ? { Authorization: `Bearer ${node.apiKey}` }
    : undefined,
});
```

The API key is stored in the central DB (`nodes.apiKey`) and injected on every proxied request.

### 3.4 Health Checking

`CentralCore.checkNodeHealth()` (line 1064) verifies node availability:

```typescript
const healthUrl = new URL("/api/health", node.url).toString();
const response = await fetch(healthUrl, {
  headers: node.apiKey ? { Authorization: `Bearer ${node.apiKey}` } : undefined,
  signal: controller.signal,
});
nextStatus = response.ok ? "online" : "offline";
```

---

## 4. How Projects Tie Into Nodes

### 4.1 Project-Node Assignment Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Project Assignment Rules                              │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│  RegisteredProject  │
│                    │
│  nodeId?: string  │ ───► Points to a node in the registry
│                    │      (null/undefined = unassigned)
└────────┬──────────┘
         │
         │
         ├──► nodeId = "node_abc123" (Remote Node)
         │    ┌─────────────────────────────────────────────┐
         │    │  Project runs on REMOTE node_abc123         │
         │    │                                             │
         │    │  Dashboard shows this project when           │
         │    │  viewing node_abc123                        │
         │    └─────────────────────────────────────────────┘
         │
         ├──► nodeId = "node_local" (Local Node)
         │    ┌─────────────────────────────────────────────┐
         │    │  Project runs on LOCAL node                 │
         │    │                                             │
         │    │  Dashboard shows this project when          │
         │    │  viewing local node                         │
         │    └─────────────────────────────────────────────┘
         │
         └──► nodeId = null | undefined (Unassigned)
              ┌─────────────────────────────────────────────┐
              │  Project runs on LOCAL in-process runtime   │
              │                                             │
              │  NOT shown when viewing remote nodes         │
              └─────────────────────────────────────────────┘
```

### 4.2 Assignment Routing Logic

From `packages/dashboard/app/utils/nodeProjectAssignment.ts`:

```typescript
export function isProjectRoutedToNode(project: ProjectInfo, node: NodeInfo): boolean {
  if (node.type === "remote") {
    // Remote nodes: only explicit assignment counts
    return project.nodeId === node.id;
  }

  // Local nodes: explicit assignment OR unassigned (null/undefined)
  if (project.nodeId === node.id) {
    return true;
  }

  // Unassigned projects run on local in-process runtime
  if (project.nodeId === undefined || project.nodeId === null) {
    return true;
  }

  return false;
}
```

### 4.3 Project Registry API

**Current API:**

| Method | Endpoint | Accepts nodeId? |
|--------|----------|-----------------|
| GET | `/api/projects` | N/A (list all) |
| POST | `/api/projects` | ❌ No |
| PATCH | `/api/projects/:id` | ❌ No |
| POST | `/api/projects/:id/assign-node` | ✅ Yes (dedicated endpoint) |
| DELETE | `/api/projects/:id/node` | ✅ Yes (dedicated endpoint) |

**The Problem:**
- `CentralCore.registerProject()` (line 230) does NOT accept `nodeId` as input
- The `nodeId` column exists in the `projects` table but is not set during registration
- Users must call `assignProjectToNode()` separately after registration

**Routes.ts Line 12715:**
```typescript
const project = await central.registerProject({
  name: name.trim(),
  path: path.trim(),
  isolationMode,
  // nodeId is NOT accepted here
});
```

### 4.4 Node Management API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nodes` | List all nodes |
| POST | `/api/nodes` | Register remote node (calls `connectToRemoteNode`) |
| GET | `/api/nodes/:id` | Get node detail |
| PATCH | `/api/nodes/:id` | Update node config |
| DELETE | `/api/nodes/:id` | Unregister node |
| POST | `/api/nodes/:id/health-check` | Trigger health check |
| GET | `/api/mesh/state` | Get mesh state |

---

## 5. How the Board Works Across Nodes

### 5.1 Data Flow

**Local Mode (App.tsx lines 79-83):**
```typescript
const { tasks, createTask, moveTask, ... } = useTasks(
  currentProject ? { projectId: currentProject.id, searchQuery: searchQuery || undefined } : { searchQuery: searchQuery || undefined }
);
```

**Remote Mode (App.tsx lines 67-72):**
```typescript
const remoteData = useRemoteNodeData(currentNodeId, { 
  projectId: currentProject?.id, 
  searchQuery: searchQuery || undefined 
});
const remoteEvents = useRemoteNodeEvents(currentNodeId);

// Use remote data when in remote mode
const effectiveProjects = isRemote && remoteData.projects.length > 0 ? remoteData.projects : projects;
const effectiveTasks = isRemote && remoteData.tasks.length > 0 ? remoteData.tasks : [];
```

### 5.2 API Functions

From `packages/dashboard/app/api-node.ts`:

```typescript
export async function fetchRemoteNodeHealth(nodeId: string): Promise<RemoteNodeHealth> {
  return proxyApi<RemoteNodeHealth>("/health", { nodeId });
}

export async function fetchRemoteNodeProjects(nodeId: string): Promise<ProjectInfo[]> {
  return proxyApi<ProjectInfo[]>("/projects", { nodeId });
}

export async function fetchRemoteNodeTasks(
  nodeId: string,
  projectId: string,
  searchQuery?: string,
): Promise<Task[]> {
  const params = new URLSearchParams({ projectId });
  if (searchQuery && searchQuery.trim()) {
    params.set("q", searchQuery.trim());
  }
  return proxyApi<Task[]>(`/tasks?${params.toString()}`, { nodeId });
}

export async function fetchRemoteNodeProjectHealth(
  nodeId: string,
  projectId: string,
): Promise<ProjectHealth> {
  return proxyApi<ProjectHealth>(`/project-health?projectId=${encodeURIComponent(projectId)}`, {
    nodeId,
  });
}
```

### 5.3 URL Rewriting

From `packages/dashboard/app/api.ts` (lines 2162-2179):

```typescript
export function withNodeId(path: string, nodeId?: string, localNodeId?: string): string {
  if (!nodeId || nodeId === localNodeId) return path;
  // Rewrite path to proxy endpoint: /tasks -> /proxy/:nodeId/tasks
  const apiPrefix = "/api";
  const pathWithoutPrefix = path.startsWith(apiPrefix) ? path.slice(apiPrefix.length) : path;
  return `/proxy/${encodeURIComponent(nodeId)}${pathWithoutPrefix}`;
}

export function proxyApi<T>(path: string, opts?: RequestInit & { nodeId?: string; localNodeId?: string }): Promise<T> {
  const { nodeId, localNodeId, ...fetchOpts } = opts ?? {};
  const resolvedPath = withNodeId(path, nodeId, localNodeId);
  return api<T>(resolvedPath, fetchOpts);
}
```

**Examples:**
- `proxyApi("/tasks", { nodeId: "node_abc" })` → `/api/proxy/node_abc/tasks`
- `proxyApi("/api/health", { nodeId: "node_xyz" })` → `/api/proxy/node_xyz/health`
- `proxyApi("/tasks", {})` → `/api/tasks` (no rewrite)

### 5.4 SSE Proxy

From `packages/dashboard/app/hooks/useRemoteNodeEvents.ts` (lines 137-142):

```typescript
// Build SSE URL
const encodedNodeId = encodeURIComponent(nodeId);
const esUrl = `/api/proxy/${encodedNodeId}/events`;
const eventSource = new EventSource(esUrl);
```

**Reconnection Logic:**
- 3-second reconnect delay on error
- 45-second heartbeat timeout
- Cleanup on unmount

### 5.5 Parallel Data Fetching

From `packages/dashboard/app/hooks/useRemoteNodeData.ts` (lines 66-79):

```typescript
// Fetch health and projects in parallel
const promises: Promise<unknown>[] = [
  fetchRemoteNodeHealth(nodeId),
  fetchRemoteNodeProjects(nodeId),
];

// Add tasks and project health fetches if projectId is provided
if (projectId) {
  promises.push(fetchRemoteNodeTasks(nodeId, projectId, searchQuery));
  promises.push(fetchRemoteNodeProjectHealth(nodeId, projectId));
}

const results = await Promise.allSettled(promises);
```

---

## 6. Task Dependency Chain

The following tasks must be implemented in dependency order:

### 6.1 Critical Path

| # | Task | Description | Blocked By |
|---|------|-------------|------------|
| 1 | **FN-1802** | Generic proxy route (`/api/proxy/:nodeId/*`) | — |
| 2 | **FN-1806** | Specific proxy routes (health, projects, tasks, events) | FN-1802 |
| 3 | **FN-1803** | Node-aware project registration + directory browsing | FN-1802 |
| 4 | **FN-1804** | Frontend node selector for project creation | FN-1803 |
| 5 | **FN-1805** | Wire peer exchange and discovery in runtimes | FN-1802 |
| 6 | **FN-1736** | Comprehensive project scoping review | FN-1804 |
| 7 | **FN-1733** | Fix project pause/resume to control engines | FN-1803 |
| 8 | **FN-1662** | Fix project health stats for non-first projects | — |

### 6.2 FN-1802: Generic Proxy Route

**Goal:** Implement a catch-all proxy route that forwards any request to a remote node.

**Design:**
```typescript
// packages/dashboard/src/routes.ts
router.all("/proxy/:nodeId/*", async (req, res) => {
  const { nodeId } = req.params;
  const node = await central.getNode(nodeId);
  if (!node || node.type !== "remote") {
    return res.status(404).json({ error: "Node not found" });
  }
  
  // Build target URL
  const targetPath = req.params[0]; // The wildcard part
  const targetUrl = new URL(`/${targetPath}`, node.url);
  
  // Copy query string
  req.url.split("?")[1] && targetUrl.search = req.url.split("?")[1];
  
  // Forward request
  const response = await fetch(targetUrl.toString(), {
    method: req.method,
    headers: {
      ...req.headers,
      ...(node.apiKey && { Authorization: `Bearer ${node.apiKey}` }),
    },
    body: ["POST", "PUT", "PATCH"].includes(req.method) ? req.body : undefined,
  });
  
  // Copy response
  res.status(response.status).json(await response.json());
});
```

### 6.3 FN-1806: Specific Proxy Routes

**Goal:** Implement specific proxy routes with proper typing and handling.

**Routes needed:**
- `GET /api/proxy/:nodeId/health` → Remote `/api/health`
- `GET /api/proxy/:nodeId/projects` → Remote `/api/projects`
- `GET /api/proxy/:nodeId/tasks` → Remote `/api/tasks`
- `GET /api/proxy/:nodeId/events` → Remote SSE `/api/events`
- `GET /api/proxy/:nodeId/project-health` → Remote `/api/project-health`

### 6.4 FN-1803: Node-Aware Project Registration

**Goal:** Accept `nodeId` in `POST /api/projects` and wire `browseDirectory` for remote nodes.

**Changes needed:**
1. `routes.ts` line 12684: Accept `nodeId` in POST body
2. Call `central.registerProject()` with `nodeId`
3. `browse-directory` route: proxy to remote node's filesystem

### 6.5 FN-1804: Frontend Node Selector

**Goal:** Add node picker to project creation UI.

**UI Changes:**
- New Project modal: Add node dropdown
- Show which node a project is assigned to
- Allow changing node assignment

### 6.6 FN-1805: Peer Exchange & Discovery Wiring

**Goal:** Start `PeerExchangeService` and `startDiscovery()` in runtimes.

**Current State:**
- `PeerExchangeService` exists in `packages/engine/src/peer-exchange-service.ts`
- `CentralCore.startDiscovery()` exists (line 1267)
- **Neither is wired in `serve.ts` or dashboard runtime**

**Changes needed:**
1. `InProcessRuntime.start()`: Start `PeerExchangeService`
2. `runServe()`: Call `central.startDiscovery(config)`
3. `runDashboard()`: Call `central.startDiscovery(config)`

---

## 7. Answers to Key Questions

### 7.1 Does the dashboard proxy via the API?

**Yes, partially.**

The **frontend** has complete proxy infrastructure:
- `proxyApi()` rewrites URLs to `/api/proxy/:nodeId/...`
- `useRemoteNodeData()` fetches via proxy
- `useRemoteNodeEvents()` subscribes to proxy SSE

The **backend** is missing the proxy routes:
- `routes.ts` has NO `/proxy/` routes
- Requests to `/api/proxy/:nodeId/*` return 404
- This is the critical gap blocking all remote node viewing

### 7.2 Can the dashboard connect to any node?

**Yes, with the right conditions.**

Any Fusion node that exposes `GET /api/health` with the expected response can be registered:

```json
{
  "status": "ok",
  "version": "1.2.3",
  "uptime": 3600
}
```

**Requirements:**
1. Node must be reachable (network access)
2. Node must respond to `/api/health`
3. Node can be on any host:port combination
4. Optional API key authentication supported

**Connection test flow:**
1. `NodeConnection.test()` hits `/api/health`
2. Validates response has `status` field
3. Returns `{ success, url, nodeInfo }`
4. `CentralCore.connectToRemoteNode()` registers if successful

### 7.3 How does this tie into projects?

**Projects have an optional `nodeId` field.**

**Assignment rules:**
- `nodeId = remote node ID` → Project runs on that remote node
- `nodeId = local node ID` → Project runs on local node
- `nodeId = null/undefined` → Project runs on local in-process runtime

**Dashboard behavior:**
- When viewing a **remote node**: Shows only projects explicitly assigned to that node
- When viewing the **local node**: Shows projects assigned to local + all unassigned projects

**Current gaps:**
1. `POST /api/projects` doesn't accept `nodeId`
2. No UI for selecting node during project creation
3. `browseDirectory` only serves local filesystem

---

## 8. Design Recommendations

### 8.1 Implement Generic Wildcard Proxy (FN-1802)

**Recommendation:** Implement a catch-all proxy route rather than individual routes.

**Rationale:**
- Simpler: One route handles all paths
- Maintainable: No need to add routes for new endpoints
- Complete: Any API endpoint works transparently

**Caveats to handle:**
- SSE streams need special handling (upgrade, streaming)
- Request body streaming for large payloads
- Timeout handling for long requests
- Error propagation from remote node

### 8.2 SSE Proxy with Proper Cleanup

**Recommendation:** Implement proper SSE proxy with resource cleanup.

**Requirements:**
- Abort request when client disconnects
- 45-second heartbeat timeout (as in `useRemoteNodeEvents`)
- Clean up EventSource on client disconnect
- Handle partial chunk streaming

**Implementation pattern:**
```typescript
router.get("/proxy/:nodeId/events", async (req, res) => {
  const node = await getNode(req.params.nodeId);
  
  // Set SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  
  // Create EventSource to remote
  const eventSource = new EventSource(`${node.url}/api/events`);
  
  // Forward events
  eventSource.onmessage = (event) => {
    res.write(`data: ${event.data}\n\n`);
  };
  
  // Cleanup on client disconnect
  req.on("close", () => {
    eventSource.close();
  });
});
```

### 8.3 Explicit Project-Node Assignment

**Recommendation:** Keep assignment explicit (user chooses), not automatic.

**Rationale:**
- Clarity: Users know where their projects run
- Control: No surprise migrations
- Safety: Can't accidentally assign to wrong node

**UI pattern:**
- Node dropdown in New Project modal
- "Assigned to: {nodeName}" badge on project cards
- Confirmation when changing assignment

### 8.4 Read-Only Remote Browsing Initially

**Recommendation:** Implement read-only remote project viewing first.

**Rationale:**
- Lower risk: No accidental writes to remote
- Simpler: No conflict resolution needed
- Usable: Users can inspect remote state

**Future scope:**
- Task creation on remote nodes
- Task mutations (move, update, complete)
- Real-time collaboration

### 8.5 Forward Search Query in Proxy

**Note:** The `searchQuery` parameter is forwarded in `fetchRemoteNodeTasks()`:

```typescript
const params = new URLSearchParams({ projectId });
if (searchQuery && searchQuery.trim()) {
  params.set("q", searchQuery.trim());
}
return proxyApi<Task[]>(`/tasks?${params.toString()}`, { nodeId });
```

This satisfies the FN-1529 requirement for search query propagation.

---

## 9. Gap Analysis

### 9.1 Critical Gaps (Blocking Remote Viewing)

| Gap | File | Line | Impact |
|-----|------|------|--------|
| No proxy routes | `routes.ts` | N/A | Remote viewing completely broken |
| No SSE proxy | `routes.ts` | N/A | No real-time updates for remote |

### 9.2 Project-Node Assignment Gaps

| Gap | File | Line | Impact |
|-----|------|------|--------|
| No nodeId in POST /projects | `routes.ts` | 12684 | Can't assign at creation |
| No nodeId in registerProject | `central-core.ts` | 230 | API doesn't support it |
| No node selector UI | `App.tsx` | — | Users can't choose node |
| browse-directory not proxied | `routes.ts` | 12591 | Can't browse remote filesystem |

### 9.3 Background Service Gaps

| Gap | File | Line | Impact |
|-----|------|------|--------|
| PeerExchangeService not started | `serve.ts` | — | No peer sync |
| startDiscovery not wired | `serve.ts` | — | No mDNS discovery |
| PeerExchangeService not started | `dashboard.ts` | — | No peer sync |
| startDiscovery not wired | `dashboard.ts` | — | No mDNS discovery |

### 9.4 Project Scoping Gaps (FN-1736)

| Gap | Description |
|-----|-------------|
| SSE filtering | SSE events not filtered by projectId |
| WebSocket filtering | WebSocket broadcasts not project-scoped |
| Background services | Some services not aware of project context |

---

## 10. Verification Checklist

### 10.1 File Verification

- [x] `packages/core/src/central-core.ts` — Node registry, project registry, mesh state
- [x] `packages/core/src/node-connection.ts` — Connection testing
- [x] `packages/core/src/types.ts` — Type definitions
- [x] `packages/core/src/central-db.ts` — Database schema with `nodeId` column
- [x] `packages/dashboard/app/context/NodeContext.tsx` — React context
- [x] `packages/dashboard/app/api.ts` — `proxyApi()`, `withNodeId()`
- [x] `packages/dashboard/app/api-node.ts` — Remote node API functions
- [x] `packages/dashboard/app/hooks/useRemoteNodeData.ts` — Data fetching
- [x] `packages/dashboard/app/hooks/useRemoteNodeEvents.ts` — SSE subscription
- [x] `packages/dashboard/app/App.tsx` — Local/remote switching (lines 67-83)
- [x] `packages/dashboard/app/utils/nodeProjectAssignment.ts` — Routing rules
- [x] `packages/dashboard/src/routes.ts` — API routes
- [x] `packages/cli/src/commands/serve.ts` — Headless node mode
- [x] `packages/engine/src/peer-exchange-service.ts` — Peer sync service

### 10.2 No Proxy Routes

```bash
$ grep -rn "/proxy" packages/dashboard/src/routes.ts
# (no output)
```

Confirmed: No proxy routes exist in `routes.ts`.

### 10.3 nodeId in Projects Table

```bash
$ grep -n "nodeId" packages/core/src/central-db.ts
# Line 34: nodeId TEXT,
```

Confirmed: `nodeId` column exists in projects table schema.

### 10.4 CentralCore.registerProject Input

```typescript
// central-core.ts line 230
async registerProject(input: {
  name: string;
  path: string;
  isolationMode?: IsolationMode;
  settings?: ProjectSettings;
  // nodeId is NOT accepted
}): Promise<RegisteredProject>
```

Confirmed: `nodeId` is not in the input type.

### 10.5 PeerExchangeService Not Wired

```bash
$ grep -rn "PeerExchangeService" packages/cli/src/commands/*.ts
# (no output)
```

Confirmed: `PeerExchangeService` is not instantiated in CLI commands.

### 10.6 Discovery Not Wired

```bash
$ grep -rn "startDiscovery" packages/cli/src/commands/*.ts
# (no output)
```

Confirmed: `startDiscovery()` is not called in CLI commands.

---

## Appendix A: Relevant Type Definitions

### A.1 NodeConfig

```typescript
export interface NodeConfig {
  id: string;
  name: string;
  type: "local" | "remote";
  url?: string;
  apiKey?: string;
  status: NodeStatus;
  capabilities?: AgentCapability[];
  systemMetrics?: SystemMetrics;
  knownPeers?: string[];
  maxConcurrent: number;
  createdAt: string;
  updatedAt: string;
}
```

### A.2 RegisteredProject

```typescript
export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  status: ProjectStatus;
  isolationMode: IsolationMode;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  nodeId?: string;  // Optional - points to assigned node
  settings?: ProjectSettings;
}
```

### A.3 NodeMeshState

```typescript
export interface NodeMeshState {
  nodeId: string;
  nodeName: string;
  nodeUrl: string | undefined;
  status: NodeStatus;
  metrics: SystemMetrics | null;
  lastSeen: string;
  connectedAt: string;
  knownPeers: PeerNode[];
}
```

---

## Appendix B: Central Database Schema

```sql
-- projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  isolationMode TEXT NOT NULL DEFAULT 'in-process',
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  lastActivityAt TEXT,
  nodeId TEXT,  -- Optional foreign key to nodes.id
  settings TEXT
);

-- nodes table
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('local', 'remote')),
  url TEXT,
  apiKey TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  capabilities TEXT,
  systemMetrics TEXT,
  knownPeers TEXT,
  maxConcurrent INTEGER NOT NULL DEFAULT 2,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
```

---

## Appendix C: Related Documentation

- `.fusion/memory.md` — Section "Peer Gossip Protocol (FN-1224)"
- `.fusion/memory.md` — Section "Node Plugin Sync (FN-1246/FN-1518)"
- `.fusion/memory.md` — Section "FN-1529: Search Query Propagation"
- `.fusion/memory.md` — Section "FN-1522: Task State Reconciliation Pattern"

---

**Document Version:** 1.0  
**Last Updated:** 2026-04-14
