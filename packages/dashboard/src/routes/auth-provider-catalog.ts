/**
 * Static supported-provider catalog for the Authentication settings page.
 *
 * FNXC:ProviderAuth 2026-07-07-00:00:
 * FN-7625: the Authentication page (Settings → Authentication) must render a
 * fixed catalog of every provider Fusion supports, independent of which pi
 * runtime plugins are currently connected. `GET /api/auth/status` previously
 * enumerated providers straight from pi `AuthStorage`'s *live* runtime
 * registry (`storage.getOAuthProviders()` / `storage.getApiKeyProviders()`).
 * That registry is mutable at runtime — a connected runtime plugin (Hermes
 * Runtime, Paperclip, OpenClaw, Droid Runtime, ...) can narrow it, which
 * collapsed the visible provider list the moment such a plugin connected,
 * hiding providers Fusion otherwise fully supports.
 *
 * The fix: presence in `/auth/status`'s `providers` array must come from this
 * static catalog UNIONED with whatever storage reports — never an
 * intersection with runtime state. A provider's *status* (authenticated /
 * expired / keyHint) is still read live from storage per request; only its
 * *presence* in the list is made deterministic.
 *
 * Sourcing note: this mirrors two existing canonical lists that dashboard
 * cannot import directly —
 *   - OAuth: pi-ai's built-in OAuth provider registry (anthropic,
 *     github-copilot, openai-codex — see `@earendil-works/pi-ai`'s
 *     `utils/oauth/index.ts` `BUILT_IN_OAUTH_PROVIDERS`), which is not
 *     exported as a public catalog.
 *   - API key: `packages/cli/src/commands/provider-auth.ts`'s
 *     `BUILT_IN_API_KEY_PROVIDERS`, the existing canonical list used to
 *     synthesize `getApiKeyProviders()` for the CLI/dashboard auth wrapper.
 *     `packages/cli` depends on `packages/dashboard` (not the reverse), so
 *     importing it here would introduce a circular workspace dependency.
 * Kept as a small hand-maintained mirror; update alongside
 * `provider-auth.ts`'s `BUILT_IN_API_KEY_PROVIDERS` when providers are
 * added/removed there. The synthetic CLI providers (`claude-cli`,
 * `droid-cli`, `cursor-cli`, `llama-cpp`) are NOT part of this catalog — they
 * stay on their existing dedicated injection path in
 * `register-auth-routes.ts`.
 */

export interface AuthProviderCatalogEntry {
  id: string;
  name: string;
}

/** Static catalog of OAuth-backed providers Fusion supports. */
export const STATIC_OAUTH_PROVIDER_CATALOG: AuthProviderCatalogEntry[] = [
  // Raw upstream id; toAuthStatusProvider() maps this to the synthetic
  // `anthropic-subscription` UI id so it never collides with the
  // `anthropic-api-key` API-key card.
  { id: "anthropic", name: "Anthropic (Claude Pro/Max)" },
  { id: "github-copilot", name: "GitHub Copilot" },
  { id: "openai-codex", name: "OpenAI (ChatGPT Plus/Pro)" },
];

/** Static catalog of API-key-backed providers Fusion supports. */
export const STATIC_API_KEY_PROVIDER_CATALOG: AuthProviderCatalogEntry[] = [
  { id: "anthropic-api-key", name: "Anthropic API Key" },
  { id: "brave", name: "Brave Search" },
  { id: "kimi-coding", name: "Kimi" },
  { id: "minimax", name: "Minimax" },
  { id: "openrouter", name: "OpenRouter" },
  { id: "orcarouter", name: "OrcaRouter" },
  { id: "opencode-go", name: "Opencode (Go)" },
  { id: "tavily", name: "Tavily" },
  { id: "zai", name: "Zai" },
];

/**
 * Union a static catalog with a live/runtime-reported provider list, keyed
 * by id. Catalog entries always survive regardless of what `runtime`
 * contains (never an intersection); a runtime-reported provider whose id is
 * NOT in the catalog still surfaces (a genuinely new upstream provider must
 * not be dropped). When both sides report the same id, the runtime-reported
 * `name` wins (it reflects the live registry's current display name), while
 * the catalog still guarantees the id's presence.
 */
export function unionProviderCatalog(
  catalog: AuthProviderCatalogEntry[],
  runtime: AuthProviderCatalogEntry[],
): AuthProviderCatalogEntry[] {
  const byId = new Map<string, AuthProviderCatalogEntry>();
  for (const entry of catalog) {
    byId.set(entry.id, entry);
  }
  const extras: AuthProviderCatalogEntry[] = [];
  for (const entry of runtime) {
    if (byId.has(entry.id)) {
      byId.set(entry.id, entry);
    } else {
      extras.push(entry);
    }
  }
  return [...catalog.map((entry) => byId.get(entry.id) ?? entry), ...extras];
}
