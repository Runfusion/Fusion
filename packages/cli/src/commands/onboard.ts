import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { resolveEffectiveConcurrency, CentralCore, GlobalSettingsStore, getDefaultCentralDbPath } from "@fusion/core";
import { createFusionAuthStorage, createFusionModelRegistry } from "@fusion/engine";
import { resolveProject } from "../project-context.js";
import { promptOutputStream } from "../output.js";
import { runInit } from "./init.js";
import { wrapAuthStorageWithApiKeyProviders } from "./provider-auth.js";
import { getModelRegistryModelsPath } from "./auth-paths.js";

export interface OnboardOptions {
  force?: boolean;
  input?: NodeJS.ReadableStream;
  /*
  FNXC:Onboarding 2026-08-19-03:38:
  False for the AUTO-LAUNCHED path (see onboard-autolaunch): prepare the install and stamp the
  marker, but ask nothing. Auto-launch fires while the operator is starting something else — a
  dashboard, a `pnpm dev --tunnel` — so its questions (AI provider setup, project setup, core
  settings) interrupt work nobody asked to interrupt, and a dev server stopped on a prompt never
  listens at all. `fn onboard` is the command for the interactive flow and keeps every step.
  */
  interactive?: boolean;
}

const PROMPT_CANCELLED_ERROR = "Interactive prompt cancelled";

interface PromptChoiceOption {
  id: string;
  label: string;
}

interface PromptChoiceOptions {
  allowSkip?: boolean;
}

interface PromptSession {
  prompt(question: string, defaultValue?: string): Promise<string>;
  promptOptional(question: string, defaultValue?: string): Promise<string>;
  promptYesNo(question: string, defaultValue: boolean): Promise<boolean>;
  promptChoice(
    question: string,
    choices: PromptChoiceOption[],
    options?: PromptChoiceOptions,
  ): Promise<string | undefined>;
  close(): void;
}

function createPromptSession(input: NodeJS.ReadableStream = process.stdin): PromptSession {
  const rl = createInterface({ input, /* FNXC:CliQuietMode 2026-07-16-00:00: Readline prompts bypass the quiet stdout gate so interactive questions remain visible. */
    output: promptOutputStream() });
  let settled = false;

  const cleanup = () => {
    if (settled) return;
    settled = true;
    process.removeListener("SIGINT", sigintHandler);
    rl.close();
  };

  const cancel = () => {
    cleanup();
    console.log("\n");
  };

  const sigintHandler = () => cancel();
  process.on("SIGINT", sigintHandler);

  const ask = (question: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const onClose = () => reject(new Error(PROMPT_CANCELLED_ERROR));
      rl.once("close", onClose);
      rl.question(question, (answer) => {
        rl.removeListener("close", onClose);
        resolve(answer.trim());
      });
    });

  const prompt = async (question: string, defaultValue?: string): Promise<string> => {
    while (true) {
      const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
      const answer = await ask(`${question}${suffix}: `);
      if (answer === "" && defaultValue !== undefined) {
        return defaultValue;
      }
      if (answer !== "") {
        return answer;
      }
    }
  };

  const promptOptional = async (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : "";
    const answer = await ask(`${question}${suffix}: `);
    return answer === "" && defaultValue !== undefined ? defaultValue : answer;
  };

  const promptYesNo = async (question: string, defaultValue: boolean): Promise<boolean> => {
    const hint = defaultValue ? "Y/n" : "y/N";
    while (true) {
      const answer = (await ask(`${question} (${hint}): `)).toLowerCase();
      if (!answer) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
      console.log("Please answer yes or no.");
    }
  };

  const promptChoice = async (
    question: string,
    choices: PromptChoiceOption[],
    options: PromptChoiceOptions = {},
  ): Promise<string | undefined> => {
    if (choices.length === 0) return undefined;
    const rendered = choices.map((choice, index) => `  ${index + 1}) ${choice.label}`);
    rendered.forEach((line) => console.log(line));
    if (options.allowSkip) {
      console.log(`  ${choices.length + 1}) Skip`);
    }

    while (true) {
      const answer = await ask(`${question}: `);
      const selected = parseInt(answer, 10);
      const upperBound = choices.length + (options.allowSkip ? 1 : 0);
      if (!Number.isNaN(selected) && selected >= 1 && selected <= upperBound) {
        if (options.allowSkip && selected === choices.length + 1) return undefined;
        return choices[selected - 1]?.id;
      }
      console.log(`Please select a number between 1 and ${upperBound}.`);
    }
  };

  return {
    prompt,
    promptOptional,
    promptYesNo,
    promptChoice,
    close: cleanup,
  };
}

