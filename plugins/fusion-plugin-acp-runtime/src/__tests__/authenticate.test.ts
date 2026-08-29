import { describe, expect, it, vi } from "vitest";
import { AcpAuthRequiredError, authenticateAcpConnection } from "../provider.js";

describe("authenticateAcpConnection", () => {
  it("selects the first preferred method the agent advertised", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    const result = await authenticateAcpConnection(
      {
        conn: { authenticate } as never,
        authMethods: [{ id: "cached_token" }, { id: "grok.com" }],
      },
      {
        preferMethods: ["xai.api_key", "cached_token"],
        meta: { headless: true },
      },
    );
    expect(result).toEqual({ methodId: "cached_token" });
    expect(authenticate).toHaveBeenCalledWith({
      methodId: "cached_token",
      _meta: { headless: true },
    });
  });

  it("prefers xai.api_key when advertised", async () => {
    const authenticate = vi.fn().mockResolvedValue({});
    const result = await authenticateAcpConnection(
      {
        conn: { authenticate } as never,
        authMethods: [{ id: "xai.api_key" }, { id: "cached_token" }],
      },
      { preferMethods: ["xai.api_key", "cached_token"] },
    );
    expect(result).toEqual({ methodId: "xai.api_key" });
  });

  it("no-ops when no method matches and require is false", async () => {
    const authenticate = vi.fn();
    const result = await authenticateAcpConnection(
      {
        conn: { authenticate } as never,
        authMethods: [{ id: "grok.com" }],
      },
      { preferMethods: ["xai.api_key", "cached_token"], require: false },
    );
    expect(result).toBeUndefined();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("throws AcpAuthRequiredError when require is true and no method matches", async () => {
    await expect(
      authenticateAcpConnection(
        {
          conn: { authenticate: vi.fn() } as never,
          authMethods: [{ id: "grok.com" }],
        },
        { preferMethods: ["cached_token"], require: true },
      ),
    ).rejects.toBeInstanceOf(AcpAuthRequiredError);
  });
});
