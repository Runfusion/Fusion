# Agent Sandbox Research Findings: FN-1839

**Research Date:** 2026-04-14  
**Task:** Research AgentOS and Alternative Sandbox Technologies for Fusion Agent Execution Isolation  
**Author:** Research Agent  

---

## 1. Executive Summary

**Can AgentOS integrate with Fusion?** No — AgentOS is a Reinforcement Learning (RL) agent framework for Python (`agentos-project/agentos`, 25 stars), fundamentally incompatible with Fusion's TypeScript/Node.js runtime and AI coding agent workflow model. It targets ML researchers, not software engineering teams.

**Top Recommended Sandbox Option for Fusion:** **Docker containers with seccomp profiles** for the short-to-medium term, with **gVisor** as the medium-term upgrade path. This recommendation is conditional on Linux deployment — macOS users would require Docker Desktop or OrbStack.

**Key Trade-off:** Adding a container runtime introduces a dependency on Docker (or containerd) and increases operational complexity, but provides strong filesystem and network isolation that Fusion's current `ChildProcessRuntime` lacks. The tradeoff is worthwhile if Fusion's threat model includes malicious or buggy agent code attempting filesystem escapes or network exfiltration.

---

## 2. Fusion's Current Isolation Model

Fusion implements a two-tier isolation model via the `ProjectRuntime` interface defined in `packages/engine/src/project-runtime.ts`.

### 2.1 InProcessRuntime

Defined in `packages/engine/src/runtimes/in-process-runtime.ts`, this is Fusion's **default** execution mode. All components — `TaskStore`, `Scheduler`, `TaskExecutor`, `WorktreePool`, `HeartbeatMonitor`, `PluginRunner` — share the same Node.js event loop and memory space.

```
TaskExecutor (executor.ts)
  ├── createKbAgent() → pi-coding-agent session
  ├── Custom tools: read_file, edit_file, bash, spawn_agent, task_*, plugin_*
  ├── Session runs in: git worktree directory (.worktrees/{name}/)
  └── HeartbeatMonitor → 30-second check cycle
```

**Isolation guarantees:** None beyond git worktree directory isolation. A buggy or malicious agent could:
- Read/write any file the Node.js process has access to
- Exfiltrate data via network
- Fork processes that outlive the session

**Startup overhead:** ~0ms (same process, no IPC)

### 2.2 ChildProcessRuntime

Defined in `packages/engine/src/runtimes/child-process-runtime.ts`, this forks a **separate Node.js process** running an internal `InProcessRuntime`. Communication uses `IpcHost`/`IpcWorker` defined in `packages/engine/src/ipc/ipc-protocol.ts`.

**IPC Protocol (from `ipc-protocol.ts`):**
- Commands: `START_RUNTIME`, `STOP_RUNTIME`, `GET_STATUS`, `GET_METRICS`, `PING`
- Events: `TASK_CREATED`, `TASK_MOVED`, `TASK_UPDATED`, `ERROR_EVENT`, `HEALTH_CHANGED`
- 10-second command timeout, 5-second health-check ping interval

**Security model:** Process-level isolation (separate memory space). The child process runs the full `InProcessRuntime`, meaning the agent still has filesystem and network access within the forked process.

**Startup overhead:** ~100–300ms (fork + IPC handshake + InProcessRuntime initialization)

**Health monitoring:**
- 3 missed heartbeats → restart attempt
- Exponential backoff: 1s, 5s, 15s delays
- Max 3 restart attempts before transitioning to `errored`

### 2.3 Git Worktree Isolation

Each task receives a dedicated git worktree (`.worktrees/{name}/`) created via `git worktree add`. Branches are named `fusion/{task-id}`. This provides:
- **Filesystem isolation at directory level** — changes are isolated to the worktree
- **No protection against:** reading parent project files, accessing `.fusion/`, network egress, process spawning

