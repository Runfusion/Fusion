export type ServiceSourceKind = "openapi" | "manual" | "other";

export type CredentialKind = "api_key" | "bearer_token" | "basic_auth" | "header" | "query_param" | "env_var";

export type CredentialPlacement =
  | { kind: "header"; header: string }
  | { kind: "query_param"; queryParam: string }
  | { kind: "env_var"; envVar: string }
  | { kind: "bearer_token"; header: string }
  | { kind: "api_key"; header?: string; queryParam?: string }
  | { kind: "basic_auth"; header: string };

export type ServiceSettingScope = "runtime" | "wizard" | "metadata";

export interface Service {
  id: string;
  slug: string;
  displayName: string;
  description?: string;
  baseUrl: string;
  sourceKind: ServiceSourceKind;
  sourceRef?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CliSpec {
  id: string;
  serviceId: string;
  name: string;
  version: string;
  generatorVersion: string;
  specJson: string;
  generatedAt?: string;
  status: "draft" | "generated" | "failed";
  lastGenerationError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CliArtifact {
  id: string;
  cliSpecId: string;
  kind: "binary" | "script" | "package";
  path: string;
  executable: boolean;
  checksum?: string;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
}

export interface EncodedCredentialValue {
  encoding: "base64";
  value: string;
}

export interface Credential {
  id: string;
  serviceId: string;
  name: string;
  kind: CredentialKind;
  value: EncodedCredentialValue;
  placement: CredentialPlacement;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceSetting {
  id: string;
  serviceId: string;
  key: string;
  value: string;
  scope: ServiceSettingScope;
  createdAt: string;
  updatedAt: string;
}

export class OAuthNotSupportedError extends Error {
  constructor(kind: string) {
    super(`Credential kind \"${kind}\" is not supported. OAuth/OAuth2 are deferred.`);
    this.name = "OAuthNotSupportedError";
  }
}

export class InvalidCredentialPlacementError extends Error {
  constructor(input: { credentialKind: string; placementKind: string }) {
    super(
      `Invalid credential placement: credential kind \"${input.credentialKind}\" does not match placement kind \"${input.placementKind}\".`,
    );
    this.name = "InvalidCredentialPlacementError";
  }
}

export type ServiceCreateInput = Omit<Service, "id" | "createdAt" | "updatedAt">;
export type ServiceUpdateInput = Partial<Pick<Service, "displayName" | "description" | "baseUrl" | "sourceKind" | "sourceRef">>;

export type CliSpecCreateInput = Omit<CliSpec, "id" | "createdAt" | "updatedAt">;
export type CliSpecUpdateInput = Partial<
  Pick<CliSpec, "name" | "version" | "generatorVersion" | "specJson" | "status" | "lastGenerationError" | "generatedAt">
>;

export type CliArtifactCreateInput = Omit<CliArtifact, "id" | "createdAt" | "updatedAt">;
export type CliArtifactUpdateInput = Partial<Pick<CliArtifact, "path" | "executable" | "checksum" | "sizeBytes">>;

export type CredentialCreateInput = Omit<Credential, "id" | "createdAt" | "updatedAt">;
export type CredentialUpdateInput = Partial<Pick<Credential, "name" | "value" | "placement">>;

export type ServiceSettingCreateInput = Omit<ServiceSetting, "id" | "createdAt" | "updatedAt">;
export type ServiceSettingUpdateInput = Pick<ServiceSetting, "value">;
