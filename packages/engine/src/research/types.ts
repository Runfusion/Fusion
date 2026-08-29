import type { ResearchProviderConfig as CoreResearchProviderConfig } from "@fusion/core";

export type ResearchProviderType =
  | "web-search"
  | "page-fetch"
  | "github"
  | "local-docs"
  | "llm-synthesis";

/**
 * Provider config bag for research providers.
 * Extends core orchestration config with provider-specific optional fields.
 */
export interface ResearchProviderConfig extends CoreResearchProviderConfig {
  [key: string]: unknown;
}

export type ResearchProviderErrorCode =
  | "timeout"
  | "abort"
  | "provider-unavailable"
  | "rate-limited"
  | "auth-failed"
  | "network-error";

export class ResearchProviderError extends Error {
  readonly providerType: ResearchProviderType;
  readonly code: ResearchProviderErrorCode;
  readonly retryable: boolean;

  constructor(options: {
    providerType: ResearchProviderType;
    code: ResearchProviderErrorCode;
    message: string;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause ? { cause: options.cause } : undefined);
    this.name = "ResearchProviderError";
    this.providerType = options.providerType;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export interface ResearchFetchResult {
  content: string;
  metadata: Record<string, unknown>;
  mimeType?: string;
}
