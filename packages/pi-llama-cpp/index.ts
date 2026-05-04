import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER_ID,
  PROVIDER_NAME,
} from "./src/constants.js";
import { resolveLlamaServerApiKey, resolveLlamaServerUrl } from "./src/resolver.js";
import { isLlamaServerReady, listLlamaModels } from "./src/retriever.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  const cwd = process.cwd();
  if (!(await isLlamaServerReady(cwd))) {
    return;
  }

  const [url, models, apiKey] = await Promise.all([
    resolveLlamaServerUrl(cwd),
    listLlamaModels(cwd),
    resolveLlamaServerApiKey(),
  ]);

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: `${url}/v1`,
    api: "openai-completions",
    apiKey: apiKey ?? "",
    models: models.map((model) => ({
      id: model.id,
      name: model.id,
      reasoning: true,
      input: ["text", "image"] as Array<"text" | "image">,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    })),
  });
}
