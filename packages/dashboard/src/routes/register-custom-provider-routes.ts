import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, badRequest, notFound } from "../api-error.js";
import { getFusionModelsPath } from "../auth-paths.js";
import type { ApiRouteRegistrar } from "./types.js";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const ALLOWED_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
]);

// Keep in sync with BUILT_IN_PROVIDER_IDS in CustomProviderForm.tsx
const BUILT_IN_PROVIDER_IDS = new Set<string>([
  "anthropic", "claude-cli", "pi-claude-cli", "openai", "openai-codex", "google", "gemini", "google-antigravity",
  "antigravity", "google-vertex", "vertex", "google-cloud-code", "cloud-code", "google-gemini-cli", "google-generative-ai",
  "ollama", "github", "github-copilot", "openrouter", "minimax", "minimax-cn", "zai", "kimi", "moonshot", "kimi-coding",
  "bedrock", "amazon-bedrock", "xai", "grok", "opencode", "opencode-go", "qwen", "qwen-ai", "qwen-coder", "alibaba", "tongyi",
  "lmstudio", "lm-studio", "huggingface", "hugging-face", "hf", "mistral", "mistral-ai", "azure", "azure-openai",
  "azure-openai-responses", "fireworks", "fireworks-ai", "fireworksai", "cerebras", "groq", "vercel", "vercel-ai-gateway",
  "hermes", "hermes-agent", "hermesagent", "openclaw", "open-claw", "paperclip", "paperclipai", "paperclip-ai",
]);

type CustomModelConfig = {
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
};

type CustomProviderConfig = {
  id: string;
  name?: string;
  baseUrl: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  apiKey?: string;
  models: CustomModelConfig[];
};

type ModelsFile = {
  providers: Record<string, Omit<CustomProviderConfig, "id">>;
};

function validateBaseUrl(baseUrl: unknown): string {
  if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
    throw badRequest("baseUrl is required");
  }
  const normalized = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw badRequest("baseUrl must be a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequest("baseUrl must use http or https");
  }
  return normalized;
}

function validateModels(models: unknown): CustomModelConfig[] {
  if (!Array.isArray(models) || models.length === 0) {
    throw badRequest("models must contain at least one model");
  }

  return models.map((model, index) => {
    if (!model || typeof model !== "object") {
      throw badRequest(`models[${index}] must be an object`);
    }
    const row = model as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.trim().length === 0) {
      throw badRequest(`models[${index}].id is required`);
    }
    const parsed: CustomModelConfig = { id: row.id.trim() };
    if (typeof row.name === "string" && row.name.trim().length > 0) parsed.name = row.name.trim();
    if (typeof row.reasoning === "boolean") parsed.reasoning = row.reasoning;
    if (row.contextWindow !== undefined) {
      if (typeof row.contextWindow !== "number" || !Number.isFinite(row.contextWindow) || row.contextWindow <= 0) {
        throw badRequest(`models[${index}].contextWindow must be a positive number`);
      }
      parsed.contextWindow = row.contextWindow;
    }
    if (row.maxTokens !== undefined) {
      if (typeof row.maxTokens !== "number" || !Number.isFinite(row.maxTokens) || row.maxTokens <= 0) {
        throw badRequest(`models[${index}].maxTokens must be a positive number`);
      }
      parsed.maxTokens = row.maxTokens;
    }
    return parsed;
  });
}

function validateApi(api: unknown): CustomProviderConfig["api"] {
  if (typeof api !== "string" || !ALLOWED_APIS.has(api)) {
    throw badRequest("api must be one of: openai-completions, openai-responses, anthropic-messages, google-generative-ai");
  }
  return api as CustomProviderConfig["api"];
}

