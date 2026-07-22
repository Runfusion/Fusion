import type { GlobalSettings, SecretAccessPolicy } from "../types.js";
import { SECRET_ACCESS_POLICIES } from "../types.js";

/** Fallback policy when neither the secret row nor global settings specify one.
 * Uses "prompt" to fail safe by requiring explicit approval before access. */
export const SECRET_ACCESS_POLICY_FALLBACK: SecretAccessPolicy = "prompt";

/** Inputs for secret-policy resolution in priority order:
 * secret row policy -> global default (`secretsAccessPolicy`) -> fallback (`"prompt"`). */
export interface ResolveSecretAccessPolicyInput {
  /** Row-level policy from the secret record. Null/undefined are treated as missing. */
  secretPolicy?: SecretAccessPolicy | null;
  /** Global settings snapshot. May be absent during early bootstrap before settings load. */
  settings?: Pick<GlobalSettings, "secretsAccessPolicy">;
}

/** Effective secret access policy and where it was sourced from.
 * - "auto": allow return of secret value (and downstream audit)
 * - "prompt": require approval flow
 * - "deny": reject without prompting */
export interface ResolveSecretAccessPolicyDecision {
  policy: SecretAccessPolicy;
  source: "secret" | "global-default" | "fallback";
}

/** Runtime guard for secret access policy strings.
 * Accepts only `"auto" | "prompt" | "deny"` and rejects unknown legacy values. */
export function isSecretAccessPolicy(value: unknown): value is SecretAccessPolicy {
  return typeof value === "string" && (SECRET_ACCESS_POLICIES as readonly string[]).includes(value);
}

/** Resolve effective secret access policy in this order:
 * 1) row-level secret policy, 2) global `secretsAccessPolicy`, 3) fallback `"prompt"`.
 * Unknown values are treated as missing and never throw. */
export function resolveSecretAccessPolicy(
  input: ResolveSecretAccessPolicyInput,
): ResolveSecretAccessPolicyDecision {
  if (isSecretAccessPolicy(input.secretPolicy)) {
    return { policy: input.secretPolicy, source: "secret" };
  }

  const globalDefault = input.settings?.secretsAccessPolicy;
  if (isSecretAccessPolicy(globalDefault)) {
    return { policy: globalDefault, source: "global-default" };
  }

  return { policy: SECRET_ACCESS_POLICY_FALLBACK, source: "fallback" };
}
