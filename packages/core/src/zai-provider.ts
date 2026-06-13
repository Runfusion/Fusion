export const ZAI_PROVIDER_ID = "zai";

type ZaiModelInput = "text" | "image";

interface ZaiModelRegistration {
  id: string;
  name: string;
  reasoning: boolean;
  input: ZaiModelInput[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: {
    supportsDeveloperRole: boolean;
    thinkingFormat: "zai";
    zaiToolStream?: boolean;
  };
}

export interface ZaiProviderRegistration {
  name: string;
  baseUrl: string;
  apiKey: string;
  api: "openai-completions";
  models: ZaiModelRegistration[];
}

// pi registerProvider() replaces the provider's model list, so keep every
// currently built-in Z.ai model here and append new models such as GLM-5.2.
export const ZAI_PROVIDER_REGISTRATION: ZaiProviderRegistration = {
  name: "ZAI",
  baseUrl: "https://api.z.ai/api/coding/paas/v4",
  apiKey: "$ZAI_API_KEY",
  api: "openai-completions",
  models: [
    {
      id: "glm-4.5-air",
      name: "GLM-4.5-Air",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 98304,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
      },
    },
    {
      id: "glm-4.7",
      name: "GLM-4.7",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5-turbo",
      name: "GLM-5-Turbo",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5.1",
      name: "GLM-5.1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5v-turbo",
      name: "GLM-5V-Turbo",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
    {
      id: "glm-5.2",
      name: "GLM-5.2",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000000,
      maxTokens: 131072,
      compat: {
        supportsDeveloperRole: false,
        thinkingFormat: "zai",
        zaiToolStream: true,
      },
    },
  ],
};
