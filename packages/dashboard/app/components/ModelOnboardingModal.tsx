import "./ModelOnboardingModal.css";
import "./SetupWizardModal.css";
import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, type KeyboardEvent } from "react";
import { X, Loader2, CheckCircle, Key, Zap, GitPullRequest, Rocket, Plus, Sparkles, UserRound } from "lucide-react";
import { getErrorMessage, type Task } from "@fusion/core";
import type { AuthProvider, ManualOAuthCodeInfo, ModelInfo, CustomProvider, CustomProviderConfig, OAuthDeviceCodeInfo } from "../api";
import {
  fetchAuthStatus,
  fetchGlobalSettings,
  loginProvider,
  logoutProvider,
  cancelProviderLogin,
  submitProviderManualCode,
  saveApiKey,
  clearApiKey,
  fetchModels,
  updateGlobalSettings,
  createTask,
  createAgent,
  fetchCustomProviders,
  createCustomProvider,
  type AgentOnboardingSummary,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { useModalResizePersist } from "../hooks/useModalResizePersist";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";
import { ClaudeCliProviderCard } from "./ClaudeCliProviderCard";
import { CursorCliProviderCard } from "./CursorCliProviderCard";
import { LlamaCppProviderCard } from "./LlamaCppProviderCard";
import { LoginInstructions } from "./LoginInstructions";
import { OAuthManualCodeForm } from "./OAuthManualCodeForm";
import { OnboardingDisclosure } from "./OnboardingDisclosure";
import { CustomProviderForm } from "./CustomProviderForm";
import { PluginSlot } from "./PluginSlot";
import { appendTokenQuery, OAUTH_RELOGIN_SUCCESS_EVENT } from "../auth";
import { copyTextToClipboard } from "../utils/copyToClipboard";
import { filterVisibleOnboardingAndSettingsProviders } from "./providerVisibility";
import { useShellConnection } from "../hooks/useShellConnection";
import { useConfirm } from "../hooks/useConfirm";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "./AgentAvatar";
import { ErrorBoundary } from "./ErrorBoundary";
import { AGENT_PRESETS, getPresetById } from "./agent-presets";
import {
  buildAgentCreatePayload,
  mapOnboardingSummaryToAgentDraft,
  mapPresetToAgentDraft,
  type AgentDraftValues,
} from "./agent-presets/agentCreatePayload";

const ExperimentalAgentOnboardingModal = lazy(() =>
  import("./ExperimentalAgentOnboardingModal").then((m) => ({ default: m.ExperimentalAgentOnboardingModal })),
);

const mapLegacyCustomProviderToConfig = (
  provider: CustomProvider | CustomProviderConfig,
): CustomProviderConfig => ({
  id: provider.id,
  name: provider.name,
  baseUrl: provider.baseUrl,
  api:
    "api" in provider
      ? provider.api
      : provider.apiType === "anthropic-compatible"
        ? "anthropic-messages"
        : "openai-responses",
  apiKey: provider.apiKey,
  models: provider.models?.map((model) => ({ id: model.id, name: model.name })) ?? [],
});

/** Provider-specific API key setup metadata for onboarding form rendering */
interface ApiKeyInfo {
  /** Label shown above the input field, e.g. "OpenAI API Key" */
  fieldLabel: string;
  /** Brief setup instructions: where to find/create the key */
  setupInstructions: string;
  /** URL to the provider's API key dashboard (optional) */
  dashboardUrl?: string;
  /** Hint text shown inside the input via placeholder */
  inputPlaceholder?: string;
  /** Brief text explaining where Fusion uses this key */
  usageDescription: string;
}

interface ProviderInfo {
  description: string;
  apiKeyInfo?: ApiKeyInfo;
}

/** Provider metadata with plain-language descriptions for the onboarding UI */
function getProviderInfoMap(t: (key: string, defaultValue: string) => string): Record<string, ProviderInfo> {
  return {
    anthropic: {
      description: t("setup.providerDesc.anthropic", "Claude models — strong at reasoning, analysis, and code"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.anthropic", "Anthropic API Key"),
        setupInstructions: t("setup.apiKeySetup.anthropic", "Create an API key from your Anthropic Console under API keys."),
        dashboardUrl: "https://console.anthropic.com/settings/keys",
        inputPlaceholder: "sk-ant-...",
        usageDescription: t("setup.apiKeyUsage.anthropic", "Used for Claude models in task execution and planning"),
      },
    },
    "anthropic-api-key": {
      description: t("setup.providerDesc.anthropicApiKey", "Claude models via raw Anthropic API key"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.anthropic", "Anthropic API Key"),
        setupInstructions: t("setup.apiKeySetup.anthropic", "Create an API key from your Anthropic Console under API keys."),
        dashboardUrl: "https://console.anthropic.com/settings/keys",
        inputPlaceholder: "sk-ant-...",
        usageDescription: t("setup.apiKeyUsage.anthropic", "Used for Claude models in task execution and planning"),
      },
    },
    "anthropic-subscription": {
      description: t("setup.providerDesc.anthropicSubscription", "Claude subscription OAuth — sign in with your Anthropic account"),
    },
    openai: {
      description: t("setup.providerDesc.openai", "GPT models — versatile for a wide range of tasks"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.openai", "OpenAI API Key"),
        setupInstructions: t("setup.apiKeySetup.openai", "Create an API key from your OpenAI dashboard under API keys."),
        dashboardUrl: "https://platform.openai.com/api-keys",
        inputPlaceholder: "sk-...",
        usageDescription: t("setup.apiKeyUsage.openai", "Used for GPT models in task execution and planning"),
      },
    },
    "openai-codex": { description: t("setup.providerDesc.openaiCodex", "Codex models by OpenAI — optimized for coding tasks") },
    google: { description: t("setup.providerDesc.google", "Gemini models — multimodal with strong reasoning") },
    gemini: { description: t("setup.providerDesc.gemini", "Gemini models — multimodal with strong reasoning") },
    ollama: {
      description: t("setup.providerDesc.ollama", "Run open-source models locally on your machine"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.ollama", "Ollama Endpoint"),
        setupInstructions: t("setup.apiKeySetup.ollama", "Enter your Ollama endpoint URL (for example http://localhost:11434)."),
        inputPlaceholder: "http://localhost:11434",
        usageDescription: t("setup.apiKeyUsage.ollama", "Connects to your local Ollama instance"),
      },
    },
    minimax: {
      description: t("setup.providerDesc.minimax", "MiniMax models — cost-effective for high-volume usage"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.minimax", "MiniMax API Key"),
        setupInstructions: t("setup.apiKeySetup.minimax", "Generate an API key from the MiniMax platform developer console."),
        dashboardUrl: "https://platform.minimaxi.com/",
        inputPlaceholder: t("setup.apiKeyPlaceholder.minimax", "Enter your MiniMax API key"),
        usageDescription: t("setup.apiKeyUsage.minimax", "Used for MiniMax models in task execution"),
      },
    },
    zai: {
      description: t("setup.providerDesc.zai", "GLM models by Zhipu AI — strong multilingual support"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.zai", "Zhipu AI API Key"),
        setupInstructions: t("setup.apiKeySetup.zai", "Create an API key in the Zhipu AI open platform account settings."),
        dashboardUrl: "https://open.bigmodel.cn/",
        inputPlaceholder: t("setup.apiKeyPlaceholder.zai", "Enter your Zhipu AI API key"),
        usageDescription: t("setup.apiKeyUsage.zai", "Used for GLM models in task execution"),
      },
    },
    kimi: { description: t("setup.providerDesc.kimi", "Kimi by Moonshot AI — long-context capabilities") },
    moonshot: { description: t("setup.providerDesc.moonshot", "Kimi by Moonshot AI — long-context capabilities") },
    "kimi-coding": {
      description: t("setup.providerDesc.kimiCoding", "Kimi by Moonshot AI — long-context capabilities"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.kimiCoding", "Kimi API Key"),
        setupInstructions: t("setup.apiKeySetup.kimiCoding", "Create your API key in the Moonshot platform account settings."),
        dashboardUrl: "https://platform.moonshot.cn/",
        inputPlaceholder: t("setup.apiKeyPlaceholder.kimiCoding", "Enter your Kimi API key"),
        usageDescription: t("setup.apiKeyUsage.kimiCoding", "Used for Kimi/Moonshot AI models in task execution and planning"),
      },
    },
    openrouter: {
      description: t("setup.providerDesc.openrouter", "OpenRouter — route requests across multiple AI providers"),
      apiKeyInfo: {
        fieldLabel: t("setup.apiKeyLabel.openrouter", "OpenRouter API Key"),
        setupInstructions: t("setup.apiKeySetup.openrouter", "Create an API key from your OpenRouter account key management page."),
        dashboardUrl: "https://openrouter.ai/keys",
        inputPlaceholder: "sk-or-v1-...",
        usageDescription: t("setup.apiKeyUsage.openrouter", "Routes to multiple AI model providers through a single key"),
      },
    },
  };
}

const PROVIDER_KEY_HINTS: Record<string, {
  pattern: RegExp;
  hint: string;
  example: string;
}> = {
  anthropic: { pattern: /^sk-ant-/, hint: "Starts with sk-ant-", example: "sk-ant-api03-..." },
  "anthropic-api-key": { pattern: /^sk-ant-/, hint: "Starts with sk-ant-", example: "sk-ant-api03-..." },
  openai: { pattern: /^sk-/, hint: "Starts with sk-", example: "sk-..." },
  "openai-codex": { pattern: /^sk-/, hint: "Starts with sk-", example: "sk-..." },
  openrouter: { pattern: /^sk-or-/, hint: "Starts with sk-or-", example: "sk-or-v1-..." },
  google: { pattern: /^AIza/, hint: "Starts with AIza", example: "AIza..." },
  gemini: { pattern: /^AIza/, hint: "Starts with AIza", example: "AIza..." },
  minimax: { pattern: /^.{8,}$/, hint: "At least 8 characters", example: "..." },
  ollama: { pattern: /^.+$/, hint: "Any non-empty value", example: "ollama" },
  zai: { pattern: /^.{8,}$/, hint: "At least 8 characters", example: "..." },
  kimi: { pattern: /^.{8,}$/, hint: "At least 8 characters", example: "..." },
  "kimi-coding": { pattern: /^.{8,}$/, hint: "At least 8 characters", example: "..." },
  moonshot: { pattern: /^.{8,}$/, hint: "At least 8 characters", example: "..." },
};

const PROVIDER_KEY_HINTS_FALLBACK = {
  pattern: /^.{8,}$/,
  hint: "At least 8 characters",
  example: "...",
};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  "anthropic-api-key": "Anthropic API Key",
  "anthropic-subscription": "Anthropic Subscription",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  openrouter: "OpenRouter",
  google: "Google",
  gemini: "Gemini",
  minimax: "MiniMax",
  ollama: "Ollama",
  zai: "Zhipu AI",
  kimi: "Kimi",
  "kimi-coding": "Kimi Coding",
  moonshot: "Moonshot",
};

const getManualCodeLoginWarningMessage = (providerName: string) =>
  `After you sign in with ${providerName}, the browser will try to redirect to a localhost address that this dashboard can't reach. The redirect tab will look like it failed. Before that happens, copy the full URL from the browser address bar — you'll paste it back here to finish login. Continue?`;

