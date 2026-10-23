import { spawn } from "node:child_process";

const OPENROUTER_PUBLIC_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_DEFAULT_REFERER = "https://runfusion.ai";
const OPENROUTER_DEFAULT_TITLE = "Fusion";
const ORCAROUTER_MODELS_URL = "https://api.orcarouter.ai/v1/models";
const ORCAROUTER_DEFAULT_BASE_URL = "https://api.orcarouter.ai/v1";
const CHEAPER_INFERENCE_MODELS_URL = "https://api.cheaperinference.com/v1/models";
const CHEAPER_INFERENCE_DEFAULT_BASE_URL = "https://api.cheaperinference.com/v1";
const CHEAPER_INFERENCE_MODELS_TIMEOUT_MS = 15_000;
const OPENCODE_MODELS_TIMEOUT_MS = 15_000;

type ModelConfig = {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
};

interface ModelRegistryLike {
  registerProvider: (name: string, config: {
    baseUrl: string;
    api: string;
    apiKey?: string;
    models: ModelConfig[];
    headers?: Record<string, string>;
    compat?: { openRouterRouting?: OpenRouterProviderPreferences };
  }) => void;
}

interface AuthStorageLike {
  getApiKey: (provider: string) => Promise<string | undefined>;
}

interface OpenRouterModelFilters {
  supported_parameters?: string[];
  output_modalities?: string[];
}

interface OpenRouterProviderPreferences {
  order?: string[];
  ignore?: string[];
  only?: string[];
  allow_fallbacks?: boolean;
  sort?: "price" | "throughput" | "latency";
  require_parameters?: boolean;
}

interface SettingsLike {
  openrouterModelSync?: boolean;
  orcarouterModelSync?: boolean;
  cheaperinferenceModelSync?: boolean;
  opencodeGoModelSync?: boolean;
  openrouterAppAttribution?: { referer?: string; title?: string };
  openrouterModelFilters?: OpenRouterModelFilters;
  openrouterProviderPreferences?: OpenRouterProviderPreferences;
}

interface StartupSyncOptions {
  getSettings: () => Promise<SettingsLike>;
  authStorage: AuthStorageLike;
  modelRegistry: ModelRegistryLike;
  log: (scope: string, message: string) => void;
}

export type OpencodeGoRefreshResult = {
  registeredCount: number;
  reason?: "no-models-from-cli" | "cli-failed" | "disabled-by-settings";
  error?: string;
};

function parseCost(value?: string): number {
  const n = parseFloat(value || "0");
  return Number.isNaN(n) ? 0 : n * 1_000_000;
}

function toOpenRouterModels(json: {
  data?: Array<{
    id: string;
    name: string;
    context_length?: number;
    top_provider?: { max_completion_tokens?: number };
    pricing?: Record<string, string>;
    architecture?: { modality?: string; input_modalities?: string[] };
  }>;
}): ModelConfig[] {
  return (json.data || []).map((model) => {
    const id = (model.id || "").toLowerCase();
    const name = (model.name || "").toLowerCase();
    const reasoning = id.includes(":thinking")
      || id.includes("-r1")
      || id.includes("/r1")
      || id.includes("o1-")
      || id.includes("o3-")
      || id.includes("o4-")
      || id.includes("reasoner")
      || name.includes("thinking")
      || name.includes("reasoner");
    const hasVision = model.architecture?.input_modalities?.includes("image")
      ?? model.architecture?.modality?.includes("multimodal")
      ?? false;

    return {
      id: model.id,
      name: model.name || model.id,
      reasoning,
      input: hasVision ? ["text", "image"] : ["text"],
      cost: {
        input: parseCost(model.pricing?.prompt),
        output: parseCost(model.pricing?.completion),
        cacheRead: parseCost(model.pricing?.input_cache_read),
        cacheWrite: parseCost(model.pricing?.input_cache_write),
      },
      contextWindow: model.context_length || 128000,
      maxTokens: model.top_provider?.max_completion_tokens || 16384,
    };
  });
}

function withOpenRouterFilters(baseUrl: string, filters?: OpenRouterModelFilters): string {
  const url = new URL(baseUrl);
  if (filters?.supported_parameters?.length) {
    url.searchParams.set("supported_parameters", filters.supported_parameters.join(","));
  }
  if (filters?.output_modalities?.length) {
    url.searchParams.set("output_modalities", filters.output_modalities.join(","));
  }
  return url.toString();
}

