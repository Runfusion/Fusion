import { describe, expect, it, vi } from "vitest";
import { requireApiKey } from "../routes/auth.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("requireApiKey", () => {
  it("returns 503 when api key setting is missing", () => {
    const result = requireApiKey({ settings: {}, logger } as any, { headers: {} });
    expect(result).toEqual({ ok: false, response: { status: 503, body: { error: "plugin not configured" } } });
  });

  it("returns 401 when header missing", () => {
    const result = requireApiKey({ settings: { apiKey: "secret" }, logger } as any, { headers: {} });
    expect(result).toEqual({ ok: false, response: { status: 401, body: { error: "unauthorized" } } });
  });

  it("returns 401 when key does not match", () => {
    const result = requireApiKey({ settings: { apiKey: "secret" }, logger } as any, { headers: { authorization: "Bearer nope" } });
    expect(result).toEqual({ ok: false, response: { status: 401, body: { error: "unauthorized" } } });
  });

  it("returns ok on matching key", () => {
    const result = requireApiKey({ settings: { apiKey: "secret" }, logger } as any, { headers: { authorization: "Bearer secret" } });
    expect(result).toEqual({ ok: true });
  });
});