The worktree is configured in `TaskExecutor.execute()` (`packages/engine/src/executor.ts`, ~line 800) and cleaned up on task completion/failure.

### 2.4 Tool Surface

The executor's agent tools (`packages/engine/src/executor.ts`, ~lines 150–300) include:

| Tool | Purpose | Risk |
|------|---------|------|
| `read_file` | Read project files | FS escape potential |
| `edit_file` | Modify project files | FS escape potential |
| `bash` | Execute shell commands | Full system access |
| `spawn_agent` | Fork child agents | Process escape potential |
| `task_*` | Task board operations | Internal API access |
| `plugin_*` | Plugin tool execution | Depends on plugin |
| `review_step` | Trigger code review | Read-only |

The `bash` tool is the highest-risk tool — it executes arbitrary shell commands in the worktree context with access to the Node.js process environment.

### 2.5 PluginRunner Isolation

Defined in `packages/engine/src/plugin-runner.ts`, the `PluginRunner` bridges plugins to the agent tool surface. Key isolation properties:
- **Hook timeout:** 5-second default (`DEFAULT_HOOK_TIMEOUT_MS`)
- **Error isolation:** One plugin's crash doesn't propagate to others
- **No filesystem/network sandboxing** for plugin tool execution

---

## 3. AgentOS Deep Dive

### 3.1 What is AgentOS?

**Project:** `agentos-project/agentos` (GitHub)  
**Language:** Python  
**Maturity:** 25 stars, 9 forks, last push February 2023 (archived)  
**Purpose:** Reinforcement Learning agent framework — "Python Component System (PCS) + AgentOS" for building, running, and sharing RL agents  
**Website:** agentos.org

### 3.2 Architecture

AgentOS consists of two components:

1. **Python Component System (PCS):** An open Python API, CLI, and web server for building, running, and sharing Python programs. Uses `MLflow` for environment management.

2. **AgentOS:** Libraries built on PCS that make it easy to build, run, and share agents that use RL to solve tasks.

### 3.3 Integration Analysis (8 Dimensions)

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | No sandboxing — AgentOS runs Python in the host environment. Not designed for untrusted code. |
| **Startup Overhead** | Python environment startup (~1–5s) + MLflow initialization. Incompatible with Fusion's 30-second heartbeat cycle. |
| **Filesystem Access** | Full filesystem access via Python. No worktree isolation concept. |
| **Network Access** | Full network access. Agents can make HTTP requests freely. |
| **IPC / Tooling Compatibility** | Python-based. Fusion is TypeScript/Node.js. Would require a separate process communicating via IPC, but AgentOS has no IPC mechanism designed for this. |
| **Cross-Platform** | Linux/macOS for Python. Windows support via WSL. Not natively available on all platforms. |
| **Operational Complexity** | MLflow dependency, Python environment management. High operational burden for Fusion's `fn serve` deployment model. |
| **Recommended Integration Point** | None — fundamentally incompatible. |

### 3.4 Verdict

**Not viable for Fusion.** AgentOS is a Reinforcement Learning research framework, not a production agent sandboxing solution. It predates the AI coding agent era and has been largely unmaintained since 2023.

---

## 4. Alternative Technology Evaluations

### 4.1 gVisor (Google's Application Kernel)

**Project:** `google/gvisor` (18,091 stars)  
**Language:** Go  
**Purpose:** Userspace kernel ("runsc") that intercepts system calls, providing a stronger isolation boundary than containers without a VM overhead.

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Strong — intercepts all system calls, runs in user space. Prevents kernel exploits, filesystem escapes, privilege escalation. |
| **Startup Overhead** | ~100ms (similar to ChildProcessRuntime). Container-style: snapshot/restore. |
| **Filesystem Access** | `/proc` filtering, capability dropping, seccomp. Read-only host filesystem by default. |
| **Network Access** | Network namespace isolation. Can allow specific outbound HTTPS. |
| **IPC / Tooling Compatibility** | Would run the full Fusion executor inside gVisor. Compatible with Node.js tools. |
| **Cross-Platform** | Linux-only (kernel-level). macOS requires Linux VM. |
| **Operational Complexity** | Moderate — requires `runsc` installed on host. Docker integration available. |
| **Integration Point** | Replace `ChildProcessRuntime` fork with gVisor container spawn. |

