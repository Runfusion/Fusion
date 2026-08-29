# FN-4635: Pluggable sandbox options for executor command isolation

## 1) Threat model

Fusion executor lanes currently run shell commands (`testCommand`, `buildCommand`, workflow script steps) as the host user inside a git worktree. This exposes the host if task content or agent-generated commands are malicious or buggy.

Primary threats:
- **Host filesystem access/exfiltration:** command reads/writes outside task worktree, including secrets in `$HOME`, SSH keys, cloud creds, and unrelated repos.
- **Secret exfiltration over network:** command uploads tokens, source, or `.fusion` metadata.
- **Persistence / host tampering:** command installs startup hooks, modifies shell rc, mutates global package/tool state.
- **Runaway resource abuse:** fork bombs, memory exhaustion, or very long-running scripts.
- **Cross-task contamination:** command mutates shared caches or shared worktree state in unsafe ways.
- **Dashboard safety:** accidental conflict with production dashboard process/port conventions (port 4040 must not be disrupted).

Non-goals for this phase:
- Perfect VM-grade multi-tenant isolation.
- Replacing host OS hardening strategy end-to-end.
- Sandboxing every agent role immediately (triage/reviewer may remain unchanged initially).

## 2) Requirements

Functional/operational requirements:
- **Platform first target:** macOS + Linux; document Windows path as follow-up.
- **Low startup overhead:** ideally sub-second to a few seconds for frequent executor invocations.
- **Pluggable with WorktreeBackend plan:** sandbox layer composes with current worktree lifecycle, not replacing it.
- **Opt-in settings model:** project/global defaults with task-level override.
- **Action-gate friendly:** policy-gated privileged/provisioning operations.
- **Command compatibility:** must still run realistic `pnpm test`, `pnpm build`, git operations, and workflow scripts.
- **Filesystem policy controls:** allowlist worktree + required caches + minimal runtime dirs.
- **Network policy controls:** allow default egress profile for git/npm unless explicitly restricted.
- **Graceful availability handling:** when backend is missing/unavailable, use configurable `fail-hard` vs `fallback-native` behavior.
- **Auditability:** emit run-audit events for backend prepare/run/failure/fallback.

## 3) Candidate survey

### 3.1 Baseline matrix

| Option | Platforms | Isolation primitives | Startup cost | Fit with worktrees | Operational notes |
|---|---|---|---|---|---|
| Native (status quo) | macOS/Linux/Windows | None beyond cwd/user perms | ~0 | Excellent | No added protection |
| macOS `sandbox-exec` | macOS | Seatbelt profile (fs/process/network constraints) | Low | Good | Deprecated tool; still available on many macOS versions |
| Apple App Sandbox | macOS app model | Entitlement-driven app containerization | N/A for CLI | Poor | Not realistic for arbitrary CLI shell commands |
| `bubblewrap` | Linux | mount/user/pid/net/uts/cgroup namespaces; seccomp via composition | Low | Excellent | Strong for per-command filesystem isolation |
| `firejail` | Linux | namespaces + seccomp + profiles | Low | Good | SUID/profile complexity trade-offs |
| Landlock | Linux (kernel feature) | unprivileged LSM policy (fs + TCP port control by ABI) | Very low | Good | Additive policy layer; kernel/ABI variability |
| `nsjail` | Linux | namespaces+cgroups+rlimits+seccomp | Low-med | Good | Powerful, but more ops complexity |
| Docker rootless | Linux/macOS (Desktop VM on macOS) | OCI containers + userns/rootless mode | Med | Good | Daemon/service dependency; image lifecycle overhead |
| Podman rootless | Linux/macOS (machine) | OCI containers daemonless + userns | Med | Good | Good local dev ergonomics; fewer daemon assumptions |
| gVisor (`runsc`) | Linux (container runtime) | userspace kernel boundary for containers | Med-high | Indirect | Strong isolation, but compatibility/perf overhead |
| Firecracker microVM | Linux + KVM | microVM boundary | High | Indirect | Strongest isolation, highest complexity/latency |
| WASM/WASI (Wasmtime) | macOS/Linux/Windows | runtime sandbox for wasm modules | Low-med | Limited | Only works for specifically-built wasm workloads, not arbitrary shell |

