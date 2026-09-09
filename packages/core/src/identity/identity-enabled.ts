/*
FNXC:Identity 2026-08-09-03:04:
The `identity.enabled` gate, as a process-level flag.

U5 owns the durable, daemon-global setting; this module is the in-process mirror it will drive, and
the only thing U3 needs. It exists now because U3 inverts `resolveFusionSessionPrincipal`'s
unregistered-cwd default (KTD16) and that inversion MUST be gated: the operator-as-absence default
is load-bearing for human CLI pass-through, and its replacement is U11's CLI credential — three
phases away. Inverting ungated here would deny human CLI users for those three phases.

Daemon-global, never per-project (KTD20/U5): one daemon serves N projects from a shared database
while actors and sessions are global, so a per-project switch would let an actor denied in project A
operate freely in project B. The specific consumer here is process-level and cannot be scoped per
project at all.

Stored on `globalThis` for the same reason `session-identity-registry.ts` is: core is inlined
separately into the CLI bundle and the engine, so ordinary module state is NOT shared between the
process that would set the flag and the process that reads it. Defaults to `false` so an install
that has not enabled identity behaves exactly as it does today.
*/

const IDENTITY_ENABLED_KEY = "__FUSION_IDENTITY_ENABLED_V1__";

/** True when the identity model is enabled for this daemon. Defaults to `false`. */
export function isIdentityEnabled(): boolean {
  return (globalThis as Record<string, unknown>)[IDENTITY_ENABLED_KEY] === true;
}

/**
 * Set the in-process gate. U5 calls this from the durable daemon-global setting on startup and on
 * change; nothing else should, and no code path may derive the value from a project setting.
 */
export function setIdentityEnabled(enabled: boolean): void {
  (globalThis as Record<string, unknown>)[IDENTITY_ENABLED_KEY] = enabled === true;
}

/** Test-only: reset to the shipped default (isolated vitest workers share globalThis). */
export function __resetIdentityEnabledForTests(): void {
  (globalThis as Record<string, unknown>)[IDENTITY_ENABLED_KEY] = false;
}
