# Research Report: Agent Sandboxing Technologies for Fusion

**Task:** FN-1782 — Research options for agent sandboxing
**Date:** 2026-04-14
**Scope:** Analysis of sandboxing technologies for integration with Fusion's multi-project runtime and plugin systems
**Note:** This is a research task — no code changes were made.

---

## Executive Summary

This report evaluates six sandboxing technologies for potential integration with Fusion's agent execution model. The current isolation model uses git worktrees for task-level separation and `ChildProcessRuntime` for project-level process isolation (~100–300ms fork overhead). 

**Primary Recommendation:** For near-term improvements, implement **Bubblewrap (bwrap)** for lightweight namespace-based sandboxing of individual `bash` tool invocations. This requires minimal architectural changes, introduces no new dependencies on Linux-only kernel features beyond what Fusion already assumes, and can be layered atop the existing `ChildProcessRuntime` model. 

**Long-term Direction:** Evaluate **WebAssembly/WASI** (particularly **Wasmtime** or **WAMR**) for agent tool isolation, as it offers strong security boundaries with cross-platform portability. The WASI 0.2 component model is maturing and provides filesystem/network access controls that map well to Fusion's worktree access patterns.

**agentos** specifically targets AI agent execution environments and warrants deeper investigation for future architectural decisions, but it is not yet production-stable for the isolation use cases described here.

---

## Background: Fusion's Current Isolation Model

### In-Process vs. Child-Process Runtime

Fusion supports two runtime isolation modes via the `ProjectRuntime` interface (`packages/engine/src/project-runtime.ts`):

1. **InProcessRuntime** — Tasks run within the main Node.js process. No additional isolation beyond what Node.js provides natively.

2. **ChildProcessRuntime** (`packages/engine/src/runtimes/child-process-runtime.ts`) — Projects run in isolated forked processes with:
   - **Health monitoring** via 5-second heartbeat intervals with 3-miss tolerance
   - **Automatic restart** with exponential backoff (1s, 5s, 15s delays, max 3 attempts)
   - **IPC communication** via `IpcHost`/`IpcWorker` protocol (`packages/engine/src/ipc/ipc-protocol.ts`)
   - **Graceful shutdown** with 30s timeout before SIGKILL fallback

### Agent Tool Surface

The executor (`packages/engine/src/executor.ts`) exposes these tools to agents:
- **File tools:** `read_file`, `edit_file`, `create_file` — operate on the task's git worktree
- **Bash tool:** Shell execution in the worktree directory
- **Task tools:** `task_update`, `task_log`, `task_create`, `task_done`, `task_document_*`
- **Agent tools:** `spawn_agent`, `review_step`, `task_add_dep`
- **Plugin tools:** Via `PluginRunner` (`packages/engine/src/plugin-runner.ts`)

The bash tool is the primary attack surface — it can execute arbitrary commands in the worktree.

### Worktree Model

Fusion creates git worktrees under `.worktrees/{name}/` for each task:
- Branch naming: `fusion/{task-id-lower}`
- Worktrees can be warm (from `WorktreePool`) or fresh
- The executor runs `bash` commands in the worktree directory
- `worktreeInitCommand` and setup scripts run during worktree creation

### Plugin Runner Isolation

`PluginRunner` provides a 5-second timeout for plugin hooks with error isolation. Plugin tools run in-process but have a timeout wrapper. This is a softer isolation boundary than what a true sandbox would provide.

---

## Technology Evaluations

### 1. Agentos

**Overview:** Agentos is an open-source project specifically designed for AI agent security and isolation. It provides an "agent operating system" that sandbox agents with filesystem restrictions, network policies, and resource limits. The project is under active development with a focus on making AI agents safe to run.

**Maturity:** Early-stage (v0.x), actively developed but not yet production-stable for enterprise use cases.

