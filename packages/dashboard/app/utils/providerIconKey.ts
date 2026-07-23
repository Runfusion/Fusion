/*
FNXC:ProviderIcons 2026-06-25-00:00:
Command Center model analytics group rows by model id only, so dashboard model-name surfaces must infer the provider icon from the model/provider text before handing off to ProviderIcon's fallback-safe renderer.

FNXC:ProviderIcons 2026-06-28-20:46:
Standalone GLM model ids such as glm-5.1, glm-4.5-air, and glm-5v-turbo are Z.ai/Zhipu-family models even when the analytics label omits zai/zhipu. Match GLM only at model-id segment boundaries so unrelated words do not hijack the Z.ai provider icon.
*/
const GLM_MODEL_SEGMENT_PATTERN = /(?:^|[/:_-])glm(?:$|[\d._:-]|-[\da-z])/;
const OMP_PROVIDER_SEGMENT_PATTERN = /(?:^|[/:_\s-])omp(?:$|[/:_\s-])/;
const OMP_PROVIDER_NAME_PATTERN = /oh[-\s]my[-\s]pi/;
const XIAOMI_MIMO_MODEL_SEGMENT_PATTERN = /(?:^|[/:_-])mimo(?:$|[/:_.-])/;

export function inferProviderIconKey(modelOrProviderName: string): string {
  const normalized = modelOrProviderName.toLowerCase();

  // Map common provider/model names to their icon keys.
  /*
  FNXC:ProviderIcons 2026-07-11-00:00:
  FN-7818: model-id-shaped Cursor provider strings (cursor, cursor-agent, cursor/<model>) must resolve to the cursor-cli brand icon on model-selection surfaces instead of the generic CPU fallback, mirroring UsageIndicator's local mapping.
  Run before broad model-family checks so cursor/gpt-5 stays Cursor-branded instead of OpenAI-branded.
  */
  if (normalized.includes("cursor")) {
    return "cursor-cli";
  }
  /*
  FNXC:ProviderIcons 2026-07-18-18:24:
  FN-8354: omp ACP model ids can contain another vendor model name (for example omp/claude-sonnet-4), but must retain the OMP brand mark on selection and analytics surfaces. Match only an OMP segment or the Oh My Pi name so unrelated strings and untagged model ids keep existing inference/fallback behavior.
  */
  if (OMP_PROVIDER_SEGMENT_PATTERN.test(normalized) || OMP_PROVIDER_NAME_PATTERN.test(normalized)) {
    return "omp-cli";
  }
  /*
  FNXC:ProviderIcons 2026-07-22-17:04:
  FN-8500 requires the Hermes Xiaomi provider and Xiaomi MiMo model IDs to resolve through the shared icon path. Restrict MiMo matching to model-id segment boundaries so unrelated custom names such as "mimosa" retain the fallback.
  */
  if (normalized === "xiaomi" || XIAOMI_MIMO_MODEL_SEGMENT_PATTERN.test(normalized)) {
    return "xiaomi";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("codex") || normalized.includes("openai") || normalized.includes("gpt")) {
    return "openai";
  }
  if (normalized.includes("gemini") || normalized.includes("google") || normalized.includes("antigravity")) {
    return "google";
  }
  if (normalized.includes("ollama")) {
    return "ollama";
  }
  if (normalized.includes("minimax")) {
    return "minimax";
  }
  if (normalized.includes("zai") || normalized.includes("zhipu") || GLM_MODEL_SEGMENT_PATTERN.test(normalized)) {
    return "zai";
  }
  if (normalized.includes("kimi") || normalized.includes("moonshot")) {
    return "kimi";
  }
  if (normalized.includes("bedrock") || normalized.includes("amazon")) {
    return "bedrock";
  }
  if (normalized.includes("xai") || normalized.includes("grok")) {
    return "xai";
  }
  if (normalized.includes("opencode")) {
    return "opencode";
  }
  if (normalized.includes("copilot") || normalized === "github copilot") {
    return "github-copilot";
  }

  // Return the original name as fallback (ProviderIcon will show a default icon).
  return modelOrProviderName;
}