**Verdict:** **Partially viable.** Best security/performance tradeoff for Linux deployments. Requires significant operational changes.

---

### 4.2 Firecracker MicroVMs (AWS)

**Project:** `firecracker-microvm/firecracker` (33,706 stars)  
**Language:** Rust  
**Purpose:** Lightweight VMs (~125ms startup, ~5MB memory overhead) for serverless computing.

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Strongest — full VM isolation with hardware virtualization (KVM). |
| **Startup Overhead** | ~125ms cold start, ~100ms with microVM snapshot/resume. |
| **Filesystem Access** | Rootfs + scratch space. Can mount project directory read-write. |
| **Network Access** | TAP/TUN devices. Full network namespace control. |
| **IPC / Tooling Compatibility** | Would run Fusion executor in VM. Requires custom IPC bridge. |
| **Cross-Platform** | Linux with KVM only. macOS requires nested virtualization or VM. |
| **Operational Complexity** | High — requires KVM, VM management infrastructure, snapshot storage. |
| **Integration Point** | Replaces `ChildProcessRuntime` with VM spawn. |

**Verdict:** **Viable but high complexity.** Best isolation available, but operational burden is significant. Better suited for multi-tenant SaaS than single-developer `fn serve` deployments.

---

### 4.3 WebAssembly / WASI (Wasmtime, Wasmer)

**Project:** `bytecodealliance/wasmtime` (17,885 stars)  
**Language:** Rust  
**Purpose:** Sandboxed execution for untrusted code with linear memory model.

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Strong — WASI provides controlled I/O, no direct syscall access. Memory-safe linear model. |
| **Startup Overhead** | Very low — ~1–10ms. Wasm modules compile to native code via JIT. |
| **Filesystem Access** | WASI filesystem API provides directory capability grants. Can restrict to specific paths. |
| **Network Access** | WASI sockets API (experimental). HTTP via WASI-http. Limited but improving. |
| **IPC / Tooling Compatibility** | Incompatible with Node.js native tools. Agent tools (bash, read_file, etc.) would need WASI-native implementations or proxying. |
| **Cross-Platform** | Excellent — runs on Linux, macOS, Windows, browsers. Single binary distribution. |
| **Operational Complexity** | Low — single `wasmtime` binary. WASI support in Node.js via `wasmer-js` or `@aspect-run/wasi`. |
| **Integration Point** | Not viable as a full executor sandbox — Fusion's tools are Node.js native. Could sandbox individual `bash` commands via WASI. |

**Verdict:** **Not viable for full executor isolation.** The tool compatibility gap is fundamental — Fusion's agent tools are Node.js native and cannot run inside Wasm. Could be used for isolated `bash` tool execution.

---

### 4.4 Docker / OCI Containers with Security Profiles

**Project:** Standard OCI runtime  
**Purpose:** Industry-standard containerization with seccomp, AppArmor, and capability filtering.

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Good — seccomp profile can block dangerous syscalls (ptrace, mount, etc.). Capability dropping limits privileges. |
| **Startup Overhead** | ~200–500ms cold start, ~50ms with container reuse (Docker reuse driver). |
| **Filesystem Access** | Bind mounts for project root and worktrees. Read-only for system directories. |
| **Network Access** | Docker bridge network. Can allow specific outbound HTTPS with `--network=container` or custom bridge. |
| **IPC / Tooling Compatibility** | Full compatibility — runs Fusion executor as-is inside container. |
| **Cross-Platform** | Works on Linux. On macOS/Windows, requires Docker Desktop or OrbStack. |
| **Operational Complexity** | Moderate — Docker daemon required. `fn serve` would need Docker socket access. |
| **Integration Point** | Replace `ChildProcessRuntime` fork with `docker run`. |