**Key Facts:**
- Provides per-agent sandboxes with configurable policies
- Filesystem access control (grant/deny specific paths)
- Network access control (allow/deny outbound connections)
- Resource limits (CPU, memory, time)
- Designed specifically for AI agent workloads

**Analysis:**

| Dimension | Assessment |
|-----------|------------|
| **Security Boundary** | Strong — designed specifically for agent isolation with deny-by-default policies for filesystem and network. Prevents arbitrary code execution escape. |
| **Startup Overhead** | Low (~50–150ms) — optimized for agent workloads. Would not significantly impact scheduler responsiveness. |
| **Filesystem Access** | Native support — agents can be restricted to specific directories (e.g., `.worktrees/{task-id}`). Fusion's worktree model maps directly. |
| **Network Access** | Explicit allowlists — can permit HTTPS outbound to LLM APIs while blocking lateral movement. |
| **IPC/Tooling Compatibility** | Requires tool layer redesign — agentos expects agents to run within its runtime. Would need IPC proxy between Fusion's pi-coding-agent tools and agentos sandbox. |
| **Operational Complexity** | Medium — new runtime dependency, but designed for developer ergonomics. Python-first with growing language support. |
| **Recommended Path** | Long-term architectural option. Currently too early for production integration with Fusion. Monitor development. |

---

### 2. gVisor

**Overview:** gVisor is Google's userspace kernel for containers. It provides a strong security boundary by implementing Linux system calls in user space, intercepting all syscalls from the container and executing them in a sandboxed environment.

**Maturity:** Production-stable (used by Google Cloud Run, Anthos, and others). Active maintenance.

**Key Facts:**
- Implements ~200 Linux syscalls in user space (Sentry process)
- Two modes: KVM-based (full performance) and ptrace-based (maximum isolation, lower performance)
- OCI-compatible (works with Docker, Kubernetes)
- Network and filesystem isolation via user-space networking stack (gNet)

**Analysis:**

| Dimension | Assessment |
|-----------|------------|
| **Security Boundary** | Very strong — user-space kernel prevents kernel exploits from container workloads. Effective against container escape, privilege escalation. |
| **Startup Overhead** | Medium (~200–500ms) — Sentry process startup. Comparable to or higher than current `ChildProcessRuntime` fork cost. |
| **Filesystem Access** | OCI image-based rootfs + overlay. Fusion would need to bundle worktrees into the container image or use volume mounts. |
| **Network Access** | gNet provides controlled networking. Can restrict outbound to specific hosts/ports (LLM APIs). |
| **IPC/Tooling Compatibility** | Requires Docker/OCI container management. Fusion's IPC model (`IpcHost`/`IpcWorker`) would need translation to container exec or gVisor's IPC mechanism. |
| **Operational Complexity** | High — requires Docker runtime, gVisor installation, OCI image management. Kernel module (KVM) or ptrace setup needed. macOS/Windows support limited. |
| **Recommended Path** | Not recommended for near-term. Replaces `ChildProcessRuntime` entirely. Suitable for environments already running container infrastructure. |

---

### 3. AWS Firecracker

**Overview:** Firecracker is an open-source microVM technology developed by AWS for serverless workloads (Lambda, Fargate). It provides VM-level isolation with container-like speed (sub-second startup).

**Maturity:** Production-stable (powers AWS Lambda, Fargate). Active development with strong community.

**Key Facts:**
- MicroVM hypervisor (KVM-based)
- Startup time: ~100ms (optimized for serverless)
- Minimal device model (virtio-net, virtio-block, vsock)
- Designed for multi-tenant isolation
- RESTful API for VM lifecycle management (Firecracker VMM)

**Analysis:**