export interface LocalProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  modelIds: string[];
  reasoning: boolean;
  qwenChatTemplate: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeLocalBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Base URL must be an absolute http: or https: URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL must be an absolute http: or https: URL.");
  }
  return url.toString().replace(/\/$/, "");
}

export function parseModelIds(value: string): string[] {
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

/**
 * FNXC:LocalProviderOnboarding 2026-07-23-12:00:
 * Local endpoints must share pi's existing models.json registry without replacing
 * unrelated provider or extension fields. A malformed registry is a hard stop so
 * onboarding never turns a recoverable user configuration error into data loss.
 */
export function composeLocalProviderRegistry(existing: unknown, config: LocalProviderConfig): Record<string, unknown> {
  if (!isObject(existing)) throw new Error("models.json must contain a JSON object.");
  const existingProviders = existing.providers;
  if (existingProviders !== undefined && !isObject(existingProviders)) {
    throw new Error("models.json providers must be a JSON object.");
  }
  const providers: Record<string, unknown> = { ...(existingProviders ?? {}) };
  const priorValue = providers[config.id];
  const prior: Record<string, unknown> = isObject(priorValue) ? priorValue : {};
  const priorModels: Record<string, unknown>[] = Array.isArray(prior.models)
    ? prior.models.filter(isObject)
    : [];
  const configuredModels = config.modelIds.map((id) => ({
    id,
    ...(config.reasoning ? { reasoning: true } : {}),
    ...(config.qwenChatTemplate
      ? { compat: { thinkingFormat: "qwen-chat-template", chatTemplateKwargs: { enable_thinking: { $var: "thinking.enabled" } } } }
      : {}),
  }));
  const configuredIds = new Set(config.modelIds);
  providers[config.id] = {
    ...prior,
    name: config.name,
    baseUrl: config.baseUrl,
    api: "openai-completions",
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    models: [...priorModels.filter((model) => typeof model.id !== "string" || !configuredIds.has(model.id)), ...configuredModels],
  };
  if (!config.apiKey) delete (providers[config.id] as Record<string, unknown>).apiKey;
  return { ...existing, providers };
}

/**
 * FNXC:LocalProviderOnboarding 2026-07-23-12:00:
 * Atomic sibling replacement prevents an interrupted custom-provider setup from
 * truncating pi's registry; credentials are only persisted in the registry, never logged.
 */
function registryHasProvider(path: string, providerId: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const registry = JSON.parse(readFileSync(path, "utf8"));
    return isObject(registry) && isObject(registry.providers) && isObject(registry.providers[providerId]);
  } catch {
    return false;
  }
}

export function persistLocalProviderRegistry(path: string, config: LocalProviderConfig): void {
  let existing: unknown = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error(`Cannot update malformed models.json: ${path}`);
    }
  }
  const registry = composeLocalProviderRegistry(existing, config);
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}

function validateMaxConcurrent(input: string): number {
  const value = parseInt(input, 10);
  if (Number.isNaN(value) || value < 1 || value > 10) {
    throw new Error("maxConcurrent must be an integer between 1 and 10.");
  }
  return value;
}

async function runSkippableStep(
  prompts: PromptSession,
  label: string,
  body: () => Promise<void>,
): Promise<boolean> {
  console.log(`\n${label}:`);
  const shouldRun = await prompts.promptYesNo(`Run ${label.toLowerCase()} now?`, true);
  if (!shouldRun) {
    console.log(`⤳ Skipped ${label}`);
    return false;
  }
  await body();
  return true;
}

/*
FNXC:GithubStarAsk 2026-08-19-03:59:
Canonical repository for the star ask. Kept next to the ask itself rather than read from package.json
so the printed link cannot silently become a workspace-local path in a bundled CLI.
*/
export const GITHUB_REPO_URL = "https://github.com/Runfusion/Fusion";

/**
 * FNXC:GithubStarAsk 2026-08-19-03:59:
 * The star ask is one-shot for the lifetime of the install: once the operator has answered it —
 * dismissed it, or been handed the link — `githubStarPromptDismissedAt` is stamped and no surface
 * asks again. That includes `fn onboard --force`, which replays every other step.
 */
