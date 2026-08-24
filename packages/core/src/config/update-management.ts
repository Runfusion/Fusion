/*
FNXC:UpdateManagement 2026-08-21-16:37:
A packaged or pinned deployment needs an install-level declaration that updates are externally owned.
`updateCheckEnabled` is per-user and must otherwise be flipped on every host, while a successful
in-app update could silently replace an artifact owned by the staged release pipeline.
*/

export const EXTERNALLY_MANAGED_UPDATES_ENV = "FUSION_UPDATES_EXTERNALLY_MANAGED";

export const EXTERNALLY_MANAGED_UPDATE_MESSAGE =
  "This Fusion install declares updates externally managed via FUSION_UPDATES_EXTERNALLY_MANAGED. " +
  "The in-app updater is intentionally disabled so a self-update cannot bypass this deployment's release process. " +
  "Update this install the way it was deployed.";

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);

/** Resolves the deployment-owned update declaration, failing closed to existing behavior. */
export function resolveUpdatesExternallyManaged(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[EXTERNALLY_MANAGED_UPDATES_ENV];
  return typeof value === "string" && TRUTHY_VALUES.has(value.trim().toLowerCase());
}
