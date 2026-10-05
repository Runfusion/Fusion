import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const GROK_CLI_PROVIDER_ID = "grok-cli";
export const XAI_PROVIDER_ID = "xai";
export const GROK_API_BASE_URL = "https://api.x.ai/v1";

type PiModel = { id: string; provider?: string };
interface ModelRegistryLike {
  getAll?: () => PiModel[];
  registerProvider(provider: string, config: Record<string, unknown>): void;
  unregisterProvider?: (provider: string) => void;
}

/*
FNXC:ModelCatalog 2026-10-05-02:18:
Pi owns xAI model metadata. Fusion projects those rows under the persisted grok-cli identity
only after refresh, preserving Pi capabilities while retaining Grok's existing credential routing.
*/
export function projectPiXaiModelsToGrokCli(modelRegistry: ModelRegistryLike, logWarning: (message: string) => void = () => {}): void {
  try {
    const models = modelRegistry.getAll?.().filter(model => model.provider === XAI_PROVIDER_ID) ?? [];
    /*
    FNXC:ModelCatalog 2026-10-05-02:35:
    A successful Pi refresh can remove every xAI row, so discard the prior grok-cli projection
    rather than retaining models Pi no longer advertises. Failed or timed-out refreshes retain
    Pi's last-good rows and therefore still project through this same path.
    */
    modelRegistry.unregisterProvider?.(GROK_CLI_PROVIDER_ID);
    if (models.length === 0) return;
    modelRegistry.registerProvider(GROK_CLI_PROVIDER_ID, {
      name: "Grok",
      baseUrl: GROK_API_BASE_URL,
      apiKey: "$GROK_API_KEY",
      api: "openai-completions",
      models: models.map((model) => {
        const { provider: _provider, ...metadata } = model as PiModel & Record<string, unknown>;
        return metadata;
      }),
    });
  } catch (error) {
    logWarning(`Failed to project Pi ${XAI_PROVIDER_ID} models for ${GROK_CLI_PROVIDER_ID}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readGrokUserSettingsApiKey(): string | undefined {
  const raw = readFileSync(join(homedir(), ".grok", "user-settings.json"), "utf-8");
  const parsed = JSON.parse(raw) as { apiKey?: unknown };
  return typeof parsed.apiKey === "string" && parsed.apiKey.trim().length > 0 ? parsed.apiKey.trim() : undefined;
}

export function isGrokApiKeyFusionVisible(): boolean {
  if (process.env.GROK_API_KEY?.trim()) return true;
  try { return readGrokUserSettingsApiKey() !== undefined; } catch { return false; }
}

/** Hydrate only process environment state; never expose a key through the model catalog. */
export function hydrateGrokApiKeyFromUserSettings(logWarning: (message: string) => void = () => {}): void {
  if (process.env.GROK_API_KEY?.trim()) return;
  try {
    const apiKey = readGrokUserSettingsApiKey();
    if (apiKey) process.env.GROK_API_KEY = apiKey;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      logWarning(`Failed to read ~/.grok/user-settings.json for GROK_API_KEY fallback: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
