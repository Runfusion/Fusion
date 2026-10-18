export const PG_SETUP_PARTICIPATION_ENV = "FUSION_PG_TEST_SETUP_PARTICIPANT";

export type PgSetupParticipationReason = "enabled" | "skip-requested" | "not-opted-in";
export type PgSetupParticipation =
  | { participating: true; reason: "enabled" }
  | { participating: false; reason: Exclude<PgSetupParticipationReason, "enabled"> };

/** A lazy setup callback keeps non-participating Vitest lanes connectionless. */
export type PgSetupPreflight = () => Promise<void>;

const PG_TIMEOUT_BOUNDARY_OBSERVER_ENV_PREFIX = "FUSION_PG_TEST_TIMEOUT_BOUNDARY_OBSERVER";

/**
 * FNXC:PgTestPreAdmission 2026-08-17-03:20:
 * FN-9139 requires every package sharing Vitest setup to remain inert unless a
 * PostgreSQL lane explicitly opts in. This resolver is deliberately pure and
 * env-resolvable rather than config-only: importing the harness would perform
 * its TCP reachability probe and tax non-participant lanes.
 */
export function resolvePgSetupParticipation(
  env: NodeJS.ProcessEnv = process.env,
): PgSetupParticipation {
  if (env.FUSION_PG_TEST_SKIP === "1") return { participating: false, reason: "skip-requested" };
  return env[PG_SETUP_PARTICIPATION_ENV] === "1"
    ? { participating: true, reason: "enabled" }
    : { participating: false, reason: "not-opted-in" };
}

/*
FNXC:PgGatePrebuild 2026-10-18-00:28:
FN-9563 moves the run-shared golden-template build ahead of forked beforeAll
hooks. The global setup must invoke it only for the explicit PostgreSQL lane;
other core lanes must not load the harness or open PostgreSQL connections.
*/
export async function runPgSetupPreflight(
  prepareGoldenTemplate: PgSetupPreflight,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PgSetupParticipation> {
  const participation = resolvePgSetupParticipation(env);
  if (participation.participating) await prepareGoldenTemplate();
  return participation;
}

/*
FNXC:PgGateRootTopology 2026-10-18-00:35:
FN-9563 found Vitest's explicit PG-lane environment did not carry parent
observer settings into forked canary workers. Forward only observer controls so
the root-topology driver records both real bodies without passing credentials or
unrelated host state through the test config.
*/
export function collectPgTimeoutBoundaryObserverEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) =>
      (key === PG_TIMEOUT_BOUNDARY_OBSERVER_ENV_PREFIX
        || key.startsWith(`${PG_TIMEOUT_BOUNDARY_OBSERVER_ENV_PREFIX}_`))
      && typeof value === "string",
    ),
  );
}
