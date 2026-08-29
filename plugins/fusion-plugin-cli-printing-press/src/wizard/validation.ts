import type { CredentialPattern, ServiceDraft, ServiceEndpoint } from "./types.js";

type Ok = { ok: true };
type Fail = { ok: false; errors: Record<string, string> };
export type ValidationResult = Ok | Fail;

const SLUG_PATTERN = /^[a-z0-9-]+$/;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function fail(errors: Record<string, string>): Fail {
  return { ok: false, errors };
}

export function validateBasics(draft: ServiceDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = "Name is required";
  if (!SLUG_PATTERN.test(draft.slug)) errors.slug = "Slug must use lowercase letters, numbers, and single hyphens";
  if (!draft.baseUrl.trim()) {
    errors.baseUrl = "Base URL is required";
  } else {
    try { new URL(draft.baseUrl); } catch { errors.baseUrl = "Base URL must be a valid URL"; }
  }
  return Object.keys(errors).length ? fail(errors) : { ok: true };
}

export function validateTransport(draft: ServiceDraft): ValidationResult {
  return draft.transport === "http" ? { ok: true } : fail({ transport: "Only HTTP transport is supported in v1" });
}

function validateEndpoint(endpoint: ServiceEndpoint, index: number): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!endpoint.name.trim()) errors[`endpoints.${index}.name`] = "Endpoint name is required";
  if (!METHODS.has(endpoint.method)) errors[`endpoints.${index}.method`] = "HTTP method is invalid";
  if (!endpoint.path.trim()) errors[`endpoints.${index}.path`] = "Endpoint path is required";
  return errors;
}

export function validateEndpoints(draft: ServiceDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (draft.endpoints.length < 1) errors.endpoints = "At least one endpoint is required";
  draft.endpoints.forEach((endpoint, index) => Object.assign(errors, validateEndpoint(endpoint, index)));
  return Object.keys(errors).length ? fail(errors) : { ok: true };
}

export function validateCredentials(credential: CredentialPattern): ValidationResult {
  const errors: Record<string, string> = {};
  if (credential.kind === "apiKey") {
    if (!credential.header.trim()) errors.header = "Header is required";
    if (!credential.envVar.trim()) errors.envVar = "Environment variable is required";
  }
  if (credential.kind === "bearerToken" && !credential.envVar.trim()) errors.envVar = "Environment variable is required";
  if (credential.kind === "basicAuth") {
    if (!credential.usernameEnvVar.trim()) errors.usernameEnvVar = "Username env var is required";
    if (!credential.passwordEnvVar.trim()) errors.passwordEnvVar = "Password env var is required";
  }
  return Object.keys(errors).length ? fail(errors) : { ok: true };
}

export function validateDraft(draft: ServiceDraft): ValidationResult {
  const validations = [validateBasics(draft), validateTransport(draft), validateEndpoints(draft), validateCredentials(draft.credential)];
  const errors = validations.filter((r): r is Fail => !r.ok).reduce((acc, item) => ({ ...acc, ...item.errors }), {});
  return Object.keys(errors).length ? fail(errors) : { ok: true };
}
