import { ANTHROPIC_SUBSCRIPTION_PROVIDER_ID } from "../provider-instance.js";

export const ANTHROPIC_PROVIDER_ID = "anthropic";
export const ANTHROPIC_API_KEY_PROVIDER_ID = "anthropic-api-key";

/*
FNXC:ProviderAuth 2026-08-15-20:57:
Anthropic's subscription and API-key card ids identify credential/auth surfaces, not pi-ai providers. Normalize stale persisted selections before model lookup or runtime session creation so subscription OAuth continues to execute through pi-ai's built-in `anthropic` provider without registering a fake provider.
*/
export function toExecutionModelProviderId(providerId: string): string {
  return providerId === ANTHROPIC_SUBSCRIPTION_PROVIDER_ID || providerId === ANTHROPIC_API_KEY_PROVIDER_ID
    ? ANTHROPIC_PROVIDER_ID
    : providerId;
}