| Dimension | Assessment |
|-----------|------------|
| **Security Boundary** | Very strong — hardware virtualization provides strongest isolation (separate kernel). Nearly impermeable to cross-VM attacks. |
| **Startup Overhead** | Low (~100ms) — comparable to current `ChildProcessRuntime`. Excellent for scheduler responsiveness. |
| **Filesystem Access** | virtio-blk for block devices. Fusion worktrees would need to be mounted as volumes. Additional complexity vs. current model. |
| **Network Access** | virtio-net with vsock for host communication. Outbound network control possible but requires networking configuration. |
| **IPC/Tooling Compatibility** | Significant redesign. Fusion's `IpcHost`/`IpcWorker` would need to translate to vsock or HTTP. Tool execution would happen inside the VM. |
| **Operational Complexity** | Very high — requires KVM, VM image management, networking setup. Primarily Linux-only (no native macOS/Windows). |
| **Recommended Path** | Not recommended for current Fusion architecture. Best suited for multi-tenant SaaS or dedicated hosting environments. |

---

### 4. WebAssembly / WASI

**Overview:** WebAssembly (Wasm) is a binary instruction format for a stack-based virtual machine. WASI (WebAssembly System Interface) provides standardized system-level APIs (filesystem, network, clocks) for Wasm modules, enabling sandboxed execution outside browsers.

**Maturity:** WASI 0.2 (component model) is stable and gaining adoption. Wasmtime and WAMR are production-ready runtimes.

**Key Facts:**
- **Wasmtime** — Rust-based runtime, excellent performance, JIT compilation
- **WAMR** — Lightweight runtime, suitable for embedded/IoT
- **WASI 0.2** — Component model for composing Wasm modules with typed interfaces
- Execution isolation at the function level
- Deterministic execution model

**Analysis:**

| Dimension | Assessment |
|-----------|------------|
| **Security Boundary** | Strong — Wasm's linear memory model and sandboxed execution prevent arbitrary memory access. WASI provides controlled I/O access. |
| **Startup Overhead** | Very low (~1–10ms) — Wasm modules are lightweight. Excellent for scheduler responsiveness. |
| **Filesystem Access** | WASI filesystem API provides path-based access control. Can restrict to worktree directories. Component model allows fine-grained permissions. |
| **Network Access** | WASI 0.2 includes `wasmrc` for outbound HTTP. Can whitelist specific hosts for LLM API access. |
| **IPC/Tooling Compatibility** | Requires porting or wrapping tools as Wasm components. Fusion's pi-coding-agent tools (Node.js) would need Wasm bindings or IPC proxy to Wasm execution. **This is the primary challenge.** |
| **Operational Complexity** | Medium — requires Wasm runtime, tool porting effort. Cross-platform (Linux, macOS, Windows). No kernel requirements. |
| **Recommended Path** | **Medium-term architectural direction.** Most promising for Fusion because: (1) Low overhead, (2) Cross-platform, (3) Filesystem/network controls align with worktree model. Requires tool layer adaptation. |

---

### 5. Docker with seccomp/AppArmor Profiles

**Overview:** Docker containers with hardened security profiles. seccomp (secure computing mode) whitelists allowed syscalls. AppArmor (or SELinux) provides pathname-based access control.

**Maturity:** Production-stable. Widely understood, extensive tooling.

**Key Facts:**
- **seccomp** — Whitelist of ~300 safe syscalls (default Docker profile blocks ~44 dangerous syscalls)
- **AppArmor** — Pathname-based access policies (Debian/Ubuntu default)
- **SELinux** — Label-based access policies (RHEL/Fedora default)
- OCI container standard
- Extensive ecosystem (Kubernetes, Docker Compose, etc.)

**Analysis:**