**Verdict:** **Viable and practical.** Best balance of compatibility, security, and operational familiarity. Recommended short-term option.

---

### 4.5 Linux Namespace Jails (bubblewrap, firejail, nsjail)

**Projects:**  
- `netblue30/firejail` (7,288 stars) — Linux namespaces and seccomp-bpf sandbox  
- `projectdiscovery/nuclei` (nsjail integration)

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Moderate — namespace isolation without VM overhead. Cannot block kernel exploits within same user namespace. |
| **Startup Overhead** | Very low — ~10–50ms. No container image overhead. |
| **Filesystem Access** | Overlay filesystem, per-namespace mounts. Can whitelist specific paths. |
| **Network Access** | Network namespace isolation available. |
| **IPC / Tooling Compatibility** | Full compatibility — runs as subprocess with namespace isolation. |
| **Cross-Platform** | Linux-only. No macOS support. |
| **Operational Complexity** | Low — single binary (`firejail` or `bubblewrap`). No daemon required. |
| **Integration Point** | Sandbox individual `bash` tool invocations rather than full executor. |

**Verdict:** **Partially viable.** Good for hardening individual operations without full container overhead. Cannot match gVisor's security boundary.

---

### 4.6 Node.js Isolated-VM / V8 Isolate Sandboxing

**Projects:**  
- `nodejs/isolated-vm` (archived, no longer maintained)  
- Community successors and `v8isolate` experiments

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Strong within V8 — memory isolation, no direct syscall access. Weakness: native addons can escape. |
| **Startup Overhead** | Very low — V8 isolate creation is ~10–50ms. |
| **Filesystem Access** | No built-in filesystem access — must be explicitly provided. |
| **Network Access** | No built-in network — must be explicitly provided. |
| **IPC / Tooling Compatibility** | Not compatible with Fusion's pi-coding-agent tools which require Node.js native APIs. |
| **Cross-Platform** | Node.js runs anywhere. |
| **Operational Complexity** | Low — no external dependencies. |
| **Integration Point** | Could sandbox individual JS expression evaluations, not full agent sessions. |

**Verdict:** **Not viable for full executor isolation.** The pi-coding-agent tool surface is Node.js native and cannot run inside a V8 isolate.

---

### 4.7 E2B (Cloud-Based Code Execution Sandbox)

**Project:** `e2b-dev/infra` (1,022 stars)  
**Service:** e2b.dev cloud sandbox  
**Purpose:** Cloud-hosted sandboxed execution environments for AI agents.

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Strong — managed cloud VMs with filesystem and network isolation. |
| **Startup Overhead** | ~500ms–2s (cloud VM spawn + agent initialization). |
| **Filesystem Access** | Managed filesystem with workspace sync. |
| **Network Access** | Controlled via firewall rules. HTTPS outbound allowed. |
| **IPC / Tooling Compatibility** | Requires cloud API integration. Fusion would need to proxy agent sessions to E2B API. |
| **Cross-Platform** | Universal — web API. Works with any Fusion deployment. |
| **Operational Complexity** | High — external service dependency, authentication, cost per execution. |
| **Integration Point** | New `CloudSandboxRuntime` implementing `ProjectRuntime` interface, proxying to E2B API. |

**Verdict:** **Viable but external dependency.** Best for teams already using E2B or wanting zero operational overhead. Requires significant architecture change.

---

### 4.8 Modal (Serverless Python/Container Execution)

**Project:** `modal-labs/modal-client` (459 stars)  
**Service:** modal.com serverless platform  
**Purpose:** Serverless container execution for Python with GPU support.

#### Analysis