export function shouldAskGithubStar(settings: { githubStarPromptDismissedAt?: string }): boolean {
  return !(
    typeof settings.githubStarPromptDismissedAt === "string" &&
    settings.githubStarPromptDismissedAt.trim().length > 0
  );
}

/*
FNXC:GithubStarAsk 2026-08-19-03:59:
Asked only AFTER onboarding is complete and stamped, so a declined star — or a Ctrl-C on this
prompt — can never cost the operator the setup work they just did. The ask never opens a browser on
the operator's behalf; it prints the URL and they choose. A cancel is treated as a dismissal because
walking away from the question is an answer, and re-asking it would be exactly the nag we promised
not to be.
*/
async function askToStarOnGithub(
  prompts: PromptSession,
  globalSettingsStore: GlobalSettingsStore,
  settings: { githubStarPromptDismissedAt?: string },
): Promise<void> {
  if (!shouldAskGithubStar(settings)) return;

  console.log("\nOne last thing:");
  let starred = false;
  try {
    starred = await prompts.promptYesNo("Fusion is open source. Star it on GitHub?", true);
  } catch (error) {
    if (!(error instanceof Error && error.message === PROMPT_CANCELLED_ERROR)) throw error;
  }

  console.log(
    starred
      ? `★ Thank you! Star it here: ${GITHUB_REPO_URL}`
      : "No problem — we won't ask again.",
  );
  await globalSettingsStore.updateSettings({
    githubStarPromptDismissedAt: new Date().toISOString(),
  });
}

export function isCliOnboardingComplete(settings: { cliOnboardingCompletedAt?: string }): boolean {
  return (
    typeof settings.cliOnboardingCompletedAt === "string" &&
    settings.cliOnboardingCompletedAt.trim().length > 0
  );
}

