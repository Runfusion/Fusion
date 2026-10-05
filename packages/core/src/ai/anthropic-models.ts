import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../provider-instance.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_API_KEY_PROVIDER_ID = "anthropic-api-key";

/*
FNXC:ModelCatalog 2026-10-05-02:18:
Pi owns every Pi-backed model row. Fusion only normalizes its credential-card identifiers
so subscription and API-key authentication continue to execute through Pi's Anthropic provider.
*/
export function toExecutionModelProviderId(providerId: string): string {
  return providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID || providerId === ANTHROPIC_API_KEY_PROVIDER_ID
    ? ANTHROPIC_PROVIDER_ID
    : providerId;
}