| Dimension | Analysis |
|----------|---------|
| **Security Boundary** | Strong — containers with network and filesystem isolation. |
| **Startup Overhead** | ~500ms–2s (container cold start). |
| **Filesystem Access** | Volume mounts for persistent storage. |
| **Network Access** | Controlled outbound via Modal's network configuration. |
| **IPC / Tooling Compatibility** | Python-first. Node.js support limited. Fusion would need Modal-compatible wrapper. |
| **Cross-Platform** | Universal — web API. |
| **Operational Complexity** | High — external service, Python focus, cost per execution. |
| **Integration Point** | Not viable — Python/Modal runtime doesn't match Fusion's TypeScript/Node.js architecture. |

**Verdict:** **Not viable.** Modal's Python-first design doesn't match Fusion's TypeScript/Node.js runtime.

---

## 5. Comparative Summary Table

| Technology | Startup Latency | Security Strength | Cross-Platform | Complexity | Fusion Fit Score (1–5) |
|------------|----------------|-------------------|-----------------|------------|------------------------|
| **AgentOS** | N/A (incompatible) | None | Python | High | 1 — Not viable |
| **gVisor** | ~100ms | Strong (syscall interception) | Linux only | Moderate | 4 — Strong candidate |
| **Firecracker VMs** | ~125ms | Very Strong (VM) | Linux/KVM only | High | 3 — Powerful but complex |
| **WebAssembly/WASI** | ~10ms | Strong (linear memory) | Excellent | Low | 2 — Tool incompatibility |
| **Docker + seccomp** | ~200–500ms | Good (syscall filtering) | Linux + Docker Desktop | Moderate | 5 — Recommended |
| **Namespace jails (firejail)** | ~10–50ms | Moderate (namespace) | Linux only | Low | 3 — Good for hardening |
| **V8 isolates** | ~10–50ms | Strong (V8) | Universal | Low | 2 — Tool incompatibility |
| **E2B cloud** | ~500ms–2s | Strong (VM) | Universal | High | 3 — External dependency |
| **Modal** | ~500ms–2s | Strong (container) | Universal | High | 1 — Python-focused |

**Highlighted Recommendation:** Docker + seccomp (Score: 5) for short-term; gVisor (Score: 4) for medium-term security upgrade.

---

## 6. Integration Recommendations

### 6.1 Short-Term (1–2 Sprints)

**Option A: Docker-based ChildProcessRuntime replacement**

Add a new `DockerRuntime` class that replaces `ChildProcessRuntime` with container-based isolation:

```typescript
// packages/engine/src/runtimes/docker-runtime.ts
class DockerRuntime implements ProjectRuntime {
  async spawnContainer(config: ProjectRuntimeConfig): Promise<void> {
    const worktreeMount = `${config.workingDirectory}/.worktrees`;
    const fusionMount = `${config.workingDirectory}/.fusion`;
    
    await execAsync(
      `docker run --rm ` +
      `-v ${worktreeMount}:/project/.worktrees:rw ` +
      `-v ${fusionMount}:/project/.fusion:ro ` +
      `--network=bridge ` +
      `--security-opt seccomp=default.json ` +
      `--cap-drop=ALL ` +
      `fusion-executor:latest node /app/entrypoint.js`,
      { cwd: config.workingDirectory }
    );
  }
}
```

**Changes to Fusion:**
1. Add `packages/engine/src/runtimes/docker-runtime.ts`
2. Update `HybridExecutor.addProject()` to accept `isolationMode: "docker"`
3. Add Docker image build (`Dockerfile`) for executor
4. Add seccomp profile generator for allowed syscalls

**Pre-requisites:**
- Docker daemon running on host
- `fusion/executor` Docker image published

**Effort:** ~2 sprints for MVP

---

**Option B: Firejail-based bash tool hardening**

Sandbox individual `bash` tool invocations rather than the full executor:

