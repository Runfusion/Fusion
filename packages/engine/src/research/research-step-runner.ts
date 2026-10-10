import type {
  ResearchErrorCode,
  ResearchModelSettings,
  ResearchProviderConfig,
  ResearchRunFailureClass,
  ResearchSource,
  ResearchSynthesisRequest,
  ResearchSynthesisResult,
} from "@fusion/core";
import { createLogger, formatError } from "../logger.js";
import { ResearchProviderError, type ResearchProviderType } from "./types.js";

const log = createLogger("research-step-runner");

const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 120_000;

export class ResearchStepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`${step} timed out after ${timeoutMs}ms`);
    this.name = "ResearchStepTimeoutError";
  }
}

export class ResearchStepAbortError extends Error {
  constructor(step: string) {
    super(`${step} aborted`);
    this.name = "ResearchStepAbortError";
  }
}

export class ResearchStepProviderError extends Error {
  constructor(step: string, message: string) {
    super(`${step} provider error: ${message}`);
    this.name = "ResearchStepProviderError";
  }
}

export interface ResearchProvider {
  readonly type: string;
  search(query: string, options: ResearchProviderConfig, signal?: AbortSignal): Promise<ResearchSource[]>;
  fetchContent(
    url: string,
    options: ResearchProviderConfig,
    signal?: AbortSignal,
  ): Promise<{ content: string; metadata: Record<string, unknown> }>;
  isConfigured(): boolean;
}

export interface ResearchStepFailure {
  code: "provider_not_configured" | "timeout" | "aborted" | "provider_error" | "malformed_response";
  message: string;
  retryable: boolean;
  failureClass: ResearchRunFailureClass;
  errorCode: ResearchErrorCode;
  remediation?: string;
  providerType?: string;
}

export interface ResearchStepResult<T> {
  ok: boolean;
  data?: T;
  error?: ResearchStepFailure;
}