function parseProviderFromBody(body: unknown): CustomProviderConfig {
  if (!body || typeof body !== "object") throw badRequest("request body must be an object");
  const row = body as Record<string, unknown>;

  if (typeof row.id !== "string" || row.id.trim().length === 0) {
    throw badRequest("id is required");
  }
  const id = row.id.trim();
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw badRequest("id must be kebab-case (^[a-z][a-z0-9-]*$)");
  }

  const baseUrl = validateBaseUrl(row.baseUrl);
  const api = validateApi(row.api);
  const models = validateModels(row.models);

  const config: CustomProviderConfig = {
    id,
    baseUrl,
    api,
    models,
  };

  if (typeof row.name === "string" && row.name.trim().length > 0) config.name = row.name.trim();
  if (typeof row.apiKey === "string" && row.apiKey.trim().length > 0) config.apiKey = row.apiKey.trim();

  return config;
}

async function readModelsFile(modelsPath: string): Promise<ModelsFile> {
  try {
    const content = await readFile(modelsPath, "utf8");
    const parsed = JSON.parse(content) as Partial<ModelsFile>;
    if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.providers !== "object") {
      return { providers: {} };
    }
    return { providers: parsed.providers as Record<string, Omit<CustomProviderConfig, "id">> };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(path.dirname(modelsPath), { recursive: true });
      const initial = { providers: {} } satisfies ModelsFile;
      await writeFile(modelsPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");
      return initial;
    }
    throw error;
  }
}

async function writeModelsFile(modelsPath: string, file: ModelsFile): Promise<void> {
  await mkdir(path.dirname(modelsPath), { recursive: true });
  await writeFile(modelsPath, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function normalizeResponse(file: ModelsFile): CustomProviderConfig[] {
  return Object.entries(file.providers).map(([id, provider]) => ({ id, ...provider }));
}

export const registerCustomProviderRoutes: ApiRouteRegistrar = (ctx) => {
  const { router, options, rethrowAsApiError } = ctx;

  router.get("/custom-providers", async (_req, res) => {
    try {
      const modelsPath = getFusionModelsPath();
      const file = await readModelsFile(modelsPath);
      res.json({ providers: normalizeResponse(file) });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.post("/custom-providers", async (req, res) => {
    try {
      const provider = parseProviderFromBody(req.body);
      if (BUILT_IN_PROVIDER_IDS.has(provider.id)) {
        throw badRequest(`id '${provider.id}' is reserved for a built-in provider`);
      }

      const modelsPath = getFusionModelsPath();
      const file = await readModelsFile(modelsPath);
      if (file.providers[provider.id]) {
        throw badRequest(`custom provider '${provider.id}' already exists`);
      }

      file.providers[provider.id] = {
        name: provider.name,
        baseUrl: provider.baseUrl,
        api: provider.api,
        apiKey: provider.apiKey,
        models: provider.models,
      };
      await writeModelsFile(modelsPath, file);
      options?.modelRegistry?.refresh();

      res.status(201).json({ provider });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.put("/custom-providers/:id", async (req, res) => {
    try {
      const providerId = String(req.params.id ?? "").trim();
      if (!providerId) throw badRequest("id path parameter is required");

      const parsed = parseProviderFromBody({ ...req.body, id: providerId });
      const modelsPath = getFusionModelsPath();
      const file = await readModelsFile(modelsPath);
      if (!file.providers[providerId]) {
        throw notFound(`custom provider '${providerId}' not found`);
      }

      file.providers[providerId] = {
        name: parsed.name,
        baseUrl: parsed.baseUrl,
        api: parsed.api,
        apiKey: parsed.apiKey,
        models: parsed.models,
      };
      await writeModelsFile(modelsPath, file);
      options?.modelRegistry?.refresh();

      res.json({ provider: { id: providerId, ...file.providers[providerId] } });
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });

  router.delete("/custom-providers/:id", async (req, res) => {
    try {
      const providerId = String(req.params.id ?? "").trim();
      if (!providerId) throw badRequest("id path parameter is required");

      const modelsPath = getFusionModelsPath();
      const file = await readModelsFile(modelsPath);
      if (!file.providers[providerId]) {
        throw notFound(`custom provider '${providerId}' not found`);
      }

      delete file.providers[providerId];
      await writeModelsFile(modelsPath, file);
      options?.modelRegistry?.refresh();

      res.status(204).end();
    } catch (err: unknown) {
      if (err instanceof ApiError) throw err;
      rethrowAsApiError(err);
    }
  });
};