```typescript
// In executor.ts — bash tool implementation
async executeBash(command: string, worktreePath: string): Promise<string> {
  // Wrap bash execution in firejail
  const sandboxedCommand = [
    'firejail',
    `--quiet`,
    `--noprofile`,
    `--noroot`,
    `--private=/tmp/fusion-$$`,
    `--read-only=/home`,
    `--read-only=/root`,
    `--read-only=/bin`,
    `--read-only=/usr`,
    `--network=none`,  // Or --network=eth0 for outbound-only
    `bash`, `-c`, command
  ].join(' ');
  
  return execAsync(sandboxedCommand, { cwd: worktreePath });
}
```

**Changes to Fusion:**
1. Modify `createBashTool()` in `packages/engine/src/executor.ts`
2. Add firejail availability check with fallback to unsandboxed bash
3. Document firejail installation requirement

**Effort:** ~0.5 sprints

---

### 6.2 Medium-Term (Architectural Change)

**Option: New `IsolationMode` enum value with pluggable runtime factory**

Refactor `ProjectRuntime` interface to support runtime factories:

```typescript
// packages/core/src/types.ts
export type IsolationMode = 
  | "in-process" 
  | "child-process" 
  | "docker"        // NEW
  | "gvisor"        // NEW
  | "custom";       // NEW: user-provided runtime class

// packages/engine/src/project-runtime.ts
export interface ProjectRuntimeFactory {
  create(config: ProjectRuntimeConfig): ProjectRuntime;
}
```

**Changes to Fusion:**
1. Extend `IsolationMode` in `packages/core/src/types.ts`
2. Add `RuntimeFactoryRegistry` in `packages/engine/src/runtimes/`
3. Update `HybridExecutor` to use factory based on `isolationMode`
4. Add DockerRuntime and GvisorRuntime implementations
5. Update `ProjectSettings` interface with sandbox-specific config

**Effort:** ~3–4 sprints

---

### 6.3 Long-Term (Ideal State)

**Full gVisor integration with capability-based filesystem access:**

