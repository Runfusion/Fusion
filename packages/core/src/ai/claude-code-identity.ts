import {
  ANTHROPIC_PROVIDER_ID,
  CLAUDE_FABLE_5_1_MODEL_ID,
  toExecutionModelProviderId,
} from "./anthropic-models.js";

/*
FNXC:ModelCatalog 2026-09-03-05:30:
Bundled pi-ai freezes its OAuth Claude Code identity at claude-cli/2.1.75, while Anthropic gates newer models on a minimum Claude Code version. Fusion owns the impersonated version and injects it through the request-auth header seam so supported subscription models cannot inherit that stale bundled value.

The lowercase user-agent key is intentional: pi-ai uses case-sensitive Object.assign header merging, so a differently-cased key would append a second header instead of replacing its stale OAuth entry.
*/
export const CLAUDE_CODE_IMPERSONATED_VERSION = "2.1.251";
export const CLAUDE_CODE_CLIENT_VERSION_ENV = "FUSION_ANTHROPIC_CLAUDE_CODE_VERSION";

export const ANTHROPIC_MODEL_MIN_CLAUDE_CODE_VERSION: Readonly<Record<string, string>> = {
  [CLAUDE_FABLE_5_1_MODEL_ID]: "2.1.251",
};

export function parseClaudeCodeVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareClaudeCodeVersions(a: string, b: string): number {
  const parsedA = parseClaudeCodeVersion(a);
  const parsedB = parseClaudeCodeVersion(b);
  if (!parsedA || !parsedB) {
    throw new Error("Claude Code versions must use major.minor.patch format");
  }
  for (let index = 0; index < parsedA.length; index += 1) {
    const difference = parsedA[index] - parsedB[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

export function resolveClaudeCodeClientVersion(
  env: Record<string, string | undefined> = process.env,
  onWarn: (message: string) => void = () => {},
): string {
  const override = env[CLAUDE_CODE_CLIENT_VERSION_ENV];
  if (override === undefined) return CLAUDE_CODE_IMPERSONATED_VERSION;
  if (parseClaudeCodeVersion(override)) return override;
  onWarn(`Ignoring malformed ${CLAUDE_CODE_CLIENT_VERSION_ENV}; using the bundled Fusion Claude Code identity version.`);
  return CLAUDE_CODE_IMPERSONATED_VERSION;
}

export function buildAnthropicClaudeCodeIdentityHeaders(input: {
  providerId?: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
  onWarn?: (message: string) => void;
}): Record<string, string> {
  if (
    input.providerId === undefined
    || toExecutionModelProviderId(input.providerId) !== ANTHROPIC_PROVIDER_ID
    || !input.apiKey?.includes("sk-ant-oat")
  ) return {};

  return { "user-agent": `claude-cli/${resolveClaudeCodeClientVersion(input.env, input.onWarn)}` };
}
