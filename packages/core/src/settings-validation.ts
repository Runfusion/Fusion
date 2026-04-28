import type { UnavailableNodePolicy } from "./types.js";

const UNAVAILABLE_NODE_POLICIES: readonly UnavailableNodePolicy[] = ["block", "fallback-local"] as const;

/**
 * Validates a project unavailable-node routing policy value.
 *
 * Returns the normalized policy value when valid, otherwise undefined.
 */
export function validateUnavailableNodePolicy(value: unknown): UnavailableNodePolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  return (UNAVAILABLE_NODE_POLICIES as readonly string[]).includes(value)
    ? (value as UnavailableNodePolicy)
    : undefined;
}