### 3.2 Evidence notes (sources)

- `sandbox-exec` is explicitly marked **DEPRECATED** and points developers to App Sandbox: https://keith.github.io/xcode-man-pages/sandbox-exec.1.html
- Bubblewrap provides unprivileged namespace-based sandbox construction and empty-rootfs model: https://manpages.debian.org/testing/bubblewrap/bwrap.1.en.html
- Firejail uses Linux namespaces and seccomp with profile-driven isolation and optional SUID model: https://firejail.wordpress.com/documentation-2/basic-usage/
- Landlock is an unprivileged, stackable LSM for filesystem and (ABI v4+) TCP access controls, with ABI/version caveats: https://www.kernel.org/doc/html/latest/userspace-api/landlock.html
- nsjail feature set includes namespaces, cgroups, rlimits, seccomp policy support: https://github.com/google/nsjail
- Docker rootless mode runs daemon + containers as non-root in user namespaces; requires uid/gid mappings: https://docs.docker.com/engine/security/rootless/
- Podman is daemonless and supports rootless operation with subuid/subgid and rootless network caveats: https://docs.podman.io/en/latest/markdown/podman.1.html
- gVisor introduces a userspace kernel (`runsc`) isolation layer and compatibility/perf trade-offs: https://gvisor.dev/docs/
- Firecracker provides KVM-backed microVMs with stronger isolation and lightweight VM design: https://firecracker-microvm.github.io/
- Wasmtime provides secure WASM runtime isolation, but requires wasm-targeted binaries/workloads: https://wasmtime.dev/
- OCI runtime spec context (container backend interoperability): https://github.com/opencontainers/runtime-spec

### 3.3 Fusion-specific operational considerations

- **pnpm/node_modules/caches:** sandbox policy must preserve usable package manager cache paths and workspace artifacts (or mount explicit cache volumes).
- **`.fusion/fusion.db` and task files:** executor may need read/write to project-local `.fusion` metadata depending on callsite.
- **Git access:** must permit git process execution and network egress for fetch/push where configured.
- **Network defaults:** practical default is allow egress; stricter policy should be explicit opt-in to avoid breaking test/build workflows.
- **Port policy:** no backend should force use of port 4040 or manage unrelated host processes.

## 4) Proposed pluggable abstraction

```ts
export type SandboxBackendId =
  | "native"
  | "sandbox-exec"
  | "bubblewrap"
  | "docker"
  | "podman"
  | "custom";

export type SandboxFailureMode = "fail-hard" | "fallback-native";

export interface SandboxPolicy {
  allowNetwork: boolean;
  allowedPaths: string[]; // absolute host paths mounted/readable in sandbox
  writablePaths?: string[];
  envAllowlist?: string[];
  cpuLimit?: { maxCores?: number; maxMs?: number };
  memoryLimitMb?: number;
}

export interface SandboxRunOptions {
  cwd: string;
  timeoutMs: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
}

export interface SandboxPrepareContext {
  taskId: string;
  runId: string;
  worktreePath: string;
  policy: SandboxPolicy;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface SandboxCapabilities {
  filesystemIsolation: "none" | "basic" | "strong";
  networkPolicy: "none" | "coarse" | "fine";
  resourceLimits: "none" | "basic" | "advanced";
  requiresInstall: boolean;
  supportsMac: boolean;
  supportsLinux: boolean;
  supportsWindows: boolean;
}

export interface SandboxBackend {
  id: SandboxBackendId;
  capabilities(): SandboxCapabilities;
  prepare(ctx: SandboxPrepareContext): Promise<void>;
  run(command: string, opts: SandboxRunOptions): Promise<SandboxRunResult>;
  dispose(): Promise<void>;
}
```

Integration shape:
- Keep existing async command model (`promisify(exec)` / spawn-based command execution) and route through selected backend wrapper.
- `native` backend is default for backward compatibility.
- Backend selected from merged settings + optional per-task prompt override.

