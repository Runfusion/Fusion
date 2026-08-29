import { describe, expect, it } from "vitest";
import type { Credential } from "../cli-press-types.js";
import { applyCredentialToRequest, decodeCredentialValue, encodeCredentialValue } from "../credentials.js";

function baseCredential(partial: Partial<Credential>): Credential {
  return {
    id: "cred_1",
    serviceId: "svc_1",
    name: "cred",
    kind: "header",
    value: encodeCredentialValue("secret"),
    placement: { kind: "header", header: "X-Custom-Token" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  } as Credential;
}

describe("credentials", () => {
  it("encodes and decodes", () => {
    const encoded = encodeCredentialValue("alice:s3cret");
    expect(encoded.encoding).toBe("base64");
    expect(decodeCredentialValue(encoded)).toBe("alice:s3cret");
  });

  it("applies all credential kinds", () => {
    const request = { headers: {}, query: {}, env: {} };

    applyCredentialToRequest(baseCredential({ kind: "header", placement: { kind: "header", header: "X-Custom-Token" } }), request);
    applyCredentialToRequest(baseCredential({ kind: "query_param", placement: { kind: "query_param", queryParam: "api_token" } }), request);
    applyCredentialToRequest(baseCredential({ kind: "env_var", placement: { kind: "env_var", envVar: "GITHUB_TOKEN" } }), request);
    applyCredentialToRequest(baseCredential({ kind: "bearer_token", placement: { kind: "bearer_token", header: "Authorization" } }), request);
    applyCredentialToRequest(baseCredential({ kind: "api_key", placement: { kind: "api_key", header: "X-API-Key" } }), request);
    applyCredentialToRequest(baseCredential({ kind: "api_key", placement: { kind: "api_key", queryParam: "api_key" } }), request);
    applyCredentialToRequest(
      baseCredential({
        kind: "basic_auth",
        value: encodeCredentialValue("alice:s3cret"),
        placement: { kind: "basic_auth", header: "Authorization" },
      }),
      request,
    );

    expect(request.headers["X-Custom-Token"]).toBe("secret");
    expect(request.query.api_token).toBe("secret");
    expect(request.env.GITHUB_TOKEN).toBe("secret");
    expect(request.headers.Authorization).toBe("Basic YWxpY2U6czNjcmV0");
    expect(request.headers["X-API-Key"]).toBe("secret");
    expect(request.query.api_key).toBe("secret");
  });

  it("throws on placement mismatch and oauth", () => {
    const request = { headers: {}, query: {}, env: {} };
    expect(() =>
      applyCredentialToRequest(baseCredential({ kind: "header", placement: { kind: "query_param", queryParam: "x" } as any }), request),
    ).toThrow("Invalid credential placement");

    expect(() =>
      applyCredentialToRequest(baseCredential({ kind: "oauth" as any, placement: { kind: "oauth", header: "Authorization" } as any }), request),
    ).toThrow("not supported");
  });
});