function hasOpenRouterRoutingPreferences(preferences?: OpenRouterProviderPreferences): preferences is OpenRouterProviderPreferences {
  return Boolean(
    preferences
      && Object.values(preferences).some((value) => {
        if (Array.isArray(value)) {
          return value.length > 0;
        }
        return value !== undefined;
      }),
  );
}

async function syncOpenRouterModels(options: StartupSyncOptions, settings: SettingsLike): Promise<void> {
  const { authStorage, modelRegistry, log } = options;
  const apiKey = await authStorage.getApiKey("openrouter");
  const referer = settings.openrouterAppAttribution?.referer ?? OPENROUTER_DEFAULT_REFERER;
  const title = settings.openrouterAppAttribution?.title ?? OPENROUTER_DEFAULT_TITLE;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (referer !== "") {
    headers["HTTP-Referer"] = referer;
  }
  if (title !== "") {
    headers["X-Title"] = title;
  }

  const fetchModels = async (url: string) => {
    const response = await fetch(withOpenRouterFilters(url, settings.openrouterModelFilters), { headers });
    return response;
  };

  const primaryUrl = apiKey ? OPENROUTER_USER_MODELS_URL : OPENROUTER_PUBLIC_MODELS_URL;
  let response = await fetchModels(primaryUrl);

  if (!response.ok && apiKey && primaryUrl === OPENROUTER_USER_MODELS_URL) {
    log("openrouter", `OpenRouter /models/user returned HTTP ${response.status}; falling back to public catalog`);
    response = await fetchModels(OPENROUTER_PUBLIC_MODELS_URL);
  }

  if (!response.ok) {
    log("openrouter", `Failed to sync models: HTTP ${response.status}`);
    return;
  }

  const json = await response.json() as {
    data?: Array<{
      id: string;
      name: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
      pricing?: Record<string, string>;
      architecture?: { modality?: string; input_modalities?: string[] };
    }>;
  };

  const models = toOpenRouterModels(json);
  modelRegistry.registerProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: "OPENROUTER_API_KEY",
    api: "openai-completions",
    models,
    headers: Object.keys(headers).filter((key) => key !== "Authorization").length > 0
      ? Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "Authorization"))
      : undefined,
    compat: hasOpenRouterRoutingPreferences(settings.openrouterProviderPreferences)
      ? { openRouterRouting: settings.openrouterProviderPreferences }
      : undefined,
  });
  log("openrouter", `Synced ${models.length} models from OpenRouter API`);
}

/*
FNXC:OrcaRouterProvider 2026-08-21-14:00:
Fusion ships OrcaRouter as a named OpenAI-compatible gateway provider, mirroring
the OpenRouter catalog-sync pattern. OrcaRouter exposes a public `/v1/models`
catalog (same OpenAI shape as OpenRouter), so the same `toOpenRouterModels`
mapping is reused — the catalog returns prefixed model IDs
(`anthropic/claude-sonnet-5`, `deepseek/deepseek-v4-flash-0731`) that OrcaRouter
accepts verbatim on `POST /v1/chat/completions`. Registration uses
`api: "openai-completions"` and resolves its key from the `ORCAROUTER_API_KEY`
environment variable so operators can store a key without touching the
dashboard. Sync is gated by `orcarouterModelSync` (default true), and requests
carry the key only when present.
*/
async function syncOrcaRouterModels(options: StartupSyncOptions): Promise<void> {
  const { authStorage, modelRegistry, log } = options;
  const apiKey = await authStorage.getApiKey("orcarouter");
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(ORCAROUTER_MODELS_URL, { headers });

  if (!response.ok) {
    log("orcarouter", `Failed to sync models: HTTP ${response.status}`);
    return;
  }

  const json = await response.json() as {
    data?: Array<{
      id: string;
      name: string;
      context_length?: number;
      top_provider?: { max_completion_tokens?: number };
      pricing?: Record<string, string>;
      architecture?: { modality?: string; input_modalities?: string[] };
    }>;
  };

  const models = toOpenRouterModels(json);
  modelRegistry.registerProvider("orcarouter", {
    baseUrl: ORCAROUTER_DEFAULT_BASE_URL,
    apiKey: "ORCAROUTER_API_KEY",
    api: "openai-completions",
    models,
  });
  log("orcarouter", `Synced ${models.length} models from OrcaRouter API`);
}