| Dimension | Assessment |
|-----------|------------|
| **Security Boundary** | Moderate-to-strong — seccomp reduces syscall surface. AppArmor adds path restrictions. Not as strong as gVisor or Firecracker, but significantly better than bare process. |
| **Startup Overhead** | Low-to-medium (~200–500ms for cold start, ~50ms for warm). Container layer caching helps. |
| **Filesystem Access** | Volume mounts work naturally. Can mount specific worktree directories. AppArmor can restrict path access further. |
| **Network Access** | Docker bridge networking. Can expose specific ports. Outbound can be controlled via network policies or custom DNS. |
| **IPC/Tooling Compatibility** | **Compatible with minimal changes.** Fusion's IPC model (`IpcHost`/`IpcWorker`) works inside containers. Tools run inside container. |
| **Operational Complexity** | Medium — requires Docker daemon, image management. Profile tuning for AppArmor/seccomp requires expertise. Better cross-platform support than gVisor/Firecracker (Docker Desktop on macOS/Windows). |
| **Recommended Path** | **Short-to-medium term option.** Can be implemented as an alternative to `ChildProcessRuntime` with stronger security. Lower complexity than gVisor/Firecracker. |

---

### 6. Linux Namespace Jails (Bubblewrap, nsjail)

**Overview:** Lightweight Linux namespace isolation without full containers. **Bubblewrap (bwrap)** is the user namespace sandbox used by Flatpak and GNOME apps. **nsjail** is a more configurable namespace jail.

**Maturity:** Bubblewrap is production-stable (used by major Linux distributions). nsjail is actively maintained.

**Key Facts:**
- **Bubblewrap (bwrap)** — Unprivileged sandbox using user namespaces. No root required. Used by Flatpak, chromium, etc.
- **nsjail** — Kafel policy language, more configurable, supports networking
- Mount namespace for filesystem restriction
- Network namespace for isolation
- PID namespace for process hiding
- User namespace for privilege dropping

**Analysis:**

| Dimension | Assessment |
|-----------|------------|
| **Security Boundary** | Moderate-to-strong — namespaces provide process/filesystem/network isolation. User namespace + no capabilities = good protection against container escape. |
| **Startup Overhead** | **Very low (~5–20ms).** Significantly faster than `ChildProcessRuntime` fork. Excellent for scheduler responsiveness. |
| **Filesystem Access** | **Excellent.** Bubblewrap mounts worktrees with `--bind` and can hide `/proc`, `/sys`, etc. Path-based access control is native. |
| **Network Access** | nsjail supports network namespaces and TCP/UDP restrictions. Bubblewrap can drop network capabilities. Can whitelist outbound HTTPS. |
| **IPC/Tooling Compatibility** | **Fully compatible.** Child processes of the sandboxed process inherit the namespace. Fusion's `IpcHost`/`IpcWorker` model works unchanged. Tool execution happens inside the namespace. |
| **Operational Complexity** | **Low.** Single binary dependency (bubblewrap or nsjail). No daemon required. Shell wrapper is straightforward. **Linux-only** (user namespaces not available on macOS/Windows). |
| **Recommended Path** | **Recommended for short-term implementation.** Fastest path to improved isolation. Can sandbox individual `bash` tool invocations or entire task execution. |

---

## Comparative Summary Table

| Technology | Startup Overhead | Security Strength | Filesystem Model | Network Model | IPC Compatibility | Complexity | Platform | Recommendation |
|------------|------------------|-------------------|------------------|---------------|------------------|------------|----------|---------------|
| **agentos** | Low (~50–150ms) | Strong | Native path policies | Explicit allowlists | Requires redesign | Medium | Cross-platform | Long-term (monitor) |
| **gVisor** | Medium (~200–500ms) | Very Strong | OCI rootfs + volumes | gNet controlled | Requires Docker translation | High | Linux (KVM) | Not recommended |
| **Firecracker** | Low (~100ms) | Very Strong | virtio-blk volumes | virtio-net | Requires VM exec | Very High | Linux (KVM) | Not recommended |
| **Wasm/WASI** | Very Low (~1–10ms) | Strong | WASI filesystem API | WASI HTTP | Tool porting required | Medium | **Cross-platform** | Medium-term (strategic) |
| **Docker + seccomp** | Low-Medium (~50–500ms) | Moderate-Strong | Volume mounts | Docker networking | **Fully compatible** | Medium | Cross-platform | Short-term option |
| **Bubblewrap/nsjail** | **Very Low (~5–20ms)** | Moderate-Strong | Native bind mounts | Namespace isolation | **Fully compatible** | **Low** | Linux-only | **Recommended (short-term)** |

