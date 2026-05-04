import { spawn } from "node:child_process";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
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
  }) => void;
}

interface AuthStorageLike {
  getApiKey: (provider: string) => Promise<string | undefined>;
}

interface SettingsLike {
  openrouterModelSync?: boolean;
  opencodeGoModelSync?: boolean;
}

interface StartupSyncOptions {
  getSettings: () => Promise<SettingsLike>;
  authStorage: AuthStorageLike;
  modelRegistry: ModelRegistryLike;
  log: (scope: string, message: string) => void;
}

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

async function syncOpenRouterModels(options: StartupSyncOptions): Promise<void> {
  const { authStorage, modelRegistry, log } = options;
  const apiKey = await authStorage.getApiKey("openrouter");
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(OPENROUTER_MODELS_URL, { headers });
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
  });
  log("openrouter", `Synced ${models.length} models from OpenRouter API`);
}

function normalizeOpencodeGoModel(modelId: string): ModelConfig {
  const trimmed = modelId.trim();
  const normalizedId = trimmed.startsWith("opencode/")
    ? `opencode-go/${trimmed.slice("opencode/".length)}`
    : trimmed.startsWith("opencode-go/")
      ? trimmed
      : `opencode-go/${trimmed}`;

  return {
    id: normalizedId,
    name: normalizedId,
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

async function discoverOpencodeGoModels(): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const proc = spawn("opencode", ["models", "opencode", "--refresh"], {
      stdio: ["ignore", "pipe", "pipe"],
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

async function syncOpencodeGoModels(options: StartupSyncOptions): Promise<void> {
  const { modelRegistry, log } = options;
  const modelIds = await discoverOpencodeGoModels();
  if (modelIds.length === 0) {
    log("opencode-go", "No models discovered from opencode CLI refresh");
    return;
  }

  const models = modelIds.map(normalizeOpencodeGoModel);
  modelRegistry.registerProvider("opencode-go", {
    baseUrl: "https://api.opencode.ai/v1",
    apiKey: "OPENCODE_API_KEY",
    api: "openai-completions",
    models,
  });
  log("opencode-go", `Synced ${models.length} models from opencode CLI`);
}

export async function syncStartupModels(options: StartupSyncOptions): Promise<void> {
  const settings = await options.getSettings();

  if (settings.openrouterModelSync !== false) {
    try {
      await syncOpenRouterModels(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log("openrouter", `Failed to sync models: ${message}`);
    }
  }

  if (settings.opencodeGoModelSync !== false) {
    try {
      await syncOpencodeGoModels(options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log("opencode-go", `Failed to sync models: ${message}`);
    }
  }
}