/*
FNXC:CheaperInferenceProvider 2026-10-20-14:00:
Fusion ships Cheaper Inference as a named OpenAI-compatible gateway provider,
mirroring the OrcaRouter catalog-sync pattern. The Cheaper Inference `/v1/models`
catalog requires a bearer key, so sync runs only when a key is stored. The catalog
rows carry `type`, `context_length`, `max_output_tokens`, `capabilities` and
per-million `pricing` fields instead of the OpenRouter shape, so they get their own
mapping; only `type: "text"` rows are chat models. Model IDs are bare
(`gpt-5.4-mini`) and are accepted verbatim on `POST /v1/chat/completions`.
Registration uses `api: "openai-completions"` and the same `apiKey` reference
convention as OpenRouter and OrcaRouter (`CHEAPER_INFERENCE_API_KEY`); the key
stored in the dashboard is used at request time. Sync is gated by
`cheaperinferenceModelSync` (default true). Startup skips sync when no key is
stored, so saving a key runs the same sync (`handleCheaperInferenceApiKeySaved`).
The catalog request has an abort deadline that also covers the body read, so a
stalled request cannot block the syncs that run after it.
*/
function toCheaperInferenceModels(json: {
  data?: Array<{
    id: string;
    type?: string;
    context_length?: number;
    max_output_tokens?: number;
    capabilities?: { vision?: boolean; reasoning?: boolean };
    pricing?: Record<string, unknown>;
  }>;
}): ModelConfig[] {
  const perMillion = (value: unknown): number => {
    const n = parseFloat(typeof value === "string" ? value : "0");
    return Number.isNaN(n) ? 0 : n;
  };
  return (json.data || [])
    .filter((model) => model.id && (model.type ?? "text") === "text")
    .map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: model.capabilities?.reasoning === true,
      input: model.capabilities?.vision === true ? ["text", "image"] : ["text"],
      cost: {
        input: perMillion(model.pricing?.input_per_million),
        output: perMillion(model.pricing?.output_per_million),
        cacheRead: perMillion(model.pricing?.cache_read_input_per_million),
        cacheWrite: perMillion(model.pricing?.cache_write_input_per_million),
      },
      contextWindow: model.context_length || 128000,
      maxTokens: model.max_output_tokens || 16384,
    }));
}

async function syncCheaperInferenceModels(
  options: Pick<StartupSyncOptions, "authStorage" | "modelRegistry" | "log">,
): Promise<void> {
  const { authStorage, modelRegistry, log } = options;
  const apiKey = await authStorage.getApiKey("cheaperinference");
  if (!apiKey) {
    return;
  }

  const response = await fetch(CHEAPER_INFERENCE_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(CHEAPER_INFERENCE_MODELS_TIMEOUT_MS),
  });

  if (!response.ok) {
    log("cheaperinference", `Failed to sync models: HTTP ${response.status}`);
    return;
  }

  const models = toCheaperInferenceModels(await response.json() as Parameters<typeof toCheaperInferenceModels>[0]);
  modelRegistry.registerProvider("cheaperinference", {
    baseUrl: CHEAPER_INFERENCE_DEFAULT_BASE_URL,
    apiKey: "CHEAPER_INFERENCE_API_KEY",
    api: "openai-completions",
    models,
  });
  log("cheaperinference", `Synced ${models.length} models from Cheaper Inference API`);
}