export interface ResearchStepRunnerApi {
  runSourceQuery(
    query: string,
    providerType: string,
    config?: ResearchProviderConfig,
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSource[]>>;
  runContentFetch(
    url: string,
    providerType?: string,
    config?: ResearchProviderConfig,
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<{ content: string; metadata: Record<string, unknown> }>>;
  runSynthesis(
    request: ResearchSynthesisRequest,
    modelSettings?: ResearchModelSettings,
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSynthesisResult>>;
}

export interface ResearchStepRunnerOptions {
  providers?: ResearchProvider[];
  synthesisRunner?: (
    request: ResearchSynthesisRequest,
    modelSettings: ResearchModelSettings,
    signal?: AbortSignal,
  ) => Promise<ResearchSynthesisResult>;
}

/*
FNXC:ResearchFailureDiagnostics 2026-09-28-19:08:
Provider and runtime errors cross one normalization boundary. Returned text is deliberately fixed and bounded so credentials, raw provider payloads, prompts, stacks, and filesystem paths cannot enter persisted research rows or reader responses.
*/
export function normalizeResearchFailure(error: unknown, _step: string): ResearchStepFailure {
  if (error instanceof ResearchStepTimeoutError) {
    return {
      code: "timeout",
      message: "The research provider did not respond before the configured deadline.",
      retryable: true,
      failureClass: "timed_out",
      errorCode: "PROVIDER_TIMEOUT",
      remediation: "Retry the run. If timeouts continue, verify provider availability and the research timeout settings.",
    };
  }
  if (error instanceof ResearchStepAbortError || (error instanceof ResearchProviderError && error.code === "abort")) {
    return {
      code: "aborted",
      message: "The research run was cancelled.",
      retryable: false,
      failureClass: "cancelled",
      errorCode: "RUN_CANCELLED",
    };
  }
  if (error instanceof ResearchProviderError) {
    return normalizeProviderFailure(error.code, error.providerType, error.retryable);
  }
  return {
    code: "provider_error",
    message: "Research failed because of an unexpected internal error.",
    retryable: false,
    failureClass: "internal",
    errorCode: "INTERNAL_ERROR",
    remediation: "Review the sanitized engine diagnostics and verify the configured research providers.",
  };
}

function normalizeProviderFailure(
  code: ResearchProviderError["code"],
  providerType: ResearchProviderType,
  providerRetryable: boolean,
): ResearchStepFailure {
  const common = { providerType };
  switch (code) {
    case "timeout":
      return { ...common, code: "timeout", message: "The research provider did not respond before the configured deadline.", retryable: true, failureClass: "timed_out", errorCode: "PROVIDER_TIMEOUT", remediation: "Retry the run. If timeouts continue, verify provider availability and the research timeout settings." };
    case "abort":
      return { ...common, code: "aborted", message: "The research run was cancelled.", retryable: false, failureClass: "cancelled", errorCode: "RUN_CANCELLED" };
    case "missing-configuration":
      return { ...common, code: "provider_not_configured", message: "The required research provider or model is not configured.", retryable: false, failureClass: "configuration", errorCode: "MISSING_CREDENTIALS", remediation: "Configure the research provider and synthesis model in Settings → Authentication, then start a new run." };
    case "auth-failed":
      return { ...common, code: "provider_error", message: "The research provider rejected authentication or access.", retryable: false, failureClass: "provider_denied", errorCode: "PROVIDER_DENIED", remediation: "Verify the provider credential, account access, and model permissions in Settings → Authentication." };
    case "rate-limited":
      return { ...common, code: "provider_error", message: "The research provider is rate limited or temporarily unavailable.", retryable: true, failureClass: "retryable_transient", errorCode: "RATE_LIMITED", remediation: "Retry later or review provider rate limits." };
    case "network-error":
      return { ...common, code: "provider_error", message: "The research provider is temporarily unreachable.", retryable: true, failureClass: "retryable_transient", errorCode: "PROVIDER_UNAVAILABLE", remediation: "Retry the run after checking provider and network availability." };
    case "malformed-response":
      return { ...common, code: "malformed_response", message: "The research provider returned a response Fusion could not validate.", retryable: false, failureClass: "malformed_response", errorCode: "MALFORMED_RESPONSE", remediation: "Verify the configured provider and model are compatible with research synthesis." };
    case "provider-unavailable":
    default:
      return { ...common, code: "provider_error", message: "The research provider is unavailable.", retryable: providerRetryable, failureClass: providerRetryable ? "retryable_transient" : "non_retryable", errorCode: "PROVIDER_UNAVAILABLE", remediation: providerRetryable ? "Retry the run after checking provider availability." : "Verify the provider and model configuration in Settings → Authentication." };
  }
}

export class ResearchStepRunner implements ResearchStepRunnerApi {
  private readonly providers: Map<string, ResearchProvider>;
  private readonly synthesisRunner?: ResearchStepRunnerOptions["synthesisRunner"];

  constructor(options: ResearchStepRunnerOptions = {}) {
    this.providers = new Map((options.providers ?? []).map((provider) => [provider.type, provider]));
    this.synthesisRunner = options.synthesisRunner;
  }

  async runSourceQuery(
    query: string,
    providerType: string,
    config: ResearchProviderConfig = {},
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSource[]>> {
    const provider = this.providers.get(providerType);
    if (!provider || !provider.isConfigured()) {
      return this.unconfigured(`provider ${providerType} is not configured`);
    }

    try {
      const data = await this.withTimeout(
        `source-query:${providerType}`,
        provider.search(query, config, signal),
        config.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS,
        signal,
      );
      return { ok: true, data };
    } catch (error) {
      return this.classifyError("source-query", error);
    }
  }

  async runContentFetch(
    url: string,
    providerType?: string,
    config: ResearchProviderConfig = {},
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<{ content: string; metadata: Record<string, unknown> }>> {
    const provider = this.resolveContentProvider(providerType);
    if (!provider) {
      return this.unconfigured("no configured provider available for content fetch");
    }

    try {
      const data = await this.withTimeout(
        `content-fetch:${provider.type}`,
        provider.fetchContent(url, config, signal),
        config.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
        signal,
      );
      return { ok: true, data };
    } catch (error) {
      return this.classifyError("content-fetch", error);
    }
  }

  async runSynthesis(
    request: ResearchSynthesisRequest,
    modelSettings: ResearchModelSettings = {},
    signal?: AbortSignal,
  ): Promise<ResearchStepResult<ResearchSynthesisResult>> {
    if (!this.synthesisRunner) {
      return this.unconfigured("synthesis provider is not configured");
    }

    try {
      const timeoutMs = modelSettings.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS;
      const data = await this.withTimeout(
        "synthesis",
        this.synthesisRunner(request, modelSettings, signal),
        timeoutMs,
        signal,
      );
      return { ok: true, data };
    } catch (error) {
      return this.classifyError("synthesis", error);
    }
  }

  private findFirstConfiguredProvider(): ResearchProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.isConfigured()) return provider;
    }
    return undefined;
  }

  private resolveContentProvider(providerType?: string): ResearchProvider | undefined {
    if (providerType) {
      const selected = this.providers.get(providerType);
      if (selected?.isConfigured()) return selected;
    }
    return this.findFirstConfiguredProvider();
  }

  private classifyError<T>(step: string, error: unknown): ResearchStepResult<T> {
    const failure = normalizeResearchFailure(error, step);
    const { detail } = formatError(error);
    log.warn(`${step} failed`, detail);
    return { ok: false, error: failure };
  }

  private unconfigured<T>(_message: string): ResearchStepResult<T> {
    return {
      ok: false,
      error: {
        code: "provider_not_configured",
        message: "The required research provider or model is not configured.",
        retryable: false,
        failureClass: "configuration",
        errorCode: "MISSING_CREDENTIALS",
        remediation: "Configure the research provider and synthesis model in Settings → Authentication, then start a new run.",
      },
    };
  }

  private async withTimeout<T>(
    step: string,
    promise: Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new ResearchStepAbortError(step);
    }

    let timeoutId: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const abortPromise = new Promise<never>((_, reject) => {
      if (!signal) return;
      abortListener = () => reject(new ResearchStepAbortError(step));
      signal.addEventListener("abort", abortListener, { once: true });
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new ResearchStepTimeoutError(step, timeoutMs)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise, abortPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (signal && abortListener) {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }
}