### 4.1 Settings proposal (not implemented here)

```yaml
sandbox:
  backend: native | sandbox-exec | bubblewrap | docker | podman | custom
  policy:
    allowNetwork: true
    allowedPaths: []
    writablePaths: []
  failureMode: fail-hard | fallback-native
```

Per-task prompt override example:
- `**Sandbox:** podman`

### 4.2 Audit proposal

Emit run-audit events:
- `sandbox:prepare`
- `sandbox:run`
- `sandbox:failure`
- `sandbox:fallback`

Include `taskId`, `runId`, backend id, policy hash/summary, and failure reason.

### 4.3 Action-gate / governance proposal

- Reuse `network_api` gating for backends requiring outbound fetch/pull/bootstrap.
- Add optional `sandbox_provision` gate for first-time install/provision actions (container runtime pull/setup, helper binary bootstrap).
- Keep default `native` path ungated to preserve current behavior for existing projects.

### 4.4 Self-healing interaction notes

- Sandbox startup failure should be classified similarly to recoverable/unrecoverable session-start failures:
  - backend missing and `fallback-native` => record fallback + continue.
  - backend missing and `fail-hard` => task failure/pause with explicit reason.
- Must not break worktree liveness invariants; sandbox prepare should consume existing worktree path validated by current worktree-pool logic.
- Stuck-task recovery remains authoritative; sandbox runs must preserve timeout/abort semantics so watchdog and restart recovery can reason about active subprocesses.

## 5) Recommendation

Recommended platform defaults (when backend family is enabled in future work):
- **macOS:** `native` default, optional `sandbox-exec` backend for teams accepting deprecated-but-available Seatbelt CLI behavior.
- **Linux:** `bubblewrap` recommended first non-native backend (best balance of strong fs isolation + low startup + worktree compatibility).
- **Windows:** keep `native` initially; evaluate Windows-native sandboxing/container path in later phase.

Rationale:
- `bubblewrap` is lightweight, namespace-native, and aligns with per-command short-lived executor workflow.
- Container and microVM backends are valuable as optional high-isolation modes but carry higher latency and ops complexity.
- `sandbox-exec` can be an interim macOS hardening option, but deprecation risk means it should not be mandatory default.

## 6) Phased rollout plan

1. **Phase A:** land `SandboxBackend` abstraction + `native` only; no behavior change.
2. **Phase B:** add macOS `sandbox-exec` backend behind explicit opt-in.
3. **Phase C:** add Linux `bubblewrap` backend with policy templates for Fusion workloads.
4. **Phase D:** optional container backend (`podman` first, `docker` optional) for stronger but heavier isolation.
5. **Phase E:** docs, telemetry dashboards, and hardening guidance; then consider default changes.

## 7) Follow-up tasks and open questions

### Follow-up implementation tasks (created from this research)

- Add SandboxBackend abstraction and native passthrough backend (depends on FN-4635)
- Implement macOS sandbox-exec backend with policy templates + fallback behavior (depends on abstraction task)
- Implement Linux bubblewrap backend with path/network policy adapter (depends on abstraction task)
- Add sandbox settings schema + prompt override parsing + validation (depends on abstraction task)
- Add sandbox run-audit events and dashboard visibility for sandbox telemetry (depends on abstraction task)
- Add action-gate support for sandbox provisioning/privileged backend setup (depends on abstraction task)

### Open questions

- Should sandboxing apply only to executor command lanes, or also merger verification commands/workflow post-merge scripts?
- Is network default **allow** acceptable, with explicit deny profiles, or should stricter defaults be project-specific?
- Should fallback from sandbox to native be allowed by default, or require explicit `failureMode=fallback-native`?
- Are teams willing to accept `sandbox-exec` deprecation risk on macOS, or should macOS remain native until another path exists?
- Should container backends be first-class, or treated as external/custom backend plugins only?
- For Windows support, do we target native isolation primitives first or container runtime parity?