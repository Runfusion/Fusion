import { describe, expect, it } from "vitest";
import { BUILT_IN_API_KEY_PROVIDERS } from "@fusion/engine";
import { STATIC_API_KEY_PROVIDER_CATALOG } from "../routes/auth-provider-catalog";

describe("static API-key provider catalog", () => {
  it("matches the engine's executable built-in API-key provider IDs", () => {
    expect([...STATIC_API_KEY_PROVIDER_CATALOG.map(({ id }) => id)].sort()).toEqual(
      [...BUILT_IN_API_KEY_PROVIDERS.map(({ id }) => id)].sort(),
    );
  });
});
