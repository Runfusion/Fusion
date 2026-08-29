/**
 * Pure policy for the reserved-port discovery probe (U3).
 *
 * Extracted from vitest-setup.ts so it can be unit-tested with stubbed env,
 * without importing the setup file (which has top-level await + global side
 * effects and would run a real port probe on import).
 *
 * IMPORTANT: this conditions only the *discovery* probe — the kill-guard
 * wrapper in vitest-setup.ts always keeps 4040 and any explicitly-declared
 * ports in its block-set. Skipping discovery in CI never weakens the guard;
 * there is simply no live dashboard to discover there.
 */

export function parsePortList(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65_536);
}

/**
 * Whether the per-worker 4040–4045 fetch probe should run.
 *
 *  - FUSION_TEST_SKIP_PORT_PROBE=1 always skips (existing escape hatch).
 *  - In CI (CI=true) the probe is skipped UNLESS FUSION_RESERVED_PORTS is set,
 *    which signals an intentional live service worth guarding even there.
 *  - Locally the probe always runs (unchanged behavior).
 */
export function shouldRunPortProbe(env: NodeJS.ProcessEnv): boolean {
  if (env.FUSION_TEST_SKIP_PORT_PROBE === "1") return false;
  const hasExplicitReservedPorts = parsePortList(env.FUSION_RESERVED_PORTS).length > 0;
  if (env.CI === "true" && !hasExplicitReservedPorts) return false;
  return true;
}

/**
 * The static reserved-port set derived from env only (no I/O). 4040 is always
 * included; FUSION_RESERVED_PORTS / PORT / FUSION_SERVER_PORT add more.
 */
export function resolveReservedPortsFromEnv(env: NodeJS.ProcessEnv): Set<number> {
  const reserved = new Set<number>([4040]);
  for (const port of parsePortList(env.FUSION_RESERVED_PORTS)) reserved.add(port);
  for (const port of parsePortList(env.PORT)) reserved.add(port);
  for (const port of parsePortList(env.FUSION_SERVER_PORT)) reserved.add(port);
  return reserved;
}
