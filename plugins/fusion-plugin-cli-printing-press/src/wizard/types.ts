export type CredentialPattern =
  | { kind: "none" }
  | { kind: "apiKey"; header: string; envVar: string }
  | { kind: "bearerToken"; envVar: string }
  | { kind: "basicAuth"; usernameEnvVar: string; passwordEnvVar: string };
// TODO(FN-3762/FN-3766): OAuth credential variants.

export interface ServiceEndpoint {
  id: string;
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary?: string;
  params?: string;
}

export interface ServiceDraft {
  id: string;
  name: string;
  slug: string;
  description: string;
  baseUrl: string;
  transport: "http";
  endpoints: ServiceEndpoint[];
  credential: CredentialPattern;
  createdAt: string;
  updatedAt: string;
  regeneratedAt?: string;
  generatedAt?: string;
  artifactPath?: string;
}

export type WizardStep = "basics" | "transport" | "endpoints" | "credentials" | "review";