export function normalizeOpencodeGoModel(modelId: string): ModelConfig {
  const trimmed = modelId.trim();
  // Strip the provider prefix (opencode/ or opencode-go/) — the Pi SDK
  // already routes requests by provider, and the OpenCode API expects the
  // bare model name (e.g. "deepseek-v4-flash", not "opencode-go/deepseek-v4-flash").
  const bareModel = trimmed.startsWith("opencode-go/")
    ? trimmed.slice("opencode-go/".length)
    : trimmed.startsWith("opencode/")
      ? trimmed.slice("opencode/".length)
      : trimmed;

  if (!bareModel) {
    throw new Error(`Invalid opencode-go model ID: "${modelId}" has no model name after provider prefix`);
  }

  return {
    id: bareModel,
    name: bareModel,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

export function parseOpencodeModelsOutput(stdout: string): string[] {
  const ids = new Set<string>();
  const matches = stdout.matchAll(/\bopencode(?:-go)?\/[A-Za-z0-9._:-]+\b/g);
  for (const match of matches) {
    if (match[0]) {
      ids.add(match[0]);
    }
  }
  return [...ids];
}

export async function discoverOpencodeGoModels(apiKey?: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (apiKey) {
      env.OPENCODE_API_KEY = apiKey;
    }
    const proc = spawn("opencode", ["models", "opencode", "--refresh"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Timed out after ${OPENCODE_MODELS_TIMEOUT_MS}ms`));
    }, OPENCODE_MODELS_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `opencode exited with code ${code}`));
        return;
      }
      resolve(parseOpencodeModelsOutput(stdout));
    });
  });
}

export async function refreshOpencodeGoModels(options: {
  modelRegistry: ModelRegistryLike;
  log: (scope: string, message: string) => void;
  apiKey?: string;
}): Promise<OpencodeGoRefreshResult> {
  try {
    const { modelRegistry, log, apiKey } = options;
    const modelIds = await discoverOpencodeGoModels(apiKey);
    if (modelIds.length === 0) {
      log("opencode-go", "No models discovered from opencode CLI refresh");
      return { registeredCount: 0, reason: "no-models-from-cli" };
    }

    const normalized = modelIds.map(normalizeOpencodeGoModel);
    // Deduplicate: CLI can emit both "opencode/foo" and "opencode-go/foo"
    // which normalize to the same bare ID.
    const seen = new Set<string>();
    const models = normalized.filter((m) => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
    modelRegistry.registerProvider("opencode-go", {
      baseUrl: "https://api.opencode.ai/v1",
      apiKey: "OPENCODE_API_KEY",
      api: "openai-completions",
      models,
    });
    log("opencode-go", `Synced ${models.length} models from opencode CLI`);
    return { registeredCount: models.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.log("opencode-go", `Failed to sync models: ${message}`);
    return { registeredCount: 0, reason: "cli-failed", error: message };
  }
}

export async function syncStartupModels(options: StartupSyncOptions): Promise<void> {
  const settings = await options.getSettings();

  if (settings.openrouterModelSync !== false) {
    try {
      await syncOpenRouterModels(options, settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log("openrouter", `Failed to sync models: ${message}`);
    }
  }

  if (settings.orcarouterModelSync !== false) {
    try {
      await syncOrcaRouterModels(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log("orcarouter", `Failed to sync models: ${message}`);
    }
  }

  if (settings.cheaperinferenceModelSync !== false) {
    try {
      await syncCheaperInferenceModels(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log("cheaperinference", `Failed to sync models: ${message}`);
    }
  }

  if (settings.opencodeGoModelSync !== false) {
    const opencodeGoApiKey = await options.authStorage.getApiKey("opencode-go") ?? await options.authStorage.getApiKey("opencode");
    await refreshOpencodeGoModels({ modelRegistry: options.modelRegistry, log: options.log, apiKey: opencodeGoApiKey });
  }
}

/**
 * Shared handler for the onApiKeySaved callback used by serve, daemon, and
 * dashboard. Resolves the opencode-go API key from auth storage (falling back
 * to the "opencode" provider ID) and triggers a model refresh, respecting the
 * opencodeGoModelSync setting.
 */
export async function handleOpencodeGoApiKeySaved(
  dashboardLegacyCredentialStorage: AuthStorageLike,
  store: { getSettings: () => Promise<SettingsLike> },
  modelRegistry: ModelRegistryLike,
  log: (scope: string, message: string) => void,
): Promise<OpencodeGoRefreshResult | undefined> {
  const settings = await store.getSettings();
  if (settings.opencodeGoModelSync === false) {
    return { registeredCount: 0, reason: "disabled-by-settings" };
  }
  const opencodeGoKey = await dashboardLegacyCredentialStorage.getApiKey("opencode-go") ?? await dashboardLegacyCredentialStorage.getApiKey("opencode");
  return await refreshOpencodeGoModels({ modelRegistry, log, apiKey: opencodeGoKey });
}

/**
 * Shared handler for the onApiKeySaved callback when a Cheaper Inference key is
 * saved. Startup skips the catalog sync while no key is stored, so this runs it
 * after the first key is saved, respecting the cheaperinferenceModelSync setting.
 */
export async function handleCheaperInferenceApiKeySaved(
  dashboardLegacyCredentialStorage: AuthStorageLike,
  store: { getSettings: () => Promise<SettingsLike> },
  modelRegistry: ModelRegistryLike,
  log: (scope: string, message: string) => void,
): Promise<void> {
  const settings = await store.getSettings();
  if (settings.cheaperinferenceModelSync === false) {
    return;
  }
  try {
    await syncCheaperInferenceModels({ authStorage: dashboardLegacyCredentialStorage, modelRegistry, log });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("cheaperinference", `Failed to sync models: ${message}`);
  }
}
