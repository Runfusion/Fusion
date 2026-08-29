export const DEFAULT_PROVIDER_INSTANCE_ID = "default";
export const PROVIDER_INSTANCE_ID_MAX_LENGTH = 64;
export const RESERVED_AUTH_STORAGE_KEYS = ["__fusionDefaultInstances"] as const;
export const ANTHROPIC_SUBSCRIPTION_PROVIDER_ID = "anthropic-subscription";

export type ProviderInstanceRef = { providerId: string; instanceId: string };

export function isReservedAuthStorageKey(key: string): boolean {
  return (RESERVED_AUTH_STORAGE_KEYS as readonly string[]).includes(key);
}

export function isDefaultProviderInstance(instanceId: string): boolean {
  return instanceId === DEFAULT_PROVIDER_INSTANCE_ID;
}

export function isValidProviderInstanceId(instanceId: unknown): instanceId is string {
  return typeof instanceId === "string"
    && instanceId.length > 0
    && instanceId.length <= PROVIDER_INSTANCE_ID_MAX_LENGTH
    && !/\s/.test(instanceId)
    && !instanceId.includes("[")
    && !instanceId.includes("]");
}

export function assertValidProviderInstanceId(instanceId: unknown): asserts instanceId is string {
  if (!isValidProviderInstanceId(instanceId)) {
    throw new Error(`Invalid provider instance id: ${String(instanceId)}`);
  }
}

export function isValidProviderId(providerId: unknown): providerId is string {
  return isValidProviderInstanceId(providerId) && !isReservedAuthStorageKey(providerId);
}

export function assertValidProviderId(providerId: unknown): asserts providerId is string {
  if (!isValidProviderId(providerId)) {
    throw new Error(`Invalid or reserved provider id: ${String(providerId)}`);
  }
}

/*
FNXC:ProviderAuth 2026-08-01-04:36:
FN-8651 keeps auth.json compatible by spelling the default instance as a bare provider id and named instances as provider[instance]. Validation makes format and parse exact inverses so legacy APIs cannot write ambiguous raw keys. The reserved defaults record is never a provider because deleting or overwriting metadata would strand credentials.
*/
export function formatProviderInstanceKey(ref: ProviderInstanceRef): string {
  assertValidProviderId(ref.providerId);
  assertValidProviderInstanceId(ref.instanceId);
  return isDefaultProviderInstance(ref.instanceId) ? ref.providerId : `${ref.providerId}[${ref.instanceId}]`;
}

export function parseProviderInstanceKey(key: string): ProviderInstanceRef | undefined {
  if (typeof key !== "string" || key.length === 0) return undefined;
  const open = key.indexOf("[");
  const close = key.indexOf("]");
  const isBare = open === -1 && close === -1;
  const isNamed = open > 0 && close === key.length - 1 && key.indexOf("[", open + 1) === -1 && key.indexOf("]", close + 1) === -1;
  if (!isBare && !isNamed) return undefined;
  const providerId = isBare ? key : key.slice(0, open);
  const instanceId = isBare ? DEFAULT_PROVIDER_INSTANCE_ID : key.slice(open + 1, -1);
  return isValidProviderId(providerId)
    && isValidProviderInstanceId(instanceId)
    && (!isNamed || !isDefaultProviderInstance(instanceId))
    ? { providerId, instanceId }
    : undefined;
}