export async function runOnboard(options: OnboardOptions = {}): Promise<void> {
  const globalSettingsStore = new GlobalSettingsStore();
  await globalSettingsStore.init();
  const settings = await globalSettingsStore.getSettings();

  if (isCliOnboardingComplete(settings) && !options.force) {
    console.log("Onboarding already completed. Re-run with --force to run it again.");
    return;
  }

  const interactive = options.interactive !== false;
  const prompts = createPromptSession(options.input);

  try {
    const centralDbPath = getDefaultCentralDbPath();
    if (existsSync(centralDbPath)) {
      console.log(`✓ Central DB already exists: ${centralDbPath}`);
    } else {
      /*
      FNXC:Onboarding 2026-08-19-03:38:
      The central DB is created unconditionally — no prompt. Fusion cannot run without it, so
      declining produced an install that was broken in a way the message ("database was not created
      or initialized") described but did not fix. It also blocked non-interactive startups: a
      `pnpm dev --tunnel` sat on "Run central db now? (Y/n)" and never listened, so nothing was
      served and the tunnel had no dev server to point at.
      */
      console.log("\nCentral DB:");
      console.log(`Creating central DB: ${centralDbPath}`);
      const central = new CentralCore();
      await central.init();
      await central.close();
      console.log("✓ Central DB initialized");
    }

    if (!interactive) {
      await globalSettingsStore.updateSettings({
        cliOnboardingCompletedAt: new Date().toISOString(),
      });
      console.log("\nConnect a provider and finish setup in the dashboard, or run `fn onboard` anytime.");
      return;
    }

    const authStorage = createFusionAuthStorage();
    const modelRegistry = await createFusionModelRegistry(authStorage);
    const providerAuth = wrapAuthStorageWithApiKeyProviders(authStorage, modelRegistry);

    await runSkippableStep(prompts, "AI provider setup", async () => {
      const apiProviders = providerAuth.getApiKeyProviders();
      const oauthProviders = new Set(providerAuth.getOAuthProviders().map((provider) => provider.id));
      const providerChoices = apiProviders.map((provider) => {
        const configured = providerAuth.hasApiKey(provider.id) || providerAuth.hasAuth(provider.id);
        const oauthHint = oauthProviders.has(provider.id) ? " (OAuth via fn dashboard)" : "";
        const configuredHint = configured ? " (already configured)" : "";
        return {
          id: provider.id,
          label: `${provider.name}${configuredHint}${oauthHint}`,
        };
      });
      providerChoices.push({ id: "custom-local", label: "Custom / Local (OpenAI-compatible)" });

      const selectedProvider = await prompts.promptChoice("Select provider", providerChoices, {
        allowSkip: true,
      });

      if (!selectedProvider) return;
      if (selectedProvider === "custom-local") {
        const path = getModelRegistryModelsPath();
        const providerId = await prompts.prompt("Provider ID", "custom-local");
        if (registryHasProvider(path, providerId) && !await prompts.promptYesNo(
          `Provider ${providerId} already exists. Merge these settings into it?`,
          false,
        )) return;
        const providerName = await prompts.prompt("Provider name", "Custom / Local");
        let baseUrl: string;
        while (true) {
          try {
            baseUrl = normalizeLocalBaseUrl(await prompts.prompt("Base URL (for example http://localhost:8080/v1)"));
            break;
          } catch (error) {
            console.log(error instanceof Error ? error.message : "Invalid base URL.");
          }
        }
        const apiKey = await prompts.promptOptional("API key (optional; leave blank for unauthenticated servers)");
        let modelIds: string[];
        while (true) {
          modelIds = parseModelIds(await prompts.prompt("Model IDs (comma-separated)"));
          if (modelIds.length > 0) break;
          console.log("Enter at least one model ID.");
        }
        const reasoning = await prompts.promptYesNo("Do these models support reasoning/thinking?", false);
        const qwenChatTemplate = reasoning && await prompts.promptYesNo(
          "Use Qwen chat-template thinking compatibility? Enable only for servers requiring chat_template_kwargs.enable_thinking.",
          false,
        );
        try {
          persistLocalProviderRegistry(path, { id: providerId, name: providerName, baseUrl, apiKey, modelIds, reasoning, qwenChatTemplate });
        console.log(`✓ Registered ${modelIds.map((id) => `${providerId}/${id}`).join(", ")} in ${path}`);
        } catch (error) {
          console.log(`Could not save custom provider: ${error instanceof Error ? error.message : "unknown error"}`);
          throw error;
        }
        return;
      }
      if (oauthProviders.has(selectedProvider)) {
        console.log(`Provider ${selectedProvider} uses OAuth. Authenticate with: fn dashboard`);
        return;
      }

      const apiKey = await prompts.prompt("Enter API key");
      await providerAuth.setApiKey(selectedProvider, apiKey);
      console.log(`✓ Stored API key for ${selectedProvider}`);
    });

    await runSkippableStep(prompts, "Project setup", async () => {
      await runInit({});
    });

    await runSkippableStep(prompts, "Core settings", async () => {
      const testMode = await prompts.promptYesNo("Enable test mode globally?", false);
      // Project testMode overrides global testMode when set.
      await globalSettingsStore.updateSettings({ testMode });

      let projectContext: Awaited<ReturnType<typeof resolveProject>> | undefined;
      try {
        projectContext = await resolveProject(undefined);
      } catch {
        projectContext = undefined;
      }

      if (projectContext) {
        const rawMaxConcurrent = await prompts.prompt(
          "Set maxConcurrent for this project",
          String(resolveEffectiveConcurrency(await projectContext.store.getSettings()).maxConcurrent),
        );
        const maxConcurrent = validateMaxConcurrent(rawMaxConcurrent);
        await projectContext.store.updateSettings({ maxConcurrent });
        console.log(`✓ Project maxConcurrent set to ${maxConcurrent}`);
      } else {
        console.log("Skipping maxConcurrent (no active project found).");
      }
    });

    await runSkippableStep(prompts, "Next steps", async () => {
      console.log("  fn dashboard      # launch dashboard");
      console.log("  fn task create    # create your first task");
    });

    await globalSettingsStore.updateSettings({
      cliOnboardingCompletedAt: new Date().toISOString(),
    });
    console.log("\n✓ Onboarding complete");
    await askToStarOnGithub(prompts, globalSettingsStore, settings);
  } catch (error) {
    if (error instanceof Error && error.message === PROMPT_CANCELLED_ERROR) {
      throw new Error("Onboarding cancelled.");
    }
    throw error;
  } finally {
    prompts.close();
  }
}

export const __testUtils = {
  createPromptSession,
  validateMaxConcurrent,
  normalizeLocalBaseUrl,
  parseModelIds,
  composeLocalProviderRegistry,
  persistLocalProviderRegistry,
  runSkippableStep,
  isCliOnboardingComplete,
  shouldAskGithubStar,
  askToStarOnGithub,
  PROMPT_CANCELLED_ERROR,
};
