export const PG_SETUP_PARTICIPATION_ENV = "FUSION_PG_TEST_SETUP_PARTICIPANT";

export type PgSetupParticipationReason = "enabled" | "skip-requested" | "not-opted-in";
export type PgSetupParticipation =
  | { participating: true; reason: "enabled" }
  | { participating: false; reason: Exclude<PgSetupParticipationReason, "enabled"> };

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