---

## Integration Recommendations

### Short-Term: Bubblewrap for Bash Tool Isolation (Low Effort, Incremental)

**Approach:** Sandbox individual `bash` tool executions using Bubblewrap without modifying the `ChildProcessRuntime` model.

**Implementation Pattern:**
```bash
# Sandboxed bash invocation
bwrap \
  --bind /worktree/path /worktree/path \
  --ro-bind /usr/bin /usr/bin \
  --ro-bind /bin/bash /bin/bash \
  --dev /dev \
  --proc /proc \
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  bash -c "user command"
```

**Changes Required:**
1. Add bubblewrap as a dependency (Linux package)
2. Create a `SandboxedBash` wrapper in the executor that:
   - Constructs bwrap arguments based on task worktree path
   - Whitelists necessary binaries (`bash`, `git`, `node`, `pnpm`, etc.)
   - Restricts network access to necessary destinations
   - Sets memory/CPU limits via cgroups if available
3. Wrap the existing `bash` tool execution with the sandbox

**Benefits:**
- Minimal architectural change
- Dramatically reduces bash tool attack surface
- ~5–20ms overhead per bash invocation
- Transparent to existing IPC/tool model

**Limitations:**
- Linux-only (acceptable since Fusion already assumes Linux for production)
- Does not sandbox file-editing tools (those could be added to bubblewrap or handled separately)

---

### Medium-Term: Docker Containerization of Task Execution

**Approach:** Replace or augment `ChildProcessRuntime` with Docker-based isolation for tasks that need stronger security boundaries.

**Changes Required:**
1. Create a Docker image with Fusion's execution environment
2. Modify `TaskExecutor` to launch containers instead of spawning processes directly
3. Volume-mount the worktree into the container
4. Configure seccomp and AppArmor profiles

**Benefits:**
- Stronger isolation than bubblewrap alone
- OCI standard allows future migration to gVisor or other runtimes
- Consistent environment across hosts

**Limitations:**
- Requires Docker daemon (adds operational complexity)
- Higher startup overhead than bubblewrap
- Container image management

---

### Long-Term: WebAssembly/WASI for Tool Isolation

**Approach:** Gradually port Fusion tools to Wasm components with WASI bindings.

**Strategic Rationale:**
- **Cross-platform**: Works on Linux, macOS, Windows without kernel features
- **Low overhead**: ~1–10ms startup is excellent for tool invocation frequency
- **Fine-grained control**: WASI component model allows per-tool permission grants
- **Industry momentum**: WASI 0.2 is stable, major projects (Fermyon, Fastly, Cloudflare Workers) are investing

**Changes Required:**
1. Compile or wrap key tools (bash, git) as Wasm components
2. Implement WASI-based IPC between Fusion engine and Wasm sandbox
3. Configure WASI policy for worktree access

**Challenges:**
- Bash tool portability: Many shell scripts assume POSIX environment
- Tool ecosystem: Not all tools have Wasm builds
- IPC complexity: Need efficient communication between Node.js and Wasm

---

### Long-Term: Agentos Integration

**Approach:** Monitor agentos development and evaluate for future Fusion integration.

**When to Re-evaluate:**
- Production release (v1.0+)
- Stable API for programmatic control
- Language-agnostic SDK (currently Python-focused)
- Community adoption and third-party tool integrations

---

## Risks & Open Questions

### Bubblewrap Concerns

1. **macOS/Windows Support**: Fusion runs primarily on Linux for production. Desktop support via Docker or accept Linux-only server execution. **This is likely acceptable given Fusion's target audience.**

2. **Binary Allowlisting**: Need to enumerate all binaries agents might need (`bash`, `git`, `node`, `pnpm`, `npm`, `cargo`, etc.). Maintenance burden for new tool requirements.

