/*
FNXC:ProviderAuth 2026-07-07-08:20:
FN-7630 (GitHub #1931) item 3 coordination: the Hermes Runtime connection
must never CAUSE the /api/auth/status provider surface to shrink. The
static-catalog rewrite of that surface is owned by FN-7625 (still in
Planning as of this task) and is intentionally NOT reimplemented here. This
suite proves the narrower, in-scope invariant: given the exact same
AuthStorage-reported provider set, register-auth-routes.ts's /auth/status
handler enumerates every entry storage.getOAuthProviders()/getApiKeyProviders()
report — regardless of whether a Hermes-labeled entry is present alongside
them — so a connected Hermes runtime contributing its own provider entry can
only ever ADD to the response, never remove sibling entries.
*/
import { describe, expect, it, vi } from "vitest";
import type { Router } from "express";
import { registerAuthRoutes } from "../routes/register-auth-routes.js";

function setup(oauthProviders: Array<{ id: string; name: string }>, apiKeyProviders: Array<{ id: string; name: string }>) {
  const getHandlers = new Map<string, (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>>();
  const postHandlers = new Map<string, unknown>();
  const router = {
    get: vi.fn((path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) => {
      getHandlers.set(path, handler);
    }),
    post: vi.fn((path: string, handler: unknown) => {
      postHandlers.set(path, handler);
    }),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as Router;

  const authStorage = {
    reload: vi.fn(),
    getOAuthProviders: vi.fn(() => oauthProviders),
    getApiKeyProviders: vi.fn(() => apiKeyProviders),
    hasAuth: vi.fn(() => false),
    hasApiKey: vi.fn(() => false),
    get: vi.fn(() => undefined),
  };

  const rethrowAsApiError = (err: unknown) => {
    throw err;
  };

  registerAuthRoutes({
    router,
    // No `store` — this test deliberately isolates the AuthStorage-derived
    // provider surface (getOAuthProviders/getApiKeyProviders) from the
    // settings-toggle-gated synthetic CLI providers (claude-cli/droid-cli/
    // cursor-cli/llama-cpp), which are covered elsewhere and are not part of
    // the Hermes-connection question.
    store: undefined,
    options: { authStorage },
    getScopedStore: vi.fn(),
    rethrowAsApiError,
  } as never);

  return { handler: getHandlers.get("/auth/status")!, authStorage };
}

async function callStatus(handler: (req: unknown, res: { json: (body: unknown) => void }) => Promise<void>) {
  const json = vi.fn();
  await handler({ headers: {} }, { json });
  return json.mock.calls[0][0] as { providers: Array<{ id: string; name: string }> };
}

describe("FN-7630: Hermes runtime additive — /api/auth/status", () => {
  it("does not shrink the enumerated provider surface when a Hermes-labeled entry is present", async () => {
    const baselineOauth = [{ id: "github-copilot", name: "GitHub Copilot" }];
    const baselineApiKey = [{ id: "openai", name: "OpenAI" }];

    const disconnected = setup(baselineOauth, baselineApiKey);
    const disconnectedResponse = await callStatus(disconnected.handler);

    // Simulate a connected Hermes runtime by having AuthStorage report an
    // additional "hermes" provider entry alongside the exact same baseline —
    // this is what a live runtime plugin contributing its own auth surface
    // would look like from register-auth-routes.ts's perspective.
    const connected = setup(
      [...baselineOauth],
      [...baselineApiKey, { id: "hermes", name: "Hermes" }],
    );
    const connectedResponse = await callStatus(connected.handler);

    const disconnectedIds = disconnectedResponse.providers.map((p) => p.id);
    const connectedIds = connectedResponse.providers.map((p) => p.id);

    // Every provider present without Hermes must still be present with Hermes.
    for (const id of disconnectedIds) {
      expect(connectedIds).toContain(id);
    }
    expect(connectedIds.length).toBeGreaterThanOrEqual(disconnectedIds.length);
  });

  it("preserves all baseline oauth + api-key providers across both states (empty vs populated Hermes entry)", async () => {
    const oauth = [{ id: "anthropic-subscription", name: "Anthropic" }];
    const apiKeyNoHermes = [{ id: "openai", name: "OpenAI" }, { id: "google", name: "Google" }];
    const apiKeyWithHermes = [...apiKeyNoHermes, { id: "hermes", name: "Hermes" }];

    const withoutHermes = await callStatus(setup(oauth, apiKeyNoHermes).handler);
    const withHermes = await callStatus(setup(oauth, apiKeyWithHermes).handler);

    for (const id of ["anthropic-subscription", "openai", "google"]) {
      expect(withoutHermes.providers.some((p) => p.id === id)).toBe(true);
      expect(withHermes.providers.some((p) => p.id === id)).toBe(true);
    }
  });
});