```
┌──────────────────────────────────────────────────────────────┐
│                    Fusion Engine (Host)                       │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              gVisor Sandbox (runsc)                     │ │
│  │  ┌────────────────────────────────────────────────────┐ │ │
│  │  │     Fusion Executor (Node.js)                       │ │ │
│  │  │  ├── pi-coding-agent session                        │ │ │
│  │  │  ├── TaskExecutor                                   │ │ │
│  │  │  └── Tool layer (read_file, edit_file, bash)       │ │ │
│  │  └────────────────────────────────────────────────────┘ │ │
│  │                                                           │ │
│  │  Allowed mounts:                                          │ │
│  │  - /project/.worktrees/{task-id} (read-write)            │ │
│  │  - /project/{allowed-paths} (read-only)                 │ │
│  │  - /tmp (tmpfs, read-write)                              │ │
│  │                                                           │ │
│  │  Network:                                                 │ │
│  │  - Allow: api.anthropic.com:443, api.openai.com:443     │ │
│  │  - Allow: github.com:443                                 │ │
│  │  - Block: all other egress                               │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Changes to Fusion:**
1. Implement gVisor-based `GvisorRuntime` with custom seccomp profile
2. Add filesystem capability grants to worktree access
3. Implement network egress allowlist in gVisor config
4. Add gVisor snapshot/resume for fast container reuse
5. Update `fn serve` to validate gVisor availability

**Effort:** ~6+ sprints (requires significant engineering investment)

---

## 7. Risks & Open Questions

### 7.1 What Would Need Prototyping Before Committing

1. **Docker runtime performance benchmark:** Measure actual startup latency vs `ChildProcessRuntime` baseline (100–300ms target)

2. **gVisor syscall compatibility:** Some Node.js operations require syscalls that gVisor may not intercept correctly. Test with Fusion's actual workload.

3. **Agent tool compatibility inside sandbox:** Verify pi-coding-agent tools work correctly when executed from within a container/gVisor

4. **Network egress allowlist for LLM APIs:** Prototype configuration for allowing only specific HTTPS endpoints

5. **Worktree access patterns:** Test git operations (commit, push, pull) from within the sandbox

### 7.2 Performance Benchmarks Needed

| Metric | Current (ChildProcessRuntime) | Docker | gVisor | Firecracker |
|--------|-------------------------------|--------|--------|-------------|
| Cold start latency | 100–300ms | ~200–500ms | ~100ms | ~125ms |
| Memory overhead | 0 | 50–100MB | 10–50MB | 5MB |
| Concurrent sandbox limit | N/A | ~10–50 containers | ~50–100 | ~100+ |

### 7.3 Security Audit Considerations

1. **Seccomp profile completeness:** Audit allowed syscalls to ensure no privilege escalation paths
2. **Capability review:** Verify `CAP_SYS_ADMIN`, `CAP_NET_ADMIN`, etc. are properly dropped
3. **Container escape vectors:** Review Docker/gVisor known CVEs and maintain update cadence
4. **Network egress verification:** Ensure LLM API endpoints are the only allowed outbound destinations

### 7.4 Open Questions

1. **How should worktree cleanup work?** Currently `git worktree remove` happens on the host. With containers, the worktree exists inside the sandbox. Need to decide: snapshot-and-copy-out vs. bind-mount from host.

2. **Plugin tool execution:** Plugin tools run via `PluginRunner`. Should they also be sandboxed? Current design assumes trusted plugins.

3. **Heartbeat timing with sandbox overhead:** The 30-second heartbeat check cycle assumes `ChildProcessRuntime` startup. If sandbox startup is significantly slower, this may need adjustment.

4. **macOS deployment story:** gVisor and namespace jails are Linux-only. What's the strategy for macOS users? Docker Desktop as common denominator?

5. **fn serve headless deployment:** `fn serve` is designed for remote machines. Running Docker inside Docker or requiring Docker-in-Docker is complex. What's the container runtime strategy for remote nodes?

---

## 8. Conclusion

Fusion's current `ChildProcessRuntime` provides process-level isolation (separate memory space) but does not restrict filesystem or network access. For use cases requiring stronger security boundaries, several viable options exist:

| Priority | Option | When to Choose |
|---------|--------|---------------|
| **1** | Docker + seccomp | Teams already using Docker, need moderate security improvement, want familiar tooling |
| **2** | gVisor | Linux deployments requiring strong syscall isolation, willing to manage `runsc` dependency |
| **3** | Firejail hardening | Quick win for individual `bash` tool hardening, minimal operational changes |
| **4** | Firecracker | Maximum isolation required, team has VM management infrastructure |

**AgentOS is not a viable option** for Fusion — it is a Reinforcement Learning research framework incompatible with Fusion's architecture.

**Recommended path:** Start with Docker-based isolation (Option A in 6.1) for rapid iteration, then invest in gVisor integration (6.3) for the production-grade solution.

---

## References

- `packages/engine/src/project-runtime.ts` — `ProjectRuntime` interface
- `packages/engine/src/runtimes/child-process-runtime.ts` — Current fork-based isolation
- `packages/engine/src/runtimes/in-process-runtime.ts` — Default in-process runtime
- `packages/engine/src/ipc/ipc-protocol.ts` — IPC command/event types
- `packages/engine/src/executor.ts` — Agent session creation, tools, worktree management
- `packages/engine/src/plugin-runner.ts` — Plugin tool execution, hook timeout isolation
- `packages/core/src/types.ts` — `IsolationMode` type, `ProjectSettings` interface
- `google/gvisor` — https://github.com/google/gvisor
- `firecracker-microvm/firecracker` — https://github.com/firecracker-microvm/firecracker
- `bytecodealliance/wasmtime` — https://github.com/bytecodealliance/wasmtime
- `netblue30/firejail` — https://github.com/netblue30/firejail
- `e2b-dev/infra` — https://github.com/e2b-dev/infra
- `agentos-project/agentos` — https://github.com/agentos-project/agentos