3. **Capability Leaking**: Even with namespace isolation, poorly configured profiles can leak capabilities. Need security review of bubblewrap configuration.

4. **Nested Sandboxing**: If bubblewrap is already used for bash, can it be used for the entire task execution? What are the interactions with `ChildProcessRuntime`?

### Docker Concerns

1. **Daemon Dependency**: Docker daemon must be running. Adds failure modes (daemon crash, resource exhaustion).

2. **Image Management**: Need to keep execution image up-to-date with dependencies. Build pipeline required.

3. **Resource Limits**: Setting appropriate CPU/memory limits for agent workloads is challenging (bursty, unpredictable).

### WebAssembly Concerns

1. **Tool Ecosystem Gap**: Not all tools have Wasm builds. Porting effort significant.

2. **IPC Efficiency**: Communication between Node.js and Wasm modules adds latency. Need to benchmark for interactive tool use.

3. **Debugging**: Wasm debugging tooling is less mature than native execution.

### General Concerns

1. **Backward Compatibility**: Adding sandboxing must not break existing task workflows. Need gradual rollout strategy.

2. **Performance Impact**: Every sandbox layer adds overhead. Need to measure end-to-end impact on task execution time.

3. **Error Handling**: Sandbox failures (permission denied, resource limits) need clear error messages for debugging.

4. **Escape Hatch**: Need a way to disable sandboxing for troubleshooting (controlled via settings).

---

## Implementation Considerations

### Integration Points

Based on code analysis:

1. **`packages/engine/src/executor.ts`** — The bash tool is currently executed via `execAsync`. This is the primary integration point for bubblewrap wrapping.

2. **`packages/engine/src/runtimes/child-process-runtime.ts`** — Could be extended to launch tasks inside bubblewrap or Docker instead of raw fork.

3. **`packages/engine/src/plugin-runner.ts`** — Plugin tool timeout isolation could be strengthened with bubblewrap wrapping individual tool executions.

4. **`ProjectRuntime` interface** — The `isolationMode` field in `ProjectRuntimeConfig` could be extended to support sandboxing modes (`"in-process"`, `"child-process"`, `"sandboxed"`).

### Worktree Mount Strategy

For bubblewrap and Docker:
```bash
# Worktree is the agent's root filesystem
bwrap \
  --bind /project/worktrees/{task-id} / \
  --dev /dev \
  --proc /proc \
  bash -c "cd / && execute agent command"
```

This gives the agent a clean filesystem view with only the worktree accessible.

### Network Restriction Strategy

For bubblewrap:
```bash
# Block network or allow specific destinations
bwrap \
  --bind /worktree / \
  --network \
  # OR to block network:
  --unshare-net \
  --new-session \
  bash -c "..."
```

For more granular control, use `iptables` inside a network namespace or nsjail's policy language.

---

## Conclusion

Fusion's current `ChildProcessRuntime` model provides good project-level isolation but relies on Linux process boundaries for task-level security. Adding sandboxing to individual tool executions (particularly `bash`) would significantly strengthen the security posture with minimal architectural impact.

**Recommended immediate action:** Implement Bubblewrap-based sandboxing for the bash tool execution in `TaskExecutor`. This addresses the primary attack surface (arbitrary shell commands) while maintaining compatibility with Fusion's IPC and tool model.

**Recommended strategic direction:** Invest in WebAssembly/WASI tooling to enable cross-platform, fine-grained tool isolation in future versions.

**Items requiring prototyping before commitment:**
1. Benchmark bubblewrap overhead for typical agent bash workloads
2. Enumerate and test complete binary allowlist for Fusion tasks
3. Evaluate nsjail vs. bubblewrap for configurability vs. simplicity
4. Prototype Wasm-based tool wrapper for a single tool (e.g., `bash`)

---

*Report prepared for FN-1782. No code changes were made as part of this research.*