function getProviderDisplayName(providerId: string): string {
  if (PROVIDER_DISPLAY_NAMES[providerId]) {
    return PROVIDER_DISPLAY_NAMES[providerId];
  }

  const normalized = providerId.trim();
  if (!normalized) {
    return "This provider";
  }

  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

/*
FNXC:ProviderAuth 2026-06-29-23:58:
Onboarding quick start must show Anthropic subscription OAuth and raw Anthropic API-key auth as separate first-class cards; keep the legacy `anthropic` id as a fallback only for older status payloads.
*/
const QUICK_START_PROVIDER_IDS = ["anthropic-subscription", "anthropic-api-key", "anthropic", "openai", "google", "gemini", "ollama"] as const;

const ONBOARDING_CURATED_PROVIDER_FAMILY_ORDER = [
  "anthropic",
  "claude-cli",
  "droid-cli",
  "cursor-cli",
  "llama-cpp",
  "openai-codex",
  "gemini",
  "minimax",
  "kimi",
  "zai",
] as const;

const ONBOARDING_PROVIDER_FAMILY_ALIASES: Record<string, (typeof ONBOARDING_CURATED_PROVIDER_FAMILY_ORDER)[number]> = {
  "anthropic-subscription": "anthropic",
  "anthropic-api-key": "anthropic",
  anthropic: "anthropic",
  "claude-cli": "claude-cli",
  "droid-cli": "droid-cli",
  "llama-cpp": "llama-cpp",
  "openai-codex": "openai-codex",
  google: "gemini",
  gemini: "gemini",
  minimax: "minimax",
  kimi: "kimi",
  moonshot: "kimi",
  "kimi-coding": "kimi",
  zai: "zai",
};

const ONBOARDING_PROVIDER_ALIAS_ORDER: Record<string, string[]> = {
  gemini: ["google", "gemini"],
  kimi: ["kimi", "moonshot", "kimi-coding"],
};

function getOnboardingProviderFamilyId(providerId: string): string {
  return ONBOARDING_PROVIDER_FAMILY_ALIASES[providerId] ?? providerId;
}

function getOnboardingProviderCuratedRank(providerId: string): number {
  const familyId = getOnboardingProviderFamilyId(providerId);
  const rank = ONBOARDING_CURATED_PROVIDER_FAMILY_ORDER.indexOf(
    familyId as (typeof ONBOARDING_CURATED_PROVIDER_FAMILY_ORDER)[number],
  );
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

function compareOnboardingProviders(a: AuthProvider, b: AuthProvider): number {
  if (a.authenticated !== b.authenticated) {
    return a.authenticated ? -1 : 1;
  }

  const curatedRankA = getOnboardingProviderCuratedRank(a.id);
  const curatedRankB = getOnboardingProviderCuratedRank(b.id);

  if (curatedRankA !== curatedRankB) {
    return curatedRankA - curatedRankB;
  }

  const familyA = getOnboardingProviderFamilyId(a.id);
  const familyB = getOnboardingProviderFamilyId(b.id);
  if (familyA !== familyB) {
    return familyA.localeCompare(familyB);
  }

  const aliasOrder = ONBOARDING_PROVIDER_ALIAS_ORDER[familyA];
  if (aliasOrder) {
    const aliasRankA = aliasOrder.indexOf(a.id);
    const aliasRankB = aliasOrder.indexOf(b.id);
    if (aliasRankA !== aliasRankB) {
      return (aliasRankA === -1 ? Number.POSITIVE_INFINITY : aliasRankA)
        - (aliasRankB === -1 ? Number.POSITIVE_INFINITY : aliasRankB);
    }
  }

  const nameCompare = a.name.localeCompare(b.name);
  if (nameCompare !== 0) {
    return nameCompare;
  }

  return a.id.localeCompare(b.id);
}

function validateApiKeyFormat(providerId: string, key: string, t: (key: string, defaultValue: string, options?: Record<string, unknown>) => string): string | null {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return t("setup.apiKeyRequired", "API key is required");
  }

  const providerHint = PROVIDER_KEY_HINTS[providerId] ?? PROVIDER_KEY_HINTS_FALLBACK;
  if (providerHint.pattern.test(trimmedKey)) {
    return null;
  }

  const providerName = getProviderDisplayName(providerId);
  return t("setup.apiKeyFormatError", "{{providerName}} keys should follow this format: {{hint}} (e.g. {{example}})", { providerName, hint: providerHint.hint, example: providerHint.example });
}

function getApiKeyInfoFallback(t: (key: string, defaultValue: string) => string): ApiKeyInfo {
  return {
    fieldLabel: t("setup.apiKeyLabel.fallback", "API Key"),
    setupInstructions: t("setup.apiKeySetup.fallback", "Enter your API key for this provider."),
    inputPlaceholder: t("setup.apiKeyPlaceholder.fallback", "Enter API key"),
    usageDescription: t("setup.apiKeyUsage.fallback", "Used by Fusion to authenticate requests to this provider"),
  };
}

function getProviderInfo(providerId: string, t: (key: string, defaultValue: string) => string): ProviderInfo {
  const fallback: ProviderInfo = {
    description: t("setup.providerDesc.fallback", "AI provider — connect to start using AI models"),
    apiKeyInfo: getApiKeyInfoFallback(t),
  };
  return getProviderInfoMap(t)[providerId] ?? fallback;
}

function getApiKeyInfo(provider: AuthProvider, t: (key: string, defaultValue: string) => string): ApiKeyInfo {
  const info = getProviderInfo(provider.id, t);
  return info.apiKeyInfo ?? getApiKeyInfoFallback(t);
}

interface ReadinessItem {
  label: string;
  status: "connected" | "missing" | "skipped";
  detail?: string;
}

interface ReadinessSummaryProps {
  items: ReadinessItem[];
}

function ReadinessSummary({ items }: ReadinessSummaryProps) {
  const { t } = useTranslation("app");
  const hasAttentionItems = items.some((item) => item.status !== "connected");

  if (!hasAttentionItems) {
    return (
      <div className="onboarding-readiness-summary" data-testid="readiness-summary" role="status">
        <p className="onboarding-readiness-all-connected">{t("setup.readinessAllConnected", "✓ All integrations connected")}</p>
      </div>
    );
  }

  return (
    <div className="onboarding-readiness-summary" data-testid="readiness-summary" role="status">
      <p className="onboarding-readiness-header">{t("setup.readinessSummaryHeader", "Setup Summary")}</p>
      {items.map((item) => {
        const statusIcon =
          item.status === "connected"
            ? "✓"
            : item.status === "missing"
              ? "⚠"
              : "○";

        return (
          <div
            key={item.label}
            className={`onboarding-readiness-item onboarding-readiness-item--${item.status}`}
            data-status={item.status}
          >
            <span className="onboarding-readiness-icon" aria-hidden="true">
              {statusIcon}
            </span>
            <span className="onboarding-readiness-content">
              <span className="onboarding-readiness-label">{item.label}</span>
              {item.detail && <span className="onboarding-readiness-detail">{item.detail}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

interface ApiKeyEntryFormProps {
  provider: AuthProvider;
  apiKeyInfo: ApiKeyInfo;
  inputValue: string;
  isSaving: boolean;
  error?: string;
  success?: string | null;
  isConnected: boolean;
  onInputChange: (providerId: string, key: string) => void;
  onSave: (providerId: string, key: string) => void | Promise<void>;
  onClear: (providerId: string) => void | Promise<void>;
}

function ApiKeyEntryForm({
  provider,
  apiKeyInfo,
  inputValue,
  isSaving,
  error,
  success,
  isConnected,
  onInputChange,
  onSave,
  onClear,
}: ApiKeyEntryFormProps) {
  const { t } = useTranslation("app");
  const inputId = `onboarding-apikey-input-${provider.id}`;
  const saveDisabled = isSaving || !inputValue.trim();
  const providerKeyHint = PROVIDER_KEY_HINTS[provider.id];
  const inputClassName = `input onboarding-apikey-input${
    error ? " onboarding-apikey-input--error" : ""
  }${success ? " onboarding-apikey-input--success" : ""}`;

  const advancedSetupDetails = (
    <>
      {providerKeyHint && (
        <small className="onboarding-apikey-hint">
          {t("setup.apiKeyFormatHint", "Format: {{hint}}", { hint: providerKeyHint.hint })}
        </small>
      )}
      <p className="onboarding-apikey-instructions">{apiKeyInfo.setupInstructions}</p>
      {apiKeyInfo.dashboardUrl && (
        <a
          href={apiKeyInfo.dashboardUrl}
          target="_blank"
          rel="noreferrer"
          className="onboarding-apikey-dashboard-link"
        >
          {t("setup.getApiKeyLink", "Get your API key →")}
        </a>
      )}
      <p className="onboarding-apikey-usage">{apiKeyInfo.usageDescription}</p>
    </>
  );

  if (isConnected) {
    return (
      <div className="onboarding-apikey-form" data-testid={`onboarding-apikey-form-${provider.id}`}>
        <div className="onboarding-apikey-connected-header">
          <strong className="onboarding-provider-card__name">{apiKeyInfo.fieldLabel}</strong>
          <span className="auth-status-badge connected">{t("setup.apiKeySaved", "✓ API key saved")}</span>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => onClear(provider.id)}
          disabled={isSaving}
        >
          {isSaving ? t("setup.removingKey", "Removing…") : t("setup.removeKey", "Remove Key")}
        </button>
        <OnboardingDisclosure summary={t("setup.advancedSetupDetails", "Advanced setup details")}>
          {advancedSetupDetails}
        </OnboardingDisclosure>
        {error && <small className="field-error">{error}</small>}
      </div>
    );
  }

  return (
    <div className="onboarding-apikey-form" data-testid={`onboarding-apikey-form-${provider.id}`}>
      <label htmlFor={inputId} className="onboarding-apikey-field-label">
        {apiKeyInfo.fieldLabel}
      </label>
      <div className="onboarding-apikey-input-row">
        <input
          id={inputId}
          type="password"
          className={inputClassName}
          placeholder={apiKeyInfo.inputPlaceholder ?? t("setup.enterApiKey", "Enter API key")}
          value={inputValue}
          onChange={(e) => onInputChange(provider.id, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onSave(provider.id, inputValue);
            }
          }}
          data-testid={inputId}
        />
        <button
          className="btn btn-primary btn-sm"
          onClick={() => onSave(provider.id, inputValue)}
          disabled={saveDisabled}
          data-testid={`onboarding-apikey-save-${provider.id}`}
        >
          {isSaving ? t("setup.savingKey", "Saving…") : t("setup.saveKey", "Save")}
        </button>
      </div>
      {error && <small className="field-error">{error}</small>}
      {success && !error && (
        <small
          className="onboarding-apikey-success"
          data-testid={`onboarding-apikey-success-${provider.id}`}
        >
          {success}
        </small>
      )}
      <OnboardingDisclosure summary={t("setup.advancedSetupDetails", "Advanced setup details")}>
        {advancedSetupDetails}
      </OnboardingDisclosure>
    </div>
  );
}

import {
  getOnboardingState,
  saveOnboardingState,
  markOnboardingCompleted,
  markStepSkipped,
  getSkippedSteps,
  getStepData,
  ONBOARDING_FLOW_STEPS,
  type OnboardingStep,
} from "./model-onboarding-state";
import { trackOnboardingEvent } from "./onboarding-events";

export interface ModelOnboardingModalProps {
  /** Called when onboarding is complete or dismissed */
  onComplete: () => void;
  /** Toast helper */
  addToast: (message: string, type?: ToastType) => void;
  /** Currently selected project ID (required for first-task actions) */
  projectId?: string;
  /** Optional callback to open project setup wizard when no project is selected */
  onOpenSetupWizard?: () => void;
  /** Optional callback when user wants to open new task creation */
  onOpenNewTask?: () => void;
  /** Optional callback when user wants to open GitHub import */
  onOpenGitHubImport?: () => void;
  /** First task created from the onboarding flow, if available */
  firstCreatedTask?: Task | null;
  /** Optional callback when user wants to open the created task detail */
  onViewTask?: (task: Task) => void;
  /** Enables the AI interview entry point while template creation and skip remain available. */
  agentOnboardingEnabled?: boolean;
}

/** Outcome states for OAuth login attempts */
export type LoginOutcome = "pending" | "success" | "timeout" | "failed" | "cancelled";

/** Provider connection status for UI display */
export type ProviderConnectionStatus = "connected" | "not-connected" | "skipped" | "retry";

/** GitHub-specific status variants for richer connection feedback */
type GitHubConnectionStatus = "connected" | "failed" | "pending" | "skipped" | "not-connected";

interface GhCliStatus {
  available: boolean;
  authenticated: boolean;
}

/** Maximum number of poll cycles before timing out (150 × 2s = 5 minutes) */
const MAX_POLL_CYCLES = 150;

/**
 * Multi-step onboarding modal that guides users through:
 * 1. AI Setup - Provider credential setup (OAuth login or API key entry) and default model selection
 * 2. GitHub (Optional) - GitHub connection status and login
 * 3. Project Setup - Register a project directory (or clone a repository URL via setup wizard)
 * 4. Agent - Optional persistent coordinating agent from a template or AI-generated draft
 * 5. First Task - CTA to create first task or import from GitHub
 *
 * Dismissing the modal marks onboarding as complete to prevent repeated popups.
 */
export function ModelOnboardingModal({
  onComplete,
  addToast,
  projectId,
  onOpenSetupWizard,
  onOpenNewTask,
  onOpenGitHubImport,
  firstCreatedTask,
  onViewTask,
  agentOnboardingEnabled = false,
}: ModelOnboardingModalProps) {
  const { t } = useTranslation("app");
  const { confirm } = useConfirm();
  /*
  FNXC:Onboarding 2026-06-22-04:16:
  First-time provider/GitHub setup must pass through the same optional first-agent flow before first-task creation.
  Users can create or skip a coordinating agent because Fusion can still start temporary agents to plan, code, review, and merge tasks.
  */
  const ceoPreset = useMemo(
    () => getPresetById("ceo") ?? AGENT_PRESETS[0]!,
    [],
  );
  // Initialize from persisted state if available (allows resume from last step)
  const persistedState = getOnboardingState();
  const persistedStep = persistedState?.currentStep;
  const initialStep: OnboardingStep =
    persistedStep === "complete"
      ? "ai-setup"
      : ONBOARDING_FLOW_STEPS.includes(persistedStep as (typeof ONBOARDING_FLOW_STEPS)[number])
        ? (persistedStep as OnboardingStep)
        : "ai-setup";
  // Restore completed/skipped steps from persisted state
  const persistedCompletedSteps = persistedState?.completedSteps ?? [];
  const persistedSkippedSteps = persistedState?.skippedSteps ?? getSkippedSteps();

  const [isOpen, setIsOpen] = useState(true);
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [completedSteps, setCompletedSteps] = useState<OnboardingStep[]>(persistedCompletedSteps);
  const [skippedSteps, setSkippedSteps] = useState<OnboardingStep[]>(persistedSkippedSteps);
  const [showTaskCreated, setShowTaskCreated] = useState(false);
  const [firstTaskDescription, setFirstTaskDescription] = useState("");
  const [isCreatingFirstTask, setIsCreatingFirstTask] = useState(false);
  const [taskCreationError, setTaskCreationError] = useState<string | null>(null);
  const [inlineCreatedTask, setInlineCreatedTask] = useState<Task | null>(null);
  const [selectedAgentPresetId, setSelectedAgentPresetId] = useState(ceoPreset.id);
  const [agentDraft, setAgentDraft] = useState<AgentDraftValues>(() => mapPresetToAgentDraft(ceoPreset));
  const [isCreatingAgent, setIsCreatingAgent] = useState(false);
  const [agentCreationError, setAgentCreationError] = useState<string | null>(null);
  const [isAgentInterviewOpen, setIsAgentInterviewOpen] = useState(false);
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [ghCliStatus, setGhCliStatus] = useState<GhCliStatus | undefined>(undefined);
  const [authLoading, setAuthLoading] = useState(true);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
  const [loginInstructions, setLoginInstructions] = useState<Record<string, string>>({});
  const [manualCodeConfigs, setManualCodeConfigs] = useState<Record<string, ManualOAuthCodeInfo>>({});
  const [deviceCodes, setDeviceCodes] = useState<Record<string, OAuthDeviceCodeInfo>>({});
  const [manualCodeInputs, setManualCodeInputs] = useState<Record<string, string>>({});
  const [manualCodeSubmitInProgress, setManualCodeSubmitInProgress] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyErrors, setApiKeyErrors] = useState<Record<string, string>>({});
  const [apiKeySuccess, setApiKeySuccess] = useState<Record<string, string | null>>({});
  const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([]);
  const [showCustomProviderForm, setShowCustomProviderForm] = useState(false);
  const [customProviderSaving, setCustomProviderSaving] = useState(false);
  const [customProviderError, setCustomProviderError] = useState<string | undefined>();
  const [shellProfileName, setShellProfileName] = useState("Remote Server");
  const [shellServerUrl, setShellServerUrl] = useState("");
  const [shellAuthToken, setShellAuthToken] = useState("");
  const [shellConnectionSaving, setShellConnectionSaving] = useState(false);
  const [shellConnectionError, setShellConnectionError] = useState<string | null>(null);
  const apiKeySuccessTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const onboardingContentRef = useRef<HTMLDivElement | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const agentErrorRef = useRef<HTMLDivElement | null>(null);
  const [loginOutcomes, setLoginOutcomes] = useState<Record<string, LoginOutcome>>({});
  const lastAutoCopiedDeviceCodesRef = useRef<Record<string, string>>({});
  const [isGithubSkipped, setIsGithubSkipped] = useState<boolean>(() => {
    const state = getOnboardingState();
    return state?.stepData?.github?.skipped === true;
  });
  const pollCountRef = useRef<number>(0);
  const previousCreatedTaskRef = useRef<Task | null | undefined>(firstCreatedTask);
  const { shellApi, state: shellState } = useShellConnection();
  const hasTrackedWizardOpenRef = useRef(false);
  const resumedFromStep = persistedState?.currentStep;
  const isResumedFlow = !!persistedState && persistedState.currentStep !== "complete";

  useModalResizePersist(modalRef, isOpen, "fusion:model-onboarding-modal-size");

  // Scroll the content area to the top whenever the step changes so the user
  // always lands at the start of the next page instead of mid-scroll from the
  // previous one.
  useEffect(() => {
    const content = onboardingContentRef.current;
    if (!content) return;
    content.scrollTop = 0;
  }, [step]);

  useEffect(() => {
    const copilotDeviceCode = deviceCodes["github-copilot"];
    if (!copilotDeviceCode?.userCode) {
      return;
    }

    if (lastAutoCopiedDeviceCodesRef.current["github-copilot"] === copilotDeviceCode.userCode) {
      return;
    }

    lastAutoCopiedDeviceCodesRef.current["github-copilot"] = copilotDeviceCode.userCode;
    void copyTextToClipboard(copilotDeviceCode.userCode);
  }, [deviceCodes]);

  // Initialize skippedProviders from persisted state
  const [skippedProviders, setSkippedProviders] = useState<Record<string, boolean>>(
    () => {
      const state = getOnboardingState();
      const data = state?.stepData?.["ai-setup"];
      return (data?.skippedProviders as Record<string, boolean>) ?? {};
    }
  );

  // Step definitions for progress indicator.
  // Keep labels aligned with the ordered ONBOARDING_FLOW_STEPS state contract.
  const steps = [
    { key: "ai-setup" as const, label: t("setup.stepAiSetup", "AI Setup") },
    { key: "github" as const, label: t("setup.stepGithub", "GitHub") },
    { key: "project-setup" as const, label: t("setup.stepProject", "Project") },
    { key: "agent" as const, label: t("setup.stepAgent", "Agent") },
    { key: "first-task" as const, label: t("setup.stepFirstTask", "First Task") },
  ];

  // Get current step index for progress indicator.
  // Keep the stepper in a fully-complete visual state when the completion screen is shown.
  const currentStepIndex = steps.findIndex((s) => s.key === step);
  const effectiveStepIndex = step === "complete" ? steps.length : currentStepIndex;

  // Persist step state whenever it changes (for resume functionality)
  useEffect(() => {
    if (step !== "complete") {
      saveOnboardingState(step, { completedSteps, skippedSteps });
    }
  }, [step, completedSteps, skippedSteps]);

  useEffect(() => {
    if (hasTrackedWizardOpenRef.current) {
      return;
    }

    hasTrackedWizardOpenRef.current = true;
    trackOnboardingEvent("onboarding:wizard-opened", {
      source: isResumedFlow ? "resume" : "initial",
      resumedFromStep,
    });
  }, [isResumedFlow, resumedFromStep]);

  useEffect(() => {
    const hadCreatedTask = previousCreatedTaskRef.current != null;
    const hasCreatedTask = firstCreatedTask != null;

    if (!hadCreatedTask && hasCreatedTask) {
      setShowTaskCreated(true);
    }

    if (!hasCreatedTask) {
      setShowTaskCreated(false);
    }

    previousCreatedTaskRef.current = firstCreatedTask;
  }, [firstCreatedTask]);

  useEffect(() => {
    if (agentCreationError) {
      agentErrorRef.current?.focus();
    }
  }, [agentCreationError]);

  // Auto-mark unconnected providers as skipped when leaving ai-setup step
  // Only skip if NO providers are connected (if at least one is connected, others remain "Not connected")
  const prevStepRef = useRef<OnboardingStep>(initialStep);
  useEffect(() => {
    if (prevStepRef.current === "ai-setup" && step !== "ai-setup") {
      // Check if any AI provider is connected
      const hasConnectedProvider = authProviders.some(
        (p) => p.id !== "github" && p.authenticated
      );
      // Only mark as skipped if no providers are connected
      if (!hasConnectedProvider) {
        const newlySkipped: Record<string, boolean> = {};
        for (const p of authProviders) {
          if (p.id !== "github" && !p.authenticated && !skippedProviders[p.id]) {
            newlySkipped[p.id] = true;
          }
        }
        if (Object.keys(newlySkipped).length > 0) {
          const updated = { ...skippedProviders, ...newlySkipped };
          setSkippedProviders(updated);
          saveOnboardingState(step, {
            stepData: { "ai-setup": { skippedProviders: updated } },
          });
        }
      }
    }
    prevStepRef.current = step;
  }, [step, authProviders, skippedProviders]);

  // Load auth providers
  const loadAuthStatus = useCallback(async () => {
    try {
      const { providers, ghCli } = await fetchAuthStatus();
      const visibleProviders = filterVisibleOnboardingAndSettingsProviders(providers);
      setAuthProviders(visibleProviders);
      setGhCliStatus(ghCli);
      setLoginInstructions((prev) => {
        const next: Record<string, string> = {};
        for (const [providerId, instructions] of Object.entries(prev)) {
          const provider = visibleProviders.find((candidate) => candidate.id === providerId);
          if (provider && !provider.authenticated && provider.loginInProgress) {
            next[providerId] = instructions;
          }
        }
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
      setLoginOutcomes((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const [providerId, outcome] of Object.entries(prev)) {
          if (outcome !== "pending") {
            continue;
          }
          const provider = visibleProviders.find((candidate) => candidate.id === providerId);
          if (!provider?.loginInProgress) {
            delete next[providerId];
            changed = true;
          }
        }
        return changed ? next : prev;
      });
      // Remove from skippedProviders when a provider becomes authenticated
      setSkippedProviders((prev) => {
        const updated = { ...prev };
        for (const p of visibleProviders) {
          if (p.authenticated && updated[p.id]) {
            delete updated[p.id];
          }
        }
        return Object.keys(updated).length === Object.keys(prev).length ? prev : updated;
      });
    } catch {
      // Silently fail
    }
  }, []);

  const loadCustomProviders = useCallback(async () => {
    try {
      const data = await fetchCustomProviders();
      setCustomProviders((data.providers ?? []).map(mapLegacyCustomProviderToConfig));
    } catch {
      // best effort
    }
  }, []);

  const handleSaveCustomProvider = useCallback(async (config: CustomProviderConfig) => {
    setCustomProviderSaving(true);
    setCustomProviderError(undefined);
    try {
      await createCustomProvider(config);
      await loadCustomProviders();
      await fetchModels().then((response) => setAvailableModels(response.models ?? []));
      setShowCustomProviderForm(false);
    } catch (err) {
      setCustomProviderError(getErrorMessage(err) || t("setup.failedToCreateCustomProvider", "Failed to create custom provider"));
    } finally {
      setCustomProviderSaving(false);
    }
  }, [loadCustomProviders]);

  // Reload auth status when returning to AI Setup step from another step (not on initial mount)
  const aiSetupReturnRef = useRef(false);
  useEffect(() => {
    if (step === "ai-setup") {
      void loadCustomProviders();
    }
    if (aiSetupReturnRef.current) {
      loadAuthStatus();
    }
    aiSetupReturnRef.current = step !== "ai-setup";
  }, [step, loadAuthStatus, loadCustomProviders]);

  useEffect(() => {
    const hasPendingLogin = authProviders.some((provider) => provider.loginInProgress);
    if (!hasPendingLogin) {
      return;
    }
    const interval = setInterval(() => {
      void loadAuthStatus();
    }, 2000);
    return () => clearInterval(interval);
  }, [authProviders, loadAuthStatus]);

  // OAuth status for the GitHub provider (used for OAuth-specific controls like Connect/Disconnect).
  const githubProvider = authProviders.find((p) => p.id === "github");
  const hasGithubProvider = !!githubProvider;
  const isGithubAuthenticated = githubProvider?.authenticated ?? false;
  const isGithubLoginInProgress = githubProvider?.loginInProgress ?? false;
  const isGithubCliAuthenticated = ghCliStatus?.authenticated ?? false;
  // Effective GitHub readiness (matches useSetupReadiness): OAuth OR authenticated gh CLI session.
  const isGitHubReady = isGithubAuthenticated || isGithubCliAuthenticated;
  const isGitHubReadyViaCli = !isGithubAuthenticated && isGithubCliAuthenticated;

  // Get provider connection status for UI display
  const getProviderStatus = useCallback((provider: AuthProvider): ProviderConnectionStatus => {
    if (provider.authenticated) {
      return "connected";
    }
    // Check for retry-able failure states (from login outcomes)
    const loginOutcome = (loginOutcomes as Record<string, string> | undefined)?.[provider.id];
    if (loginOutcome === "timeout" || loginOutcome === "failed") {
      return "retry";
    }
    if (skippedProviders[provider.id]) {
      return "skipped";
    }
    return "not-connected";
  }, [loginOutcomes, skippedProviders]);

  // Status badge component for provider connection status
  function ProviderStatusBadge({ status }: { status: ProviderConnectionStatus }) {
    const config: Record<ProviderConnectionStatus, { text: string; className: string }> = {
      connected: { text: t("setup.statusConnected", "✓ Connected"), className: "auth-status-badge connected" },
      "not-connected": { text: t("setup.statusNotConnected", "Not connected"), className: "auth-status-badge not-connected" },
      skipped: { text: t("setup.statusSkipped", "Skipped"), className: "auth-status-badge skipped" },
      retry: { text: t("setup.statusRetry", "Retry"), className: "auth-status-badge retry" },
    };
    const { text, className: badgeClassName } = config[status];
    return (
      <span
        data-testid="provider-status-badge"
        className={badgeClassName}
        data-status={status}
      >
        {text}
      </span>
    );
  }

  const getGitHubStatus = useCallback((): GitHubConnectionStatus => {
    if (isGitHubReady) {
      return "connected";
    }

    const githubOutcome = loginOutcomes["github"];
    if (githubOutcome === "pending") {
      return "pending";
    }
    if (githubOutcome === "failed" || githubOutcome === "timeout") {
      return "failed";
    }
    if (isGithubSkipped) {
      return "skipped";
    }

    return "not-connected";
  }, [isGitHubReady, loginOutcomes, isGithubSkipped]);

  function GitHubStatusBadge({ status }: { status: GitHubConnectionStatus }) {
    const config: Record<GitHubConnectionStatus, { text: string; className: string }> = {
      connected: { text: t("setup.statusConnected", "✓ Connected"), className: "auth-status-badge connected" },
      pending: { text: t("setup.statusConnecting", "⏳ Connecting…"), className: "auth-status-badge pending" },
      failed: { text: t("setup.statusConnectionFailed", "✗ Connection failed"), className: "auth-status-badge retry" },
      skipped: { text: t("setup.statusSkipped", "Skipped"), className: "auth-status-badge skipped" },
      "not-connected": { text: t("setup.statusNotConnected", "Not connected"), className: "auth-status-badge not-connected" },
    };

    const { text, className: badgeClassName } = config[status];
    return (
      <span
        data-testid="github-status-badge"
        className={badgeClassName}
        data-status={status}
      >
        {text}
      </span>
    );
  }

  // Load models
  const loadModels = useCallback(async () => {
    try {
      const response = await fetchModels();
      setAvailableModels(response.models);
    } catch {
      // Silently fail
    }
  }, []);

  // Load global settings to hydrate saved default model (for reopen flow)
  const loadGlobalSettings = useCallback(async () => {
    try {
      const globalSettings = await fetchGlobalSettings();
      // If a default model is configured, pre-select it
      if (globalSettings.defaultProvider && globalSettings.defaultModelId) {
        const defaultModelValue = `${globalSettings.defaultProvider}/${globalSettings.defaultModelId}`;
        setSelectedModel(defaultModelValue);
      }
    } catch {
      // Silently fail - onboarding still works without hydration
    }
  }, []);

  // Initial data load
  useEffect(() => {
    Promise.all([loadAuthStatus(), loadModels(), loadGlobalSettings()]).finally(() =>
      setAuthLoading(false),
    );
  }, [loadAuthStatus, loadModels, loadGlobalSettings]);

  // Restore login outcomes from persisted state on mount
  useEffect(() => {
    const persistedStepData = getStepData("ai-setup");
    if (persistedStepData?.loginOutcomes) {
      const persistedOutcomes = persistedStepData.loginOutcomes as Record<string, LoginOutcome>;
      // Filter out stale "pending" entries from previous sessions
      const filteredOutcomes: Record<string, LoginOutcome> = {};
      for (const [providerId, outcome] of Object.entries(persistedOutcomes)) {
        if (outcome !== "pending") {
          filteredOutcomes[providerId] = outcome;
        }
      }
      if (Object.keys(filteredOutcomes).length > 0) {
        setLoginOutcomes(filteredOutcomes);
      }
    }
  }, []);

  // Helper to persist login outcome to onboarding state
  const persistLoginOutcome = useCallback((providerId: string, outcome: LoginOutcome) => {
    saveOnboardingState(step, {
      completedSteps,
      stepData: {
        "ai-setup": {
          loginOutcomes: {
            [providerId]: outcome,
          },
        },
      },
    });
  }, [step, completedSteps]);

  // Persist terminal login outcomes whenever they transition
  useEffect(() => {
    const terminalOutcomes = Object.entries(loginOutcomes).filter(
      ([_, outcome]) => outcome !== "pending"
    );
    for (const [providerId, outcome] of terminalOutcomes) {
      persistLoginOutcome(providerId, outcome);
    }
  }, [loginOutcomes, persistLoginOutcome]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      Object.values(apiKeySuccessTimers.current).forEach(clearTimeout);
      apiKeySuccessTimers.current = {};
    };
  }, []);

  const setGitHubSkippedState = useCallback((skipped: boolean) => {
    setIsGithubSkipped(skipped);
    saveOnboardingState(step, {
      completedSteps,
      stepData: {
        github: {
          skipped,
        },
      },
    });
  }, [step, completedSteps]);

  const getFlowIndex = useCallback((value: OnboardingStep) => {
    if (value === "complete") {
      return -1;
    }
    return ONBOARDING_FLOW_STEPS.indexOf(value);
  }, []);

  // Navigate to next step
  const handleNext = useCallback(() => {
    // Mark current step as completed before moving forward
    setCompletedSteps((prev) => [...new Set([...prev, step])]);
    // Completing a step clears any prior skipped status
    setSkippedSteps((prev) => prev.filter((s) => s !== step));
    trackOnboardingEvent("onboarding:step-completed", { step });

    if (step === "github" && !isGithubAuthenticated) {
      setGitHubSkippedState(false);
    }

    const currentIndex = getFlowIndex(step);
    if (currentIndex >= 0 && currentIndex < ONBOARDING_FLOW_STEPS.length - 1) {
      setStep(ONBOARDING_FLOW_STEPS[currentIndex + 1]);
    }
  }, [step, isGithubAuthenticated, setGitHubSkippedState, getFlowIndex]);

  // Navigate forward without marking completion
  const handleSkip = useCallback(() => {
    setSkippedSteps((prev) => [...new Set([...prev, step])]);
    markStepSkipped(step);
    trackOnboardingEvent("onboarding:step-skipped", { step });

    if (step === "github" && !isGithubAuthenticated) {
      setGitHubSkippedState(true);
    }

    const currentIndex = getFlowIndex(step);
    if (currentIndex >= 0 && currentIndex < ONBOARDING_FLOW_STEPS.length - 1) {
      setStep(ONBOARDING_FLOW_STEPS[currentIndex + 1]);
    }
  }, [step, isGithubAuthenticated, setGitHubSkippedState, getFlowIndex]);

  // Navigate to previous step
  const handleBack = useCallback(() => {
    // Remove current step from completed/skipped when going back (undoing progress)
    const currentStepKey = step;
    setCompletedSteps((prev) => prev.filter((s) => s !== currentStepKey));
    setSkippedSteps((prev) => prev.filter((s) => s !== currentStepKey));

    if (currentStepKey === "github" && !isGithubAuthenticated) {
      setGitHubSkippedState(false);
    }

    const currentIndex = getFlowIndex(step);
    if (currentIndex > 0) {
      setStep(ONBOARDING_FLOW_STEPS[currentIndex - 1]);
    }
  }, [step, isGithubAuthenticated, setGitHubSkippedState, getFlowIndex]);

  const handleSkipGitHubStep = useCallback(() => {
    handleSkip();
  }, [handleSkip]);

  const handleAgentPresetSelect = useCallback((presetId: string) => {
    const preset = getPresetById(presetId);
    if (!preset) return;
    setSelectedAgentPresetId(preset.id);
    setAgentDraft(mapPresetToAgentDraft(preset));
    setAgentCreationError(null);
  }, []);

  const handleAgentPresetKeyDown = useCallback((event: KeyboardEvent<HTMLButtonElement>, presetId: string) => {
    const currentIndex = AGENT_PRESETS.findIndex((preset) => preset.id === presetId);
    if (currentIndex < 0) return;

    const lastIndex = AGENT_PRESETS.length - 1;
    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = currentIndex === lastIndex ? 0 : currentIndex + 1;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = currentIndex === 0 ? lastIndex : currentIndex - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    }

    if (nextIndex === null) return;
    event.preventDefault();
    const nextPreset = AGENT_PRESETS[nextIndex];
    handleAgentPresetSelect(nextPreset.id);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`[data-model-onboarding-agent-preset-id="${nextPreset.id}"]`)?.focus();
    });
  }, [handleAgentPresetSelect]);

  const handleApplyAgentDraft = useCallback((draft: AgentOnboardingSummary) => {
    setSelectedAgentPresetId("");
    setAgentDraft(mapOnboardingSummaryToAgentDraft(draft));
    setAgentCreationError(null);
  }, []);

  const handleCreateFirstAgent = useCallback(async () => {
    const targetProjectId = projectId?.trim();
    if (!targetProjectId || !agentDraft.name.trim()) return;

    setIsCreatingAgent(true);
    setAgentCreationError(null);
    try {
      await createAgent(buildAgentCreatePayload(agentDraft), targetProjectId);
      handleNext();
    } catch (err) {
      setAgentCreationError(err instanceof Error ? err.message : t("setup.firstAgentCreateError", "Failed to create agent"));
    } finally {
      setIsCreatingAgent(false);
    }
  }, [agentDraft, handleNext, projectId, t]);

  // OAuth login handler
  const handleLogin = useCallback(
    async (providerId: string) => {
      const provider = authProviders.find((entry) => entry.id === providerId);
      if (provider?.requiresManualCode === true) {
        const shouldContinue = await confirm({
          title: t("setup.manualPastebackTitle", "Heads up — manual paste-back required"),
          message: getManualCodeLoginWarningMessage(provider.name),
          confirmLabel: t("setup.continueToLogin", "Continue to login"),
          cancelLabel: t("setup.cancelLogin", "Cancel"),
        });
        if (!shouldContinue) {
          return;
        }
      }

      // Clear any previous terminal outcome before starting a new login attempt
      setLoginOutcomes((prev) => {
        const outcome = prev[providerId];
        if (outcome && outcome !== "pending") {
          const { [providerId]: _, ...rest } = prev;
          return rest;
        }
        return prev;
      });

      const clearAuthLoginUiState = () => {
        if (providerId in lastAutoCopiedDeviceCodesRef.current) {
          const next = { ...lastAutoCopiedDeviceCodesRef.current };
          delete next[providerId];
          lastAutoCopiedDeviceCodesRef.current = next;
        }
        setLoginInstructions((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        setManualCodeConfigs((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        setManualCodeInputs((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        setDeviceCodes((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
      };

      clearAuthLoginUiState();

      // Set outcome to pending
      setLoginOutcomes((prev) => ({ ...prev, [providerId]: "pending" }));
      setAuthActionInProgress(providerId);
      pollCountRef.current = 0;

      try {
        const { url, instructions, manualCode, deviceCode } = await loginProvider(providerId);
        if (instructions?.trim() && !(providerId === "github-copilot" && deviceCode)) {
          setLoginInstructions((prev) => ({ ...prev, [providerId]: instructions }));
        }
        if (manualCode) {
          setManualCodeConfigs((prev) => ({ ...prev, [providerId]: manualCode }));
        }
        if (deviceCode && providerId === "github-copilot") {
          setDeviceCodes((prev) => ({ ...prev, [providerId]: deviceCode }));
        }
        if (providerId !== "github-copilot" || !deviceCode) {
          window.open(appendTokenQuery(deviceCode?.verificationUri ?? url), "_blank");
        }

        // Poll for auth completion
        pollIntervalRef.current = setInterval(async () => {
          pollCountRef.current++;

          // Check for timeout
          if (pollCountRef.current >= MAX_POLL_CYCLES) {
            if (pollIntervalRef.current) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
            setAuthActionInProgress(null);
            setAuthProviders((prev) => prev.map((provider) =>
              provider.id === providerId ? { ...provider, loginInProgress: false } : provider,
            ));
            setLoginOutcomes((prev) => ({ ...prev, [providerId]: "timeout" }));
            clearAuthLoginUiState();
            addToast(t("setup.loginTimedOut", "Login timed out. Please try again."), "warning");
            return;
          }

          try {
            const { providers, ghCli } = await fetchAuthStatus();
            const visibleProviders = filterVisibleOnboardingAndSettingsProviders(providers);
            setAuthProviders(visibleProviders);
            setGhCliStatus(ghCli);
            const provider = visibleProviders.find((p) => p.id === providerId);
            if (provider?.authenticated) {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setAuthActionInProgress(null);
              setLoginOutcomes((prev) => ({ ...prev, [providerId]: "success" }));
              clearAuthLoginUiState();
              if (providerId === "github") {
                setGitHubSkippedState(false);
              }
              addToast(t("setup.loginSuccessful", "Login successful"), "success");
              window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT, { detail: { providerId } }));
              return;
            }

            if (!provider?.loginInProgress) {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setAuthActionInProgress(null);
              setLoginOutcomes((prev) => ({ ...prev, [providerId]: "failed" }));
              clearAuthLoginUiState();
              addToast(t("setup.loginDidNotComplete", "Login did not complete. Please try again."), "error");
            }
          } catch {
            // Continue polling
          }
        }, 2000);
      } catch (err: unknown) {
        // Check for concurrent login (409) conflict
        const isConcurrentLogin =
          (err instanceof Error && err.message.includes("already in progress")) ||
          (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 409);

        if (isConcurrentLogin) {
          addToast(t("setup.loginAlreadyInProgress", "Login already in progress. Cancel it to retry."), "warning");
          setLoginOutcomes((prev) => ({ ...prev, [providerId]: "pending" }));
          void loadAuthStatus();
        } else {
          addToast(err instanceof Error ? err.message : t("setup.loginFailed", "Login failed"), "error");
          setLoginOutcomes((prev) => ({ ...prev, [providerId]: "failed" }));
        }
        setAuthActionInProgress(null);
        clearAuthLoginUiState();
      }
    },
    [addToast, authProviders, confirm, loadAuthStatus, setGitHubSkippedState],
  );

  const handleSubmitManualCode = useCallback(async (providerId: string) => {
    const code = manualCodeInputs[providerId]?.trim();
    if (!code) {
      addToast(t("setup.pasteRedirectUrlFirst", "Paste the full redirect URL or authorization code first."), "warning");
      return;
    }

    setManualCodeSubmitInProgress(providerId);
    try {
      const result = await submitProviderManualCode(providerId, code);
      if (result.submitted) {
        setManualCodeInputs((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        addToast(t("setup.authCodeReceived", "Authorization code received. Finishing login…"), "success");
      } else {
        addToast(t("setup.authCodeAlreadySubmitted", "That authorization code was already submitted. Waiting for login…"), "warning");
      }
    } catch (err) {
      addToast(getErrorMessage(err) || t("setup.failedToSubmitAuthCode", "Failed to submit authorization code"), "error");
    } finally {
      setManualCodeSubmitInProgress(null);
    }
  }, [addToast, manualCodeInputs]);

  // Cancellation handler for in-progress logins
  const handleCancelLogin = useCallback(async (providerId: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setAuthActionInProgress(providerId);
    pollCountRef.current = 0;
    setAuthProviders((prev) => prev.map((provider) =>
      provider.id === providerId ? { ...provider, loginInProgress: false } : provider,
    ));
    setLoginOutcomes((prev) => ({ ...prev, [providerId]: "cancelled" }));

    try {
      await cancelProviderLogin(providerId);
      await loadAuthStatus().catch(() => {});
      addToast(t("setup.loginCancelled", "Login cancelled"), "success");
    } catch (err) {
      addToast(getErrorMessage(err) || t("setup.failedToCancelLogin", "Failed to cancel login"), "error");
    } finally {
      setAuthActionInProgress(null);
      setLoginInstructions((prev) => {
        if (!(providerId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setManualCodeConfigs((prev) => {
        if (!(providerId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setManualCodeInputs((prev) => {
        if (!(providerId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setManualCodeSubmitInProgress((prev) => prev === providerId ? null : prev);
      setDeviceCodes((prev) => {
        if (!(providerId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
    }
  }, [addToast, loadAuthStatus]);

  // API key input update handler
  const handleApiKeyInputChange = useCallback((providerId: string, value: string) => {
    setApiKeyInputs((prev) => ({
      ...prev,
      [providerId]: value,
    }));

    const successTimer = apiKeySuccessTimers.current[providerId];
    if (successTimer) {
      clearTimeout(successTimer);
      delete apiKeySuccessTimers.current[providerId];
    }

    setApiKeyErrors((prev) => {
      if (!prev[providerId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });

    setApiKeySuccess((prev) => {
      if (!prev[providerId]) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
  }, []);

  const scrollOnboardingContentToTop = useCallback(() => {
    const content = onboardingContentRef.current;
    if (!content) {
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    try {
      if (typeof content.scrollTo === "function") {
        content.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
        return;
      }
    } catch {
      // Fall through to direct scrollTop assignment for environments
      // without ScrollToOptions support.
    }

    content.scrollTop = 0;
  }, []);

  // API key save handler
  const handleSaveApiKey = useCallback(
    async (providerId: string, keyValue?: string) => {
      const key = (keyValue ?? apiKeyInputs[providerId] ?? "").trim();
      const validationError = validateApiKeyFormat(providerId, key, t);
      if (validationError) {
        setApiKeyErrors((prev) => ({
          ...prev,
          [providerId]: validationError,
        }));
        return;
      }

      const existingTimer = apiKeySuccessTimers.current[providerId];
      if (existingTimer) {
        clearTimeout(existingTimer);
        delete apiKeySuccessTimers.current[providerId];
      }

      setAuthActionInProgress(providerId);
      setApiKeyErrors((prev) => {
        const next = { ...prev };
        delete next[providerId];
        return next;
      });
      setApiKeySuccess((prev) => {
        if (!prev[providerId]) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });

      try {
        await saveApiKey(providerId, key);
        await loadAuthStatus();
        scrollOnboardingContentToTop();

        setApiKeyInputs((prev) => {
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        setApiKeyErrors((prev) => {
          if (!prev[providerId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
        setApiKeySuccess((prev) => ({
          ...prev,
          [providerId]: t("setup.keySavedInline", "✓ Key saved"),
        }));

        apiKeySuccessTimers.current[providerId] = setTimeout(() => {
          setApiKeySuccess((prev) => {
            if (!prev[providerId]) {
              return prev;
            }
            const next = { ...prev };
            delete next[providerId];
            return next;
          });
          delete apiKeySuccessTimers.current[providerId];
        }, 3000);

        addToast(t("setup.apiKeySavedToast", "API key saved"), "success");
      } catch (err: unknown) {
        const errorMessage =
          err instanceof TypeError && err.message.includes("Failed to fetch")
            ? t("setup.couldNotReachServer", "Could not reach the server. Check your connection and try again.")
            : err instanceof Error
              ? err.message
              : t("setup.failedToSaveApiKey", "Failed to save API key");

        setApiKeyErrors((prev) => ({
          ...prev,
          [providerId]: errorMessage,
        }));
        setApiKeySuccess((prev) => {
          if (!prev[providerId]) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });

        addToast(errorMessage, "error");
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [apiKeyInputs, addToast, loadAuthStatus, scrollOnboardingContentToTop],
  );

  // API key clear handler
  const handleClearApiKey = useCallback(
    async (providerId: string) => {
      setAuthActionInProgress(providerId);
      try {
        await clearApiKey(providerId);
        await loadAuthStatus();
        addToast(t("setup.apiKeyRemoved", "API key removed"), "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : t("setup.failedToClearApiKey", "Failed to clear API key"),
          "error",
        );
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [addToast, loadAuthStatus],
  );

  // Logout handler (for OAuth providers that are authenticated)
  const handleLogout = useCallback(
    async (providerId: string) => {
      setAuthActionInProgress(providerId);
      try {
        await logoutProvider(providerId);
        await loadAuthStatus();
        addToast(t("setup.loggedOut", "Logged out"), "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : t("setup.logoutFailed", "Logout failed"),
          "error",
        );
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [addToast, loadAuthStatus],
  );

  // Handle model selection from CustomModelDropdown
  const handleModelSelect = useCallback(
    (value: string) => {
      setSelectedModel(value);

      /*
       * FNXC:Onboarding 2026-07-03-09:15:
       * Persist the picked model as the global default IMMEDIATELY on selection. Previously the choice
       * lived only in local state until completeOnboarding ran on the final step, so a user who selected
       * a model but exited or skipped before finishing lost the selection and then saw the post-onboarding
       * "Select Default Model" banner despite having explicitly chosen one. Saving on pick makes the
       * selection durable regardless of how onboarding is exited.
       */
      const slashIdx = value.indexOf("/");
      const provider = slashIdx !== -1 ? value.slice(0, slashIdx) : undefined;
      const modelId = slashIdx !== -1 ? value.slice(slashIdx + 1) : value;
      const model = availableModels.find((m) => m.id === modelId);
      const updates: Record<string, unknown> = {};
      if (model) {
        updates.defaultProvider = model.provider;
        updates.defaultModelId = model.id;
      } else if (provider && modelId) {
        updates.defaultProvider = provider;
        updates.defaultModelId = modelId;
      }
      if (updates.defaultModelId) {
        void updateGlobalSettings(updates).catch(() => undefined);
      }
    },
    [availableModels, updateGlobalSettings],
  );

  const completeOnboarding = useCallback(async () => {
    try {
      const updates: Record<string, unknown> = {
        modelOnboardingComplete: true,
      };

      /*
       * FNXC:Onboarding 2026-07-03-09:10:
       * Persist a default model on completion so the post-onboarding "Select Default Model"
       * recommendation does not fire for operators who connected a provider but never opened the model
       * dropdown. selectedModel is only populated by an explicit dropdown pick (or a previously-saved
       * default), so a fresh first-run where the user just connects Anthropic and clicks Continue would
       * otherwise leave defaultProvider/defaultModelId unset and trip the false-positive banner. Prefer
       * the explicit pick; otherwise fall back to the first available model from the connected provider.
       * Only when no models are available at all do we leave the default unset.
       */
      const effectiveSelection =
        selectedModel ||
        (availableModels[0] ? `${availableModels[0].provider}/${availableModels[0].id}` : "");

      if (effectiveSelection) {
        const slashIdx = effectiveSelection.indexOf("/");
        const provider =
          slashIdx !== -1 ? effectiveSelection.slice(0, slashIdx) : undefined;
        const modelId =
          slashIdx !== -1 ? effectiveSelection.slice(slashIdx + 1) : effectiveSelection;

        const model = availableModels.find((m) => m.id === modelId);
        if (model) {
          updates.defaultProvider = model.provider;
          updates.defaultModelId = model.id;
        } else if (provider && modelId) {
          // Fallback: use parsed values even if not in the model list
          updates.defaultProvider = provider;
          updates.defaultModelId = modelId;
        }
      }

      await updateGlobalSettings(updates);
      // Mark onboarding as completed (preserves state for completion timestamp)
      markOnboardingCompleted();
    } catch {
      // Best-effort: continue even if save fails
    }
  }, [selectedModel, availableModels, updateGlobalSettings, markOnboardingCompleted]);

  // Complete onboarding
  const handleComplete = useCallback(async () => {
    const nextCompletedSteps = [...new Set([...completedSteps, "first-task"])] as OnboardingStep[];

    setSaving(true);
    try {
      await completeOnboarding();
      trackOnboardingEvent("onboarding:completed", { completedSteps: nextCompletedSteps, skippedSteps });
      setCompletedSteps(nextCompletedSteps);
      setSkippedSteps((prev) => prev.filter((s) => s !== "first-task"));
      setStep("complete");
    } finally {
      setSaving(false);
    }
  }, [completeOnboarding, completedSteps, skippedSteps]);

  const handleCreateFirstTask = useCallback(async () => {
    if (!projectId) {
      return;
    }

    const trimmedDescription = firstTaskDescription.trim();
    if (!trimmedDescription) {
      setTaskCreationError(t("setup.pleaseEnterTaskDescription", "Please enter a task description."));
      return;
    }

    setTaskCreationError(null);
    setIsCreatingFirstTask(true);

    let success = false;

    try {
      const createdTask = await createTask({
        description: trimmedDescription,
        source: { sourceType: "dashboard_ui" },
      }, projectId);
      setInlineCreatedTask(createdTask);
      setShowTaskCreated(true);
      trackOnboardingEvent("onboarding:first-task-created", { taskId: createdTask?.id });
      addToast(t("setup.taskCreated", "Task created"), "success");
      success = true;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : t("setup.taskCreationFailed", "Something went wrong creating your task. Please try again.");
      setTaskCreationError(message);
      addToast(message, "error");
    } finally {
      setIsCreatingFirstTask(false);
    }

    if (success) {
      void completeOnboarding();
    }
  }, [projectId, firstTaskDescription, addToast, completeOnboarding]);

  // Handle first task CTA - mark complete, close modal, then open new task
  const handleOpenNewTask = useCallback(async () => {
    // First complete the onboarding
    setSaving(true);
    try {
      await completeOnboarding();
    } finally {
      setSaving(false);
    }

    // Keep onboarding open so task creation can hand back to a success state
    trackOnboardingEvent("onboarding:open-new-task", {});
    onOpenNewTask?.();
  }, [completeOnboarding, onOpenNewTask]);

  // Handle GitHub import CTA - mark complete, close modal, then open GitHub import
  const handleOpenGitHubImport = useCallback(async () => {
    if (!isGitHubReady) {
      return;
    }

    // First complete the onboarding
    setSaving(true);
    try {
      await completeOnboarding();
    } finally {
      setSaving(false);
    }

    // Close modal and trigger callback
    setIsOpen(false);
    onComplete();
    trackOnboardingEvent("onboarding:open-github-import", {});
    onOpenGitHubImport?.();
  }, [completeOnboarding, isGitHubReady, onComplete, onOpenGitHubImport]);

  // Dismiss without completing (still marks onboarding complete)
  const handleDismiss = useCallback(async () => {
    trackOnboardingEvent("onboarding:dismissed", {
      currentStep: step,
      completedSteps,
      skippedSteps,
    });

    setSaving(true);
    try {
      await updateGlobalSettings({ modelOnboardingComplete: true });
    } catch {
      // Best-effort: still close even if save fails
    }
    setIsOpen(false);
    onComplete();
  }, [step, completedSteps, skippedSteps, onComplete]);

  // Close from the completion step
  const handleFinish = useCallback(() => {
    trackOnboardingEvent("onboarding:finished", {});
    setIsOpen(false);
    onComplete();
  }, [onComplete]);

  const handleViewCreatedTask = useCallback(() => {
    const createdTask = firstCreatedTask ?? inlineCreatedTask;
    if (!createdTask) {
      return;
    }

    void completeOnboarding();
    onViewTask?.(createdTask);
    onComplete();
  }, [firstCreatedTask, inlineCreatedTask, completeOnboarding, onViewTask, onComplete]);

  const handleGoToDashboard = useCallback(() => {
    void completeOnboarding();
    onComplete();
  }, [completeOnboarding, onComplete]);

  const githubStatus = getGitHubStatus();

  const aiProviders = authProviders.filter((provider) => provider.id !== "github");
  /*
   * FNXC:Onboarding 2026-07-03-07:20:
   * Show the "Connect remote Fusion server" card ONLY when not already connected to a remote server
   * (no active remote profile) — on any host, web included. Never show it in LOCAL desktop mode: a
   * local runtime is already the connected backend, so prompting for a remote server URL just confuses
   * first-run setup (the original report).
   */
  const showShellConnectionSetup =
    !shellState.activeProfileId && shellState.desktopMode !== "local";
  const orderedAiProviders = [...aiProviders].sort(compareOnboardingProviders);
  const hasOauthProviders = orderedAiProviders.some((provider) => !provider.type || provider.type === "oauth");
  const providerSupportsApiKey = (provider: AuthProvider) => provider.type === "api_key";
  const hasApiKeyProviders = orderedAiProviders.some((provider) => providerSupportsApiKey(provider));
  const connectedAiProviders = aiProviders.filter((provider) => provider.authenticated);
  const hasAiProvider = connectedAiProviders.length > 0;
  const hasProjectSelected = Boolean(projectId);
  const selectedAgentPreset = selectedAgentPresetId ? getPresetById(selectedAgentPresetId) : undefined;
  /*
  FNXC:Onboarding 2026-06-22-06:03:
  AI-generated agent drafts are custom and should not appear selected as a template, but the template radiogroup still needs one tabbable item for keyboard users.
  */
  const agentPresetTabStopId = selectedAgentPresetId || ceoPreset.id;
  const isAgentActionDisabled = isCreatingAgent || !hasProjectSelected;
  // True when on GitHub step but skipped AI setup (no AI provider connected)
  const aiSetupSkipped = step === "github" && !hasAiProvider;

  const saveShellConnectionProfile = useCallback(async () => {
    if (!shellApi) {
      return;
    }
    setShellConnectionError(null);
    setShellConnectionSaving(true);
    try {
      const saved = await shellApi.saveProfile({
        name: shellProfileName,
        serverUrl: shellServerUrl,
        authToken: shellAuthToken.trim() ? shellAuthToken : null,
      });
      try {
        await shellApi.setActiveProfile(saved.id);
      } catch (error) {
        setShellConnectionError(getErrorMessage(error) || t("setup.savedProfileButFailedToActivate", "Saved profile but failed to activate it"));
        return;
      }
      setShellServerUrl("");
      setShellAuthToken("");
      addToast(t("setup.remoteServerProfileSaved", "Remote server profile saved"), "success");
    } catch (error) {
      setShellConnectionError(getErrorMessage(error) || t("setup.failedToSaveShellConnection", "Failed to save shell connection"));
    } finally {
      setShellConnectionSaving(false);
    }
  }, [shellApi, shellProfileName, shellServerUrl, shellAuthToken, addToast]);

  if (!isOpen) return null;

  const selectedModelDisplayName = (() => {
    if (!selectedModel) {
      return "";
    }

    const slashIdx = selectedModel.indexOf("/");
    const providerId = slashIdx === -1 ? undefined : selectedModel.slice(0, slashIdx);
    const modelId = slashIdx === -1 ? selectedModel : selectedModel.slice(slashIdx + 1);
    const matchingModel = availableModels.find(
      (model) => model.id === modelId && (!providerId || model.provider === providerId),
    );

    if (matchingModel?.name) {
      return matchingModel.name;
    }

    if (providerId) {
      return `${getProviderDisplayName(providerId)} ${modelId}`;
    }

    return selectedModel;
  })();

  const readinessItems: ReadinessItem[] = [];

  if (hasProjectSelected) {
    readinessItems.push({
      label: t("setup.readinessProjectLabel", "Project"),
      status: "connected",
      detail: t("setup.readinessProjectConnected", "Project selected — task creation and imports are available"),
    });
  } else {
    readinessItems.push({
      label: t("setup.readinessProjectLabel", "Project"),
      status: "missing",
      detail: t("setup.readinessProjectMissing", "Register a project to enable task creation and imports"),
    });
  }

  if (hasAiProvider) {
    const firstConnectedProviderName = getProviderDisplayName(connectedAiProviders[0]?.id ?? "");
    readinessItems.push({
      label: t("setup.readinessAiProviderLabel", "AI Provider"),
      status: "connected",
      detail: t("setup.readinessAiProviderConnected", "{{name}} connected — AI agents can work on tasks", { name: firstConnectedProviderName }),
    });
  } else if (
    aiProviders.length > 0
    && aiProviders.some((provider) => skippedProviders[provider.id])
  ) {
    readinessItems.push({
      label: t("setup.readinessAiProviderLabel", "AI Provider"),
      status: "skipped",
      detail: t("setup.readinessAiProviderSkipped", "AI agents won't be available until you connect a provider"),
    });
  } else {
    readinessItems.push({
      label: t("setup.readinessAiProviderLabel", "AI Provider"),
      status: "missing",
      detail: t("setup.readinessAiProviderMissing", "Connect a provider in Settings → AI Setup"),
    });
  }

  if (isGitHubReady) {
    readinessItems.push({
      label: t("setup.readinessGitHubLabel", "GitHub"),
      status: "connected",
      detail: isGitHubReadyViaCli
        ? t("setup.readinessGitHubViaCli", "Connected via GitHub CLI — imports and PR tracking are available")
        : t("setup.readinessGitHubConnected", "Issues and PRs can be imported"),
    });
  } else if (!hasGithubProvider || isGithubSkipped) {
    readinessItems.push({
      label: t("setup.readinessGitHubLabel", "GitHub"),
      status: "skipped",
      detail: t("setup.readinessGitHubSkipped", "You can connect anytime from Settings"),
    });
  } else {
    readinessItems.push({
      label: t("setup.readinessGitHubLabel", "GitHub"),
      status: "missing",
      detail: t("setup.readinessGitHubMissing", "Connect to import issues as tasks"),
    });
  }

  if (selectedModelDisplayName) {
    readinessItems.push({
      label: t("setup.readinessDefaultModelLabel", "Default Model"),
      status: "connected",
      detail: selectedModelDisplayName,
    });
  }

  const createdTaskForDisplay = firstCreatedTask ?? inlineCreatedTask;
  const firstCreatedTaskPreview =
    createdTaskForDisplay?.description?.split("\n")[0]?.trim() ||
    createdTaskForDisplay?.title ||
    "";

  const quickStartSet = new Set<string>(QUICK_START_PROVIDER_IDS);
  const hasSeparatedAnthropicProvider = orderedAiProviders.some(
    (provider) => provider.id === "anthropic-subscription" || provider.id === "anthropic-api-key",
  );
  /*
  FNXC:ProviderAuth 2026-06-29-23:59:
  Onboarding may receive a stale legacy `anthropic` status row during rollout, but the separated `anthropic-subscription` and `anthropic-api-key` cards are now the source of truth.
  Suppress the legacy row whenever either separated card is present so users never see duplicate Anthropic auth choices or a dual-purpose card.
  */
  const visibleOrderedAiProviders = orderedAiProviders.filter(
    (provider) => !(provider.id === "anthropic" && hasSeparatedAnthropicProvider),
  );
  const quickStartProviders = visibleOrderedAiProviders
    .filter((provider) => quickStartSet.has(provider.id))
    .sort((a, b) => {
      const rankA = QUICK_START_PROVIDER_IDS.indexOf(a.id as (typeof QUICK_START_PROVIDER_IDS)[number]);
      const rankB = QUICK_START_PROVIDER_IDS.indexOf(b.id as (typeof QUICK_START_PROVIDER_IDS)[number]);
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return compareOnboardingProviders(a, b);
    });
  const connectedNonQuickStartProviders = visibleOrderedAiProviders.filter(
    (provider) => provider.authenticated && !quickStartSet.has(provider.id),
  );
  const advancedProviders = visibleOrderedAiProviders.filter(
    (provider) => !provider.authenticated && !quickStartSet.has(provider.id),
  );

  const renderAiProviderCard = (provider: AuthProvider) => {
    const hasTerminalLoginOutcome = loginOutcomes[provider.id] === "timeout" ||
      loginOutcomes[provider.id] === "failed" ||
      loginOutcomes[provider.id] === "cancelled";
    const showRemoteLoginInProgress = provider.loginInProgress && !hasTerminalLoginOutcome;

    if (provider.id === "llama-cpp" && provider.type === "cli") {
      return (
        <LlamaCppProviderCard
          key={provider.id}
          authenticated={provider.authenticated}
          onToggled={() => {
            void loadAuthStatus();
          }}
        />
      );
    }

    if (provider.id === "claude-cli" && provider.type === "cli") {
      return (
        <ClaudeCliProviderCard
          key={provider.id}
          authenticated={provider.authenticated}
          onToggled={() => {
            void loadAuthStatus();
          }}
        />
      );
    }

    if (provider.id === "cursor-cli" && provider.type === "cli") {
      return (
        <CursorCliProviderCard
          key={provider.id}
          authenticated={provider.authenticated}
          onToggled={() => {
            void loadAuthStatus();
          }}
        />
      );
    }

    if (providerSupportsApiKey(provider)) {
      const providerInfo = getProviderInfo(provider.id, t);
      const apiKeyInfo = getApiKeyInfo(provider, t);
      const hasStoredApiKey = Boolean(provider.keyHint);

      /*
      FNXC:ProviderAuth 2026-06-29-22:20:
      Onboarding must offer Anthropic subscription OAuth as its own login card and raw Anthropic API-key auth as a separate key card, matching OpenAI Codex versus OpenAI API-key behavior.
      Treat only `type: "api_key"` providers as key-entry cards so the separated invariant cannot regress through `supportsApiKey`.
      */
      return (
        <div
          key={provider.id}
          data-testid={`onboarding-provider-card-${provider.id}`}
          className={`onboarding-provider-card${provider.authenticated ? " onboarding-provider-card--connected" : ""}`}
        >
          <div
            className="onboarding-provider-card__icon"
            data-testid={`onboarding-provider-icon-${provider.id}`}
            aria-hidden="true"
          >
            <ProviderIcon provider={provider.id} size="md" />
          </div>
          <div className="onboarding-provider-card__body">
            <strong className="onboarding-provider-card__name">
              <Key size={14} className="onboarding-provider-key-icon" />
              {provider.name}
            </strong>
            <span className="onboarding-provider-card__description">
              {providerInfo.description}
            </span>
            <ProviderStatusBadge status={getProviderStatus(provider)} />
            {provider.authenticated && provider.keyHint && (
              <span className="auth-key-hint">{t("setup.apiKeyHint", "Key: {{keyHint}}", { keyHint: provider.keyHint })}</span>
            )}
          </div>
          <div className="onboarding-provider-card__actions onboarding-provider-card__actions--api-key">
            <ApiKeyEntryForm
              provider={provider}
              apiKeyInfo={apiKeyInfo}
              inputValue={apiKeyInputs[provider.id] ?? ""}
              isSaving={authActionInProgress === provider.id}
              error={apiKeyErrors[provider.id]}
              success={apiKeySuccess[provider.id]}
              isConnected={provider.authenticated || hasStoredApiKey}
              onInputChange={handleApiKeyInputChange}
              onSave={handleSaveApiKey}
              onClear={handleClearApiKey}
            />
          </div>
        </div>
      );
    }

    return (
      <div
        key={provider.id}
        data-testid={`onboarding-provider-card-${provider.id}`}
        className={`onboarding-provider-card${provider.authenticated ? " onboarding-provider-card--connected" : ""}`}
      >
        <div
          className="onboarding-provider-card__icon"
          data-testid={`onboarding-provider-icon-${provider.id}`}
          aria-hidden="true"
        >
          <ProviderIcon provider={provider.id} size="md" />
        </div>
        <div className="onboarding-provider-card__body">
          <strong className="onboarding-provider-card__name">{provider.name}</strong>
          <span className="onboarding-provider-card__description">
            {getProviderInfo(provider.id, t).description}
          </span>
          <ProviderStatusBadge status={getProviderStatus(provider)} />
        </div>
        <div className="onboarding-provider-card__actions">
          {authActionInProgress === provider.id ? (
            provider.authenticated ? (
              <button className="btn btn-sm" disabled>
                {t("setup.loggingOut", "Logging out…")}
              </button>
            ) : (
              <>
                <button className="btn btn-sm" disabled>
                  {t("setup.waitingForLogin", "Waiting for login…")}
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => void handleCancelLogin(provider.id)}
                >
                  {t("setup.cancelLogin", "Cancel")}
                </button>
              </>
            )
          ) : showRemoteLoginInProgress ? (
            <>
              <button className="btn btn-sm" disabled>
                {t("setup.waitingForLogin", "Waiting for login…")}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => void handleCancelLogin(provider.id)}
              >
                {t("setup.cancelLogin", "Cancel")}
              </button>
            </>
          ) : provider.authenticated ? (
            <button
              className="btn btn-sm"
              onClick={() => handleLogout(provider.id)}
            >
              {t("setup.logout", "Logout")}
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleLogin(provider.id)}
            >
              {t("setup.login", "Login")}
            </button>
          )}
        </div>
        {(authActionInProgress === provider.id || showRemoteLoginInProgress) && provider.id === "github-copilot" && deviceCodes[provider.id] && (
          <div className="auth-device-code-panel" data-testid={`onboarding-device-code-${provider.id}`}>
            <strong>{t("setup.enterCodeOnGitHub", "Enter this code on GitHub")}</strong>
            <div className="auth-device-code-pill">{deviceCodes[provider.id].userCode}</div>
            <div className="auth-provider-actions-row">
              <button
                className="btn btn-sm"
                onClick={() => {
                  void (async () => {
                    const copied = await copyTextToClipboard(deviceCodes[provider.id].userCode);
                    if (copied) {
                      addToast(t("setup.copiedCodeToClipboard", "Copied code to clipboard"), "success");
                      return;
                    }
                    addToast(t("setup.failedToCopyCode", "Failed to copy code — copy it manually from the box above"), "error");
                  })();
                }}
              >
                {t("setup.copyCode", "Copy code")}
              </button>
              <button className="btn btn-sm" onClick={() => window.open(appendTokenQuery(deviceCodes[provider.id].verificationUri), "_blank")}>
                {t("setup.openGitHub", "Open GitHub")}
              </button>
            </div>
          </div>
        )}
        {(authActionInProgress === provider.id || showRemoteLoginInProgress) && loginInstructions[provider.id] && (
          <LoginInstructions
            instructions={loginInstructions[provider.id]}
            data-testid={`onboarding-login-instructions-${provider.id}`}
          />
        )}
        {(authActionInProgress === provider.id || showRemoteLoginInProgress) && manualCodeConfigs[provider.id] && (
          <OAuthManualCodeForm
            value={manualCodeInputs[provider.id] ?? ""}
            onChange={(value) => setManualCodeInputs((prev) => ({ ...prev, [provider.id]: value }))}
            onSubmit={() => void handleSubmitManualCode(provider.id)}
            prompt={manualCodeConfigs[provider.id].prompt}
            placeholder={manualCodeConfigs[provider.id].placeholder}
            helpText={manualCodeConfigs[provider.id].helpText}
            disabled={manualCodeSubmitInProgress === provider.id}
            submitLabel={manualCodeSubmitInProgress === provider.id ? t("setup.submittingCode", "Submitting…") : t("setup.submitCode", "Submit code")}
            data-testid={`onboarding-manual-code-${provider.id}`}
          />
        )}
        {loginOutcomes[provider.id] === "timeout" && authActionInProgress !== provider.id && (
          <p className="onboarding-helper-text onboarding-inline-feedback">
            {t("setup.loginTimedOutInline", "Login timed out. Please try again.")}
          </p>
        )}
        {loginOutcomes[provider.id] === "failed" && authActionInProgress !== provider.id && (
          <p className="field-error onboarding-inline-feedback">
            {t("setup.loginFailedInline", "Login failed. Please try again.")}
          </p>
        )}
      </div>
    );
  };

  return (
    <div
      className="modal-overlay open"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <div className="modal model-onboarding-modal" ref={modalRef}>
        {/* Header */}
        <div className="model-onboarding-header">
          <h2 id="onboarding-title" className="model-onboarding-title">
            {step === "ai-setup" && (
              <>
                <Zap size={24} /> {t("setup.titleAiSetup", "Set Up AI")} <span className="onboarding-optional-badge">{t("setup.optionalBadge", "Optional")}</span>
              </>
            )}
            {step === "github" && (
              <>
                <GitPullRequest size={24} /> {t("setup.titleConnectGitHub", "Connect GitHub")} <span className="onboarding-optional-badge">{t("setup.optionalBadge", "Optional")}</span>
              </>
            )}
            {step === "project-setup" && (
              <>
                <Rocket size={24} /> {t("setup.titleSetUpProject", "Set Up Your Project")}
              </>
            )}
            {step === "agent" && (
              <>
                <UserRound size={24} /> {t("setup.titleCreateFirstAgent", "Create Your First Agent")} <span className="onboarding-optional-badge">{t("setup.optionalBadge", "Optional")}</span>
              </>
            )}
            {step === "first-task" && (
              <>
                <Rocket size={24} /> {t("setup.titleCreateFirstTask", "Create Your First Task")}
              </>
            )}
            {step === "complete" && (
              <>
                <CheckCircle size={24} /> {t("setup.titleAllSet", "All Set!")}
              </>
            )}
          </h2>
          {step !== "complete" && (
            <button
              className="modal-close"
              onClick={handleDismiss}
              aria-label={t("setup.skipOnboardingAriaLabel", "Skip onboarding")}
              title={t("setup.skipForNow", "Skip for now")}
            >
              <X size={20} />
            </button>
          )}
        </div>

        {/* Step indicator - progress steps + complete */}
        <div className="model-onboarding-steps">
          {steps.map((s, index) => {
            // A step is done/skipped only once we have progressed beyond it.
            const hasProgressedPastStep = effectiveStepIndex > index;
            const isDone = completedSteps.includes(s.key) && hasProgressedPastStep;
            const isSkipped = skippedSteps.includes(s.key) && !completedSteps.includes(s.key) && hasProgressedPastStep;
            // Clickable if it's a completed/skipped step (can review)
            const isClickable = isDone || isSkipped;
            return (
              <div key={s.key} className="onboarding-step-wrapper">
                {index > 0 && (
                  <div
                    className={`model-onboarding-step-connector ${
                      index <= effectiveStepIndex ? "done" : ""
                    }`}
                  />
                )}
                {isClickable ? (
                  <button
                    className={`model-onboarding-step-indicator ${
                      step === s.key ? "active" : ""
                    } ${isDone ? "done" : ""} ${isSkipped ? "skipped" : ""}`}
                    onClick={() => setStep(s.key)}
                    aria-label={t("setup.goBackToStep", "Go back to {{label}}", { label: s.label })}
                    title={t("setup.reviewStep", "Review {{label}}", { label: s.label })}
                  >
                    <span className="step-number">
                      {isDone ? (
                        <CheckCircle size={14} />
                      ) : isSkipped ? (
                        <span className="onboarding-step-skip-mark">–</span>
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className="step-label">{s.label}</span>
                  </button>
                ) : (
                  <div
                    className={`model-onboarding-step-indicator ${
                      step === s.key ? "active" : ""
                    } ${isDone ? "done" : ""} ${isSkipped ? "skipped" : ""}`}
                  >
                    <span className="step-number">
                      {isDone ? (
                        <CheckCircle size={14} />
                      ) : isSkipped ? (
                        <span className="onboarding-step-skip-mark">–</span>
                      ) : (
                        index + 1
                      )}
                    </span>
                    <span className="step-label">{s.label}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Content */}
        <div className="model-onboarding-content" ref={onboardingContentRef}>
          {step === "ai-setup" && (
            <div className="model-onboarding-ai-setup">
              <p className="model-onboarding-description">
                {t("setup.aiSetupDescription", "Fusion uses AI models to plan, write, and review code for you. Connect an AI provider below to get started — you can use a hosted service or enter an API key.")}
              </p>
              <p className="onboarding-helper-text model-onboarding-primary-helper">
                {t("setup.onlyNeedOneProvider", "You only need one provider to get started.")}
              </p>

              {showShellConnectionSetup && (
                <div className="card">
                  <h3 className="onboarding-section-title">{t("setup.connectRemoteServer", "Connect remote Fusion server")}</h3>
                  <p className="onboarding-helper-text">
                    {t("setup.remoteServerNote", "Your native shell needs an active remote profile before dashboard handoff can complete.")}
                  </p>
                  <label htmlFor="onboarding-shell-profile-name" className="onboarding-apikey-field-label">{t("setup.profileName", "Profile name")}</label>
                  <input
                    id="onboarding-shell-profile-name"
                    className="input"
                    value={shellProfileName}
                    onChange={(event) => setShellProfileName(event.target.value)}
                  />
                  <label htmlFor="onboarding-shell-server-url" className="onboarding-apikey-field-label">{t("setup.serverUrl", "Server URL")}</label>
                  <input
                    id="onboarding-shell-server-url"
                    className="input"
                    placeholder={t("setup.serverUrlPlaceholder", "https://your-fusion-host")}
                    value={shellServerUrl}
                    onChange={(event) => setShellServerUrl(event.target.value)}
                  />
                  <label htmlFor="onboarding-shell-token" className="onboarding-apikey-field-label">{t("setup.authTokenOptional", "Auth token (optional)")}</label>
                  <input
                    id="onboarding-shell-token"
                    className="input"
                    type="password"
                    value={shellAuthToken}
                    onChange={(event) => setShellAuthToken(event.target.value)}
                  />
                  {shellConnectionError && <small className="field-error">{shellConnectionError}</small>}
                  <div className="onboarding-apikey-input-row">
                    <button type="button" className="btn btn-sm" onClick={() => void shellApi?.openConnectionManager()}>
                      {t("setup.openManager", "Open manager")}
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void saveShellConnectionProfile()}
                      disabled={!shellServerUrl.trim() || shellConnectionSaving}
                    >
                      {shellConnectionSaving ? t("setup.savingRemoteServer", "Saving…") : t("setup.saveRemoteServer", "Save remote server")}
                    </button>
                  </div>
                </div>
              )}

              {/* Provider connection status summary */}
              {!authLoading && authProviders.length > 0 && (
                (() => {
                  const connectedCount = authProviders.filter(p => p.id !== "github" && p.authenticated).length;
                  const totalAiProviders = authProviders.filter(p => p.id !== "github").length;
                  const skippedCount = Object.keys(skippedProviders).filter(id => !authProviders.find(p => p.id === id)?.authenticated).length;

                  if (totalAiProviders === 0) return null;

                  let summaryClass = "onboarding-provider-summary";
                  let summaryText = "";

                  if (connectedCount > 0) {
                    summaryClass += " onboarding-provider-summary--connected";
                    summaryText = t("setup.providersConnectedSummary", "✓ {{connected}} of {{total}} providers connected", { connected: connectedCount, total: totalAiProviders });
                  } else if (skippedCount > 0) {
                    summaryClass += " onboarding-provider-summary--skipped";
                    summaryText = skippedCount === 1
                      ? t("setup.providersSkippedSummary_one", "{{count}} provider skipped", { count: skippedCount })
                      : t("setup.providersSkippedSummary_other", "{{count}} providers skipped", { count: skippedCount });
                  } else {
                    summaryClass += " onboarding-provider-summary--none";
                    summaryText = t("setup.noProvidersConnectedYet", "No providers connected yet");
                  }

                  return (
                    <div className={summaryClass} data-testid="provider-summary">
                      {summaryText}
                    </div>
                  );
                })()
              )}

              <PluginSlot slotId="onboarding-recommendation-card" projectId={projectId} />

              {/* Provider explanation disclosure */}
              <OnboardingDisclosure summary={t("setup.whatAreAiProviders", "What are AI providers?")}>
                <p className="onboarding-helper-text">
                  {t("setup.whatAreAiProvidersBody", "AI providers like OpenAI and Anthropic power the AI capabilities in Fusion. Connecting a provider lets Fusion's agents use AI models to help with your tasks.")}
                </p>
              </OnboardingDisclosure>

              {/* Show helper text when providers exist but none are authenticated */}
              {authProviders.length > 0 && !authProviders.some((p) => p.authenticated) && (
                <p className="onboarding-helper-text">
                  {t("setup.skipProviderHint", "Skip this step if you'd like — you can always add providers later from Settings.")}
                </p>
              )}

              {authLoading ? (
                <div className="model-onboarding-loading">
                  <Loader2 size={24} className="animate-spin" />
                  <span>{t("setup.loadingProviders", "Loading providers…")}</span>
                </div>
              ) : authProviders.length === 0 ? (
                <div className="model-onboarding-empty">
                  {t("setup.noProvidersConfigured", "No AI providers are configured. Please check your Fusion configuration.")}
                </div>
              ) : (
                <>
                  <PluginSlot
                    slotId="onboarding-provider-card"
                    projectId={projectId}
                    renderPlaceholder={false}
                    actions={{ refreshAuthProviders: () => { void loadAuthStatus(); } }}
                  />

                  <section className="onboarding-provider-section" data-testid="onboarding-quick-start-providers">
                    <h3 className="onboarding-section-title">{t("setup.quickStartProviders", "Quick start providers")}</h3>
                    {quickStartProviders.length > 0 ? (
                      <div className="model-onboarding-providers">
                        {quickStartProviders.map((provider) => renderAiProviderCard(provider))}
                      </div>
                    ) : (
                      <p className="onboarding-helper-text">
                        {t("setup.noQuickStartProviders", "No quick-start providers are available in this environment.")}
                      </p>
                    )}
                  </section>

                  {connectedNonQuickStartProviders.length > 0 && (
                    <section className="onboarding-provider-section" data-testid="onboarding-connected-providers">
                      <h3 className="onboarding-section-title">{t("setup.connectedProviders", "Connected providers")}</h3>
                      <div className="model-onboarding-providers">
                        {connectedNonQuickStartProviders.map((provider) => renderAiProviderCard(provider))}
                      </div>
                    </section>
                  )}

                  {/* Model Selection — placed directly after the authenticated provider list */}
                  <div className="onboarding-model-section">
                    <h3 className="onboarding-section-title">
                      {t("setup.defaultModelOptional", "Default Model (Optional)")}
                    </h3>
                    <p className="model-onboarding-description">
                      {t("setup.defaultModelDescription", "Pick a default model for AI tasks, or leave this blank to choose later. Models vary in speed, capability, and cost.")}
                    </p>

                    <OnboardingDisclosure summary={t("setup.howDoIChooseModel", "How do I choose a model?")}>
                      <p className="onboarding-helper-text">
                        {t("setup.howDoIChooseModelBody", "Models vary in speed, capability, and cost. A good default is usually the latest model from your connected provider. You can always change this later in Settings.")}
                      </p>
                    </OnboardingDisclosure>

                    {availableModels.length === 0 ? (
                      <div className="model-onboarding-empty">
                        {t("setup.noModelsAvailable", "No models available yet. Connect a provider above to see model options.")}
                      </div>
                    ) : (
                      <div className="onboarding-model-selector">
                        <CustomModelDropdown
                          models={availableModels}
                          value={selectedModel}
                          onChange={handleModelSelect}
                          placeholder={t("setup.selectDefaultModel", "Select a default model…")}
                          label={t("setup.defaultModelLabel", "Default model")}
                        />
                      </div>
                    )}

                    {selectedModel && (
                      <div className="onboarding-model-preview">
                        <small className="settings-muted">
                          {t("setup.selectedModel", "Selected:")} {" "}
                          {availableModels.find((m) => m.id === selectedModel)
                            ?.name ?? selectedModel}
                        </small>
                      </div>
                    )}
                  </div>

                  <OnboardingDisclosure summary={t("setup.advancedProviderSettings", "Advanced provider settings")} className="onboarding-provider-advanced">
                    <div data-testid="onboarding-advanced-provider-settings">
                      {advancedProviders.length > 0 ? (
                        <div className="model-onboarding-providers">
                          {advancedProviders.map((provider) => renderAiProviderCard(provider))}
                        </div>
                      ) : (
                        <p className="onboarding-helper-text">
                          {t("setup.allProvidersShown", "All currently available providers are already shown above.")}
                        </p>
                      )}

                      {customProviders.length > 0 ? (
                        <div className="onboarding-custom-provider-list">
                          {customProviders.map((provider) => (
                            <div key={provider.id} className="onboarding-custom-provider-item">
                              <ProviderIcon provider={provider.id} size="sm" />
                              <span>{provider.name || provider.id}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {!showCustomProviderForm ? (
                        <button type="button" className="btn btn-sm" onClick={() => setShowCustomProviderForm(true)}>
                          {t("setup.addCustomProvider", "Add custom provider")}
                        </button>
                      ) : (
                        <CustomProviderForm
                          onSave={handleSaveCustomProvider}
                          onCancel={() => { setShowCustomProviderForm(false); setCustomProviderError(undefined); }}
                          saving={customProviderSaving}
                          error={customProviderError}
                        />
                      )}
                    </div>
                  </OnboardingDisclosure>

                  {/* OAuth login disclosure */}
                  {hasOauthProviders && (
                    <OnboardingDisclosure summary={t("setup.howDoesLoginWork", "How does login work?")}>
                      <p className="onboarding-helper-text">
                        {t("setup.howDoesLoginWorkBody", "Clicking Login opens the provider's website in a new tab where you sign in. Once you authorize Fusion, this page will automatically detect the connection. Your credentials are never stored in Fusion.")}
                      </p>
                    </OnboardingDisclosure>
                  )}

                  {/* API key disclosure */}
                  {hasApiKeyProviders && (
                    <OnboardingDisclosure summary={t("setup.whatIsApiKey", "What is an API key?")}>
                      <p className="onboarding-helper-text">
                        {t("setup.whatIsApiKeyBody", "An API key is a secret token that authenticates Fusion with the provider. You can find your key in the provider's dashboard under API settings. Keys are stored securely on your machine.")}
                      </p>
                    </OnboardingDisclosure>
                  )}

                  <PluginSlot slotId="onboarding-setup-help" projectId={projectId} />

                </>
              )}

            </div>
          )}

          {step === "github" && (
            <div className="model-onboarding-github">
              {isGitHubReady ? (
                <p className="model-onboarding-description">
                  {isGitHubReadyViaCli
                    ? t("setup.githubCliAlreadyAuth", "GitHub CLI is already authenticated — issue imports and pull request tracking work right now. You're all set; no further action needed.")
                    : t("setup.githubConnected", "GitHub is connected — issue imports and pull request tracking are available. You're all set; no further action needed.")}
                </p>
              ) : (
                <p className="model-onboarding-description">
                  {t("setup.githubConnectionDescription", "Connecting GitHub unlocks issue imports and pull request tracking. You can skip this — task creation works without it.")}
                </p>
              )}
              {!isGitHubReady && (
                <div className="onboarding-feature-list">
                  <ul>
                    <li className="onboarding-feature-list-heading">
                      <strong>{t("setup.withoutGitHubHeading", "Without GitHub (available now):")}</strong>
                    </li>
                    <li className="onboarding-helper-text">{t("setup.withoutGitHub1", "Create tasks manually")}</li>
                    <li className="onboarding-helper-text">{t("setup.withoutGitHub2", "Describe work for AI agents")}</li>
                    <li className="onboarding-helper-text">{t("setup.withoutGitHub3", "Track progress on the board")}</li>
                    <li className="onboarding-feature-list-heading">
                      <strong>{t("setup.withGitHubHeading", "With GitHub (after connecting):")}</strong>
                    </li>
                    <li className="onboarding-helper-text onboarding-feature-list-item--with-github">{t("setup.withGitHub1", "Import issues as tasks")}</li>
                    <li className="onboarding-helper-text onboarding-feature-list-item--with-github">{t("setup.withGitHub2", "Sync pull request status")}</li>
                    <li className="onboarding-helper-text onboarding-feature-list-item--with-github">{t("setup.withGitHub3", "Link code changes to tasks")}</li>
                  </ul>
                </div>
              )}

              {/* Skip-state banner: shown when AI setup was skipped */}
              {aiSetupSkipped && (
                <div className="onboarding-skip-banner" role="status">
                  <strong>{t("setup.noAiProviderConnected", "No AI provider connected")}</strong>
                  <p>
                    {t("setup.noAiProviderBody", "AI features like task planning and code generation won't be available until you connect one. You can set this up later in Settings.")}
                  </p>
                </div>
              )}

              <OnboardingDisclosure summary={t("setup.whatDoesGitHubIntegrationDo", "What does GitHub integration do?")}>
                <p className="onboarding-helper-text">
                  {t("setup.whatDoesGitHubIntegrationDoBody", "Without GitHub, you can still create and manage tasks manually. GitHub integration adds the ability to import issues as tasks, track pull request status alongside your work, and automatically link commits to tasks. Connect anytime from Settings → Authentication.")}
                </p>
              </OnboardingDisclosure>

              {!hasGithubProvider ? (
                <div className="model-onboarding-github-optional">
                  <div className="optional-icon optional-icon--github" aria-hidden="true">
                    <ProviderIcon provider="github" size="lg" />
                  </div>
                  {isGitHubReadyViaCli ? (
                    <p>
                      {t("setup.githubCliAuthNote", "GitHub CLI is already authenticated, so imports and PR tracking work now. OAuth from the dashboard is optional and only controls dashboard-managed connect/disconnect.")}
                    </p>
                  ) : (
                    <p>
                      {t("setup.githubOauthNotConnected", "GitHub OAuth isn't connected yet. You can set it up in Settings → Authentication, or continue now and connect later.")}
                    </p>
                  )}
                  <div className="model-onboarding-github-optional__actions">
                    <button
                      className="btn btn-primary btn-sm"
                      /*
                       * FNXC:Onboarding 2026-07-03-08:00:
                       * Advance via handleNext/handleSkip (not a raw setStep) so the GitHub step's
                       * status is recorded. When GitHub is ready via the gh CLI, "Continue with gh CLI
                       * auth" must COMPLETE the step (handleNext) — previously it jumped to project-setup
                       * without adding "github" to completedSteps, so step 2 never checked off. When
                       * GitHub isn't connected, "Continue without GitHub" is a SKIP (handleSkip).
                       */
                      onClick={isGitHubReadyViaCli ? handleNext : handleSkip}
                    >
                      {isGitHubReadyViaCli
                        ? t("setup.continueWithGhCli", "Continue with gh CLI auth →")
                        : t("setup.continueWithoutGitHub", "Continue without GitHub →")}
                    </button>
                    {isGitHubReadyViaCli && (
                      (authActionInProgress === "github" || isGithubLoginInProgress) ? (
                        <button className="btn btn-sm" disabled>
                          <Loader2 size={14} className="onboarding-spinner" />
                          {t("setup.waitingForOauthLogin", "Waiting for OAuth login…")}
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          <ProviderIcon provider="github" size="sm" />
                          {t("setup.connectOauthOptional", "Connect OAuth (optional)")}
                        </button>
                      )
                    )}
                  </div>
                  {isGitHubReadyViaCli && (authActionInProgress === "github" || isGithubLoginInProgress) && loginInstructions.github && (
                    <LoginInstructions
                      instructions={loginInstructions.github}
                      data-testid="onboarding-login-instructions-github"
                    />
                  )}
                </div>
              ) : (
                <>
                  <div className="onboarding-provider-row">
                    <div className="onboarding-provider-info">
                      <strong>
                        <GitPullRequest size={16} className="onboarding-provider-title-icon" />
                        {t("setup.githubProvider", "GitHub")}
                      </strong>
                      <span data-testid="onboarding-auth-status-github">
                        <GitHubStatusBadge status={githubStatus} />
                      </span>
                    </div>
                    {isGithubAuthenticated && (
                      authActionInProgress === "github" ? (
                        <button className="btn btn-sm" disabled>
                          {t("setup.loggingOut", "Logging out…")}
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogout("github")}
                        >
                          {t("setup.disconnect", "Disconnect")}
                        </button>
                      )
                    )}
                  </div>

                  {(githubStatus === "not-connected" || githubStatus === "pending") && (
                    <div className="onboarding-github-connect-cta" data-testid="onboarding-github-connect-cta">
                      {(authActionInProgress === "github" || isGithubLoginInProgress) ? (
                        <div className="onboarding-github-connect-actions">
                          <button className="btn btn-sm" disabled>
                            {t("setup.waitingForLogin", "Waiting for login…")}
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => void handleCancelLogin("github")}
                          >
                            {t("setup.cancelLogin", "Cancel")}
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          <GitPullRequest size={16} />
                          {t("setup.connect", "Connect")}
                        </button>
                      )}
                      {(authActionInProgress === "github" || isGithubLoginInProgress) && loginInstructions.github && (
                        <LoginInstructions
                          instructions={loginInstructions.github}
                          data-testid="onboarding-login-instructions-github"
                        />
                      )}
                    </div>
                  )}

                  {githubStatus === "connected" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--success">
                      {isGitHubReadyViaCli
                        ? t("setup.githubCliAuthSuccess", "GitHub CLI is authenticated. Imports and pull request tracking are available. Connect OAuth in Settings → Authentication if you want dashboard-managed sign-in controls.")
                        : t("setup.githubOauthConnected", "GitHub OAuth is connected. You can import issues and track pull requests.")}
                    </div>
                  )}

                  {githubStatus === "failed" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--error">
                      <p>{t("setup.githubConnectionFailed", "Connection failed or timed out.")}</p>
                      <div className="onboarding-github-feedback-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          {t("setup.retry", "Retry")}
                        </button>
                        <button
                          className="onboarding-skip-step-link"
                          onClick={handleSkipGitHubStep}
                        >
                          {t("setup.skipForNow", "Skip for now")}
                        </button>
                      </div>
                    </div>
                  )}

                  {githubStatus === "pending" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--info">
                      {t("setup.waitingForGitHubAuth", "Waiting for GitHub authorization…")}
                    </div>
                  )}

                  {githubStatus === "skipped" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--info">
                      <p>{t("setup.githubSkipped", "GitHub was skipped. You can connect anytime from Settings → Authentication.")}</p>
                      <div className="onboarding-github-feedback-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          {t("setup.connectAnyway", "Connect anyway")}
                        </button>
                      </div>
                    </div>
                  )}

                  {githubStatus === "not-connected" && (
                    <p className="onboarding-helper-text">
                      {t("setup.connectGitHubAnytime", "No worries if you're not ready — connect GitHub anytime from Settings → Authentication.")}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {step === "project-setup" && (
            <div className="model-onboarding-project-setup">
              <p className="model-onboarding-description">
                {t("setup.projectSetupDescription", "Choose your first project before creating or importing tasks. You can register an existing local directory or clone a GitHub repository URL through the setup wizard.")}
              </p>

              {!hasProjectSelected ? (
                <div className="onboarding-project-prerequisite" data-testid="onboarding-project-prerequisite">
                  <p className="onboarding-helper-text">
                    {t("setup.projectRequired", "A project is required before first-task actions are available.")}
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={onOpenSetupWizard}
                    data-testid="onboarding-open-setup-wizard"
                  >
                    {t("setup.setUpProject", "Set Up Project")}
                  </button>
                  <p className="onboarding-helper-text">
                    {t("setup.setupWizardHint", "In the setup wizard, pick an existing directory or paste a GitHub clone URL.")}
                  </p>
                </div>
              ) : (
                <div className="onboarding-project-ready" data-testid="onboarding-project-ready" role="status">
                  <p>{t("setup.projectSelected", "Project selected — task creation and imports are available.")}</p>
                </div>
              )}

              <OnboardingDisclosure summary={t("setup.whatDoesProjectSetupDo", "What does project setup do?")}>
                <p className="onboarding-helper-text">
                  {t("setup.whatDoesProjectSetupDoBody", "Project setup registers a workspace so Fusion knows where to read files, run commands, and track task changes.")}
                </p>
              </OnboardingDisclosure>
            </div>
          )}

          {step === "agent" && (
            <div className="setup-wizard-agent-step model-onboarding-agent-step">
              <p className="setup-wizard-agent-intro">
                {t("setup.firstAgentIntro", "Agents are optional. Fusion can build tasks without one by starting temporary agents for planning, coding, review, and merge. Create an agent only if you want help coordinating tasks and direction.")}
              </p>

              {!hasProjectSelected && (
                <div className="onboarding-project-prerequisite" data-testid="onboarding-agent-project-prerequisite">
                  <p className="onboarding-helper-text">
                    {t("setup.projectMustBeSelectedForAgent", "Set up a project before creating an agent. You can skip this and create tasks without one.")}
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={onOpenSetupWizard}
                    data-testid="onboarding-agent-open-setup-wizard"
                  >
                    {t("setup.setUpProject", "Set Up Project")}
                  </button>
                </div>
              )}

              <div className="setup-wizard-agent-layout">
                <section className="setup-wizard-agent-presets" aria-labelledby="model-onboarding-first-agent-presets-heading">
                  <div className="setup-wizard-agent-section-heading" id="model-onboarding-first-agent-presets-heading">
                    {t("setup.firstAgentTemplates", "Templates")}
                  </div>
                  <div className="setup-wizard-agent-preset-list" role="radiogroup" aria-label={t("setup.firstAgentTemplates", "Templates")}>
                    {AGENT_PRESETS.map((preset) => {
                      const selected = selectedAgentPresetId === preset.id;
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          className={`setup-wizard-agent-preset${selected ? " selected" : ""}`}
                          role="radio"
                          aria-checked={selected}
                          aria-label={selected ? t("setup.selectedAgentTemplate", "{{name}} selected", { name: preset.name }) : preset.name}
                          tabIndex={preset.id === agentPresetTabStopId ? 0 : -1}
                          data-model-onboarding-agent-preset-id={preset.id}
                          disabled={isAgentActionDisabled}
                          onClick={() => handleAgentPresetSelect(preset.id)}
                          onKeyDown={(event) => handleAgentPresetKeyDown(event, preset.id)}
                        >
                          <AgentAvatar agent={{ id: preset.id, icon: preset.icon, name: preset.name }} size={28} />
                          <span className="setup-wizard-agent-preset-copy">
                            <span className="setup-wizard-agent-preset-name">
                              {preset.name}
                              {preset.id === "ceo" && <span className="wizard-option-recommended">{t("setup.recommended", "Recommended")}</span>}
                            </span>
                            <span className="setup-wizard-agent-preset-description">{preset.description}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>

                <section className="setup-wizard-agent-preview" aria-labelledby="model-onboarding-first-agent-preview-heading">
                  <div className="setup-wizard-agent-section-heading" id="model-onboarding-first-agent-preview-heading">
                    {t("setup.firstAgentPreview", "Preview")}
                  </div>
                  <div className="setup-wizard-agent-preview-card">
                    <div className="setup-wizard-agent-preview-title-row">
                      <AgentAvatar agent={{ id: selectedAgentPresetId || "draft", icon: agentDraft.icon, name: agentDraft.name }} size={36} />
                      <div>
                        <h3>{agentDraft.name || t("setup.firstAgentDraftName", "Draft agent")}</h3>
                        <p>{agentDraft.title || selectedAgentPreset?.title || t("setup.firstAgentCustomDraft", "Custom agent draft")}</p>
                      </div>
                    </div>
                    <dl className="setup-wizard-agent-preview-list">
                      <div>
                        <dt>{t("agents.fieldRole", "Role")}</dt>
                        <dd>{agentDraft.role}</dd>
                      </div>
                      <div>
                        <dt>{t("agents.fieldInstructionsText", "Inline Instructions")}</dt>
                        <dd>{agentDraft.instructionsText || t("setup.firstAgentNoInstructions", "No inline instructions yet")}</dd>
                      </div>
                    </dl>
                    {agentOnboardingEnabled && (
                      <button
                        type="button"
                        className="btn setup-wizard-agent-ai-btn"
                        onClick={() => setIsAgentInterviewOpen(true)}
                        disabled={isAgentActionDisabled}
                      >
                        <Sparkles size={16} />
                        <span>{t("agents.aiInterview", "AI Interview")}</span>
                      </button>
                    )}
                  </div>
                </section>
              </div>

              {agentCreationError && (
                <div className="wizard-error" role="alert" tabIndex={-1} ref={agentErrorRef}>
                  {agentCreationError}
                </div>
              )}
            </div>
          )}

          {step === "first-task" && (
            <div className="model-onboarding-first-task">
              <p className="model-onboarding-description">
                {t("setup.firstTaskDescription", "Create your first task to start the board and launch AI execution.")}
              </p>

              {showTaskCreated && createdTaskForDisplay ? (
                <div className="onboarding-task-created">
                  <CheckCircle size={56} className="success-icon" />
                  <h3 className="onboarding-task-created__title">{t("setup.firstTaskReady", "Your first task is ready!")}</h3>
                  <div className="onboarding-task-created__task-id">{createdTaskForDisplay.id}</div>
                  {firstCreatedTaskPreview && (
                    <p className="onboarding-task-created__description">{firstCreatedTaskPreview}</p>
                  )}
                  <p className="onboarding-task-created__hint">
                    {t("setup.taskCreatedHint", "Your task has been created and will appear on the board.")}
                  </p>
                  <div className="onboarding-task-created__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleViewCreatedTask}
                    >
                      {t("setup.viewTask", "View Task")}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleGoToDashboard}
                    >
                      {t("setup.goToDashboard", "Go to Dashboard")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {!hasProjectSelected ? (
                    <div className="onboarding-project-prerequisite" data-testid="onboarding-project-prerequisite">
                      <p className="onboarding-helper-text">
                        {t("setup.projectMustBeSelected", "A project must be selected before you can create tasks or import from GitHub.")}
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={onOpenSetupWizard}
                        data-testid="onboarding-open-setup-wizard"
                      >
                        {t("setup.setUpProject", "Set Up Project")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="onboarding-first-task-form">
                        <label className="onboarding-first-task-form__label" htmlFor="onboarding-first-task-input">
                          {t("setup.describeFirstTask", "Describe your first task")}
                        </label>
                        <textarea
                          id="onboarding-first-task-input"
                          className="input onboarding-first-task-form__input"
                          data-testid="onboarding-first-task-input"
                          value={firstTaskDescription}
                          onChange={(event) => {
                            setFirstTaskDescription(event.target.value);
                            setTaskCreationError(null);
                          }}
                          placeholder={t("setup.firstTaskPlaceholder", "Example: Build a login page with email and password")}
                          rows={4}
                        />
                        <div className="onboarding-first-task-form__actions">
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={handleCreateFirstTask}
                            disabled={isCreatingFirstTask}
                            data-testid="onboarding-first-task-submit"
                          >
                            {isCreatingFirstTask ? (
                              <>
                                <Loader2 size={16} className="animate-spin" />
                                <span>{t("setup.creatingTask", "Creating task…")}</span>
                              </>
                            ) : (
                              t("setup.createFirstTask", "Create First Task")
                            )}
                          </button>
                        </div>
                      </div>

                      {taskCreationError && (
                        <div className="onboarding-task-error" role="alert" data-testid="onboarding-task-error">
                          <p className="field-error">{taskCreationError}</p>
                          <p className="onboarding-helper-text">{t("setup.taskErrorHint", "Your text has been preserved — fix the issue and try again.")}</p>
                        </div>
                      )}
                    </>
                  )}

                  <ReadinessSummary items={readinessItems} />

                  {hasProjectSelected && (
                    <>
                      {/* FNXC:Onboarding 2026-06-22-04:01: The provider/GitHub onboarding flow also reaches task creation, so it must repeat that users can create tasks without creating or assigning a persistent agent; Fusion spawns temporary plan/execute/review/merge agents for task work. */}
                      <OnboardingDisclosure summary={t("setup.whatHappensWhenCreateTask", "What happens when I create a task?")}>
                        <p className="onboarding-helper-text">
                          {t("setup.whatHappensWhenCreateTaskBody", "Describe the work you want done. You can create tasks without an agent: Fusion starts temporary agents to plan, code, review, and merge. Track everything on the board.")}
                        </p>
                      </OnboardingDisclosure>

                      <div className="onboarding-cta-options">
                        <button
                          className="onboarding-cta-card primary"
                          onClick={handleOpenNewTask}
                          disabled={saving}
                        >
                          <div className="cta-icon">
                            <Plus size={24} />
                          </div>
                          <div className="cta-content">
                            <strong>{t("setup.createNewTask", "Create a New Task")}</strong>
                            <span>{t("setup.createNewTaskSubtitle", "Describe what you need built; Fusion will spawn temporary task agents automatically")}</span>
                          </div>
                        </button>

                        <button
                          className={`onboarding-cta-card${!isGitHubReady ? " onboarding-cta-card--disabled" : ""}`}
                          data-testid="cta-github-import"
                          onClick={handleOpenGitHubImport}
                          disabled={saving || !isGitHubReady}
                        >
                          <div className="cta-icon">
                            <GitPullRequest size={24} />
                          </div>
                          <div className="cta-content">
                            <strong>{t("setup.importFromGitHub", "Import from GitHub")}</strong>
                            <span>{t("setup.importFromGitHubSubtitle", "Turn GitHub issues into tasks you can track here")}</span>
                            {!isGitHubReady && (
                              <small className="onboarding-cta-note">{t("setup.requiresGitHubConnection", "Requires GitHub connection")}</small>
                            )}
                          </div>
                        </button>
                      </div>

                      <p className="onboarding-skip-note">
                        {t("setup.createTasksAnytimeNote", "You can create tasks anytime from the board, or use")} {" "}
                        <code>fn task create</code> {t("setup.createTasksAnytimeNoteTerminal", "in the terminal.")}
                      </p>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {step === "complete" && (
            <div className="model-onboarding-complete">
              <CheckCircle size={48} className="success-icon" />
              <p>
                {t("setup.setupComplete", "Setup complete! Head to the board to create your first task, or explore the dashboard to see what's available.")}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="model-onboarding-footer">
          <a
            className="btn model-onboarding-help-link"
            href="https://discord.gg/ksrfuy7WYR"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("setup.needHelp", "Need help?")}
          </a>
          {step === "ai-setup" && (
            <>
              <button
                className="btn btn-sm"
                onClick={handleDismiss}
                disabled={saving}
              >
                {t("setup.skipForNow", "Skip for now")}
              </button>
              <button className="onboarding-skip-step-link" onClick={handleSkip}>
                {t("setup.skipSetup", "Skip setup →")}
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                {t("setup.next", "Next →")}
              </button>
            </>
          )}

          {step === "github" && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                {t("setup.back", "← Back")}
              </button>
              <button className="onboarding-skip-step-link" onClick={handleSkip}>
                {t("setup.skipGitHub", "Skip GitHub →")}
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                {t("setup.next", "Next →")}
              </button>
            </>
          )}

          {step === "project-setup" && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                {t("setup.back", "← Back")}
              </button>
              <button className="btn btn-primary" onClick={handleNext} disabled={!hasProjectSelected}>
                {t("setup.next", "Next →")}
              </button>
            </>
          )}

          {step === "agent" && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                {t("setup.back", "← Back")}
              </button>
              <button
                className="btn"
                onClick={handleSkip}
                disabled={isCreatingAgent}
              >
                {t("setup.skipFirstAgent", "Skip for now")}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void handleCreateFirstAgent()}
                disabled={isAgentActionDisabled || !agentDraft.name.trim()}
                aria-busy={isCreatingAgent}
              >
                {isCreatingAgent ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>{t("setup.creatingFirstAgent", "Creating agent...")}</span>
                  </>
                ) : (
                  <span>{t("setup.createFirstAgent", "Create Agent")}</span>
                )}
              </button>
            </>
          )}

          {step === "first-task" && !showTaskCreated && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                {t("setup.back", "← Back")}
              </button>
              <button
                className="btn btn-primary"
                onClick={handleComplete}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>{t("setup.saving", "Saving…")}</span>
                  </>
                ) : (
                  t("setup.finishSetup", "Finish Setup")
                )}
              </button>
            </>
          )}

          {step === "complete" && (
            <button className="btn btn-primary" onClick={handleFinish}>
              <CheckCircle size={16} />
              <span>{t("setup.getStarted", "Get Started")}</span>
            </button>
          )}
        </div>
      </div>
      {agentOnboardingEnabled && isAgentInterviewOpen && (
        <ErrorBoundary
          level="modal"
          fallback={(
            <div className="wizard-error setup-wizard-agent-interview-error" role="alert">
              <span>{t("setup.firstAgentInterviewLoadError", "AI interview could not load. You can still create an agent from a template or skip this step.")}</span>
              <button type="button" className="btn" onClick={() => setIsAgentInterviewOpen(false)}>
                {t("setup.firstAgentContinueWithTemplates", "Continue with templates")}
              </button>
            </div>
          )}
        >
          <Suspense fallback={(
            <div className="wizard-error setup-wizard-agent-interview-error" role="status">
              {t("setup.firstAgentInterviewLoading", "Loading AI Interview...")}
            </div>
          )}
          >
            <ExperimentalAgentOnboardingModal
              isOpen={isAgentInterviewOpen}
              onClose={() => setIsAgentInterviewOpen(false)}
              onUseDraft={handleApplyAgentDraft}
              projectId={projectId}
              existingAgents={[]}
              mode="create"
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}
