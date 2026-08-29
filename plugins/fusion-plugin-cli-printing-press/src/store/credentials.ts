import { Buffer } from "node:buffer";
import type { Credential, EncodedCredentialValue } from "./cli-press-types.js";
import { InvalidCredentialPlacementError, OAuthNotSupportedError } from "./cli-press-types.js";

export type RequestShape = {
  headers: Record<string, string>;
  query: Record<string, string>;
  env: Record<string, string>;
};

export function encodeCredentialValue(raw: string): EncodedCredentialValue {
  return {
    encoding: "base64",
    value: Buffer.from(raw, "utf8").toString("base64"),
  };
}

export function decodeCredentialValue(encoded: EncodedCredentialValue): string {
  if (encoded.encoding !== "base64") {
    throw new Error(`Unsupported credential encoding: ${String((encoded as { encoding?: string }).encoding)}`);
  }
  return Buffer.from(encoded.value, "base64").toString("utf8");
}

function assertNoOAuth(kind: string): void {
  if (kind === "oauth" || kind === "oauth2") {
    throw new OAuthNotSupportedError(kind);
  }
}

function assertPlacement(credential: Credential): void {
  const credentialKind = credential.kind;
  const placementKind = credential.placement.kind;
  if (placementKind !== credentialKind) {
    throw new InvalidCredentialPlacementError({ credentialKind, placementKind });
  }
  if (credential.kind === "api_key") {
    const placement = credential.placement;
    if (placement.kind !== "api_key") {
      throw new InvalidCredentialPlacementError({ credentialKind, placementKind });
    }
    const hasHeader = typeof placement.header === "string" && placement.header.trim().length > 0;
    const hasQuery = typeof placement.queryParam === "string" && placement.queryParam.trim().length > 0;
    if ((hasHeader ? 1 : 0) + (hasQuery ? 1 : 0) !== 1) {
      throw new InvalidCredentialPlacementError({ credentialKind, placementKind });
    }
  }
}

export function applyCredentialToRequest(credential: Credential, request: RequestShape): RequestShape {
  assertNoOAuth((credential as { kind: string }).kind);
  assertPlacement(credential);

  const value = decodeCredentialValue(credential.value);

  switch (credential.kind) {
    case "header": {
      const placement = credential.placement as { kind: "header"; header: string };
      request.headers[placement.header] = value;
      break;
    }
    case "query_param": {
      const placement = credential.placement as { kind: "query_param"; queryParam: string };
      request.query[placement.queryParam] = value;
      break;
    }
    case "env_var": {
      const placement = credential.placement as { kind: "env_var"; envVar: string };
      request.env[placement.envVar] = value;
      break;
    }
    case "bearer_token": {
      const placement = credential.placement as { kind: "bearer_token"; header: string };
      request.headers[placement.header] = `Bearer ${value}`;
      break;
    }
    case "api_key": {
      const placement = credential.placement as { kind: "api_key"; header?: string; queryParam?: string };
      if (placement.header) {
        request.headers[placement.header] = value;
      } else if (placement.queryParam) {
        request.query[placement.queryParam] = value;
      }
      break;
    }
    case "basic_auth": {
      const placement = credential.placement as { kind: "basic_auth"; header: string };
      const basicAuth = Buffer.from(value, "utf8").toString("base64");
      request.headers[placement.header] = `Basic ${basicAuth}`;
      break;
    }
  }

  return request;
}
