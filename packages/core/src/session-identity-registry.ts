import { resolve } from "node:path";
import { realpathSync } from "node:fs";

/*
FNXC:SessionIdentity 2026-07-26-12:05:
Security incident follow-up (agent autonomously deleted a live task): pi's
ExtensionContext carries no agent identity, so host-extension (@runfusion/fusion)
tools could never distinguish "human operator at the CLI" from "engine-spawned
agent session" — every destructive fn_* tool ran as an implicit operator.
Engine agent sessions execute IN-PROCESS via pi's DefaultResourceLoader, but the
extension is a separately bundled module (core is inlined into the CLI bundle),
so ordinary module state is NOT shared between engine and extension. globalThis
is the only reliable in-process channel; this registry lives there under a
versioned key.

Trust model: only the engine process can write this registry (agents cannot
reach the engine's globalThis), so a PRESENT entry is authoritative proof that
the cwd belongs to an engine-managed agent session. An ABSENT entry means the
process is an operator-driven CLI (interactive pi), which is the correct
default: a human terminal has no engine registration. Ambiguity (two live
sessions sharing one cwd, e.g. heartbeat lanes at the project root) fails
CLOSED — callers must treat "ambiguous" as an agent principal, never as an
operator.
*/

export interface FusionSessionIdentity {
  /** Acting agent id (permanent or ephemeral runtime id). */
  agentId: string;
  agentName?: string;
  taskId?: string;
  isEphemeral?: boolean;
  /** Session lane, e.g. "executor", "heartbeat", "chat". Diagnostic only. */
  purpose?: string;
  /** Epoch ms at registration; diagnostic only (no TTL semantics). */
  registeredAt: number;
}

export type FusionSessionPrincipal =
  | { kind: "operator" }
  | { kind: "agent"; identity: FusionSessionIdentity }
  | { kind: "ambiguous"; identities: FusionSessionIdentity[] };

const REGISTRY_KEY = "__FUSION_SESSION_IDENTITY_REGISTRY_V1__";

type Registry = Map<string, FusionSessionIdentity[]>;

function getRegistry(): Registry {
  const holder = globalThis as Record<string, unknown>;
  let registry = holder[REGISTRY_KEY] as Registry | undefined;
  if (!(registry instanceof Map)) {
    registry = new Map();
    holder[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * FNXC:SessionIdentity 2026-07-26-12:05:
 * Canonicalize before keying: macOS reports temp worktrees as both /var/... and
 * /private/var/..., and engine/extension may hold either spelling. realpath
 * failures (deleted dir mid-lookup) fall back to resolve() so lookups never
 * throw inside a tool call.
 */
function canonicalizeCwd(cwd: string): string {
  const resolved = resolve(cwd);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Register an engine-owned agent session for a working directory.
 * Returns a dispose function; the engine MUST call it when the session ends,
 * otherwise a later operator CLI in the same cwd would be misclassified as an
 * agent (fail-closed direction, but operator-hostile — so lifetimes matter).
 */
export function registerFusionSessionIdentity(
  cwd: string,
  identity: Omit<FusionSessionIdentity, "registeredAt">,
): () => void {
  const key = canonicalizeCwd(cwd);
  const registry = getRegistry();
  const entry: FusionSessionIdentity = { ...identity, registeredAt: Date.now() };
  const list = registry.get(key) ?? [];
  list.push(entry);
  registry.set(key, list);

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const current = registry.get(key);
    if (!current) return;
    const idx = current.indexOf(entry);
    if (idx >= 0) current.splice(idx, 1);
    if (current.length === 0) registry.delete(key);
  };
}

/**
 * Resolve the acting principal for a session working directory.
 * - No registration → operator (human CLI process; engine never registered it).
 * - Exactly one live registration → that agent.
 * - Multiple registrations → ambiguous; callers must fail CLOSED (treat as
 *   agent, withhold operator-only capabilities).
 */
export function resolveFusionSessionPrincipal(cwd: string): FusionSessionPrincipal {
  const registry = getRegistry();
  const list = registry.get(canonicalizeCwd(cwd));
  if (!list || list.length === 0) {
    return { kind: "operator" };
  }
  if (list.length === 1) {
    return { kind: "agent", identity: list[0] };
  }
  return { kind: "ambiguous", identities: [...list] };
}

/** Test-only: wipe all registrations (isolated vitest workers share globalThis). */
export function __clearFusionSessionIdentityRegistryForTests(): void {
  (globalThis as Record<string, unknown>)[REGISTRY_KEY] = new Map();
}
