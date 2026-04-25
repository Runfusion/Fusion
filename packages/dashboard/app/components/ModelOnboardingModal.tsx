import { useState, useEffect, useCallback, useRef } from "react";
import { X, Loader2, CheckCircle, Key, Zap, GitPullRequest, Rocket, Plus, ChevronRight } from "lucide-react";
import type { AuthProvider, ModelInfo } from "../api";
import {
  fetchAuthStatus,
  fetchGlobalSettings,
  loginProvider,
  logoutProvider,
  saveApiKey,
  clearApiKey,
  fetchModels,
  updateGlobalSettings,
  createTask,
} from "../api";
import type { ToastType } from "../hooks/useToast";
import { CustomModelDropdown } from "./CustomModelDropdown";
import { ProviderIcon } from "./ProviderIcon";
import { ClaudeCliProviderCard } from "./ClaudeCliProviderCard";
import { appendTokenQuery } from "../auth";

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
const PROVIDER_INFO: Record<string, ProviderInfo> = {
  anthropic: { description: "Claude models — strong at reasoning, analysis, and code" },
  openai: {
    description: "GPT models — versatile for a wide range of tasks",
    apiKeyInfo: {
      fieldLabel: "OpenAI API Key",
      setupInstructions: "Create an API key from your OpenAI dashboard under API keys.",
      dashboardUrl: "https://platform.openai.com/api-keys",
      inputPlaceholder: "sk-...",
      usageDescription: "Used for GPT models in task execution and planning",
    },
  },
  "openai-codex": { description: "Codex models by OpenAI — optimized for coding tasks" },
  google: { description: "Gemini models — multimodal with strong reasoning" },
  gemini: { description: "Gemini models — multimodal with strong reasoning" },
  ollama: {
    description: "Run open-source models locally on your machine",
    apiKeyInfo: {
      fieldLabel: "Ollama Endpoint",
      setupInstructions: "Enter your Ollama endpoint URL (for example http://localhost:11434).",
      inputPlaceholder: "http://localhost:11434",
      usageDescription: "Connects to your local Ollama instance",
    },
  },
  minimax: {
    description: "MiniMax models — cost-effective for high-volume usage",
    apiKeyInfo: {
      fieldLabel: "MiniMax API Key",
      setupInstructions: "Generate an API key from the MiniMax platform developer console.",
      dashboardUrl: "https://platform.minimaxi.com/",
      inputPlaceholder: "Enter your MiniMax API key",
      usageDescription: "Used for MiniMax models in task execution",
    },
  },
  zai: {
    description: "GLM models by Zhipu AI — strong multilingual support",
    apiKeyInfo: {
      fieldLabel: "Zhipu AI API Key",
      setupInstructions: "Create an API key in the Zhipu AI open platform account settings.",
      dashboardUrl: "https://open.bigmodel.cn/",
      inputPlaceholder: "Enter your Zhipu AI API key",
      usageDescription: "Used for GLM models in task execution",
    },
  },
  kimi: { description: "Kimi by Moonshot AI — long-context capabilities" },
  moonshot: { description: "Kimi by Moonshot AI — long-context capabilities" },
  "kimi-coding": {
    description: "Kimi by Moonshot AI — long-context capabilities",
    apiKeyInfo: {
      fieldLabel: "Kimi API Key",
      setupInstructions: "Create your API key in the Moonshot platform account settings.",
      dashboardUrl: "https://platform.moonshot.cn/",
      inputPlaceholder: "Enter your Kimi API key",
      usageDescription: "Used for Kimi/Moonshot AI models in task execution and planning",
    },
  },
  openrouter: {
    description: "OpenRouter — route requests across multiple AI providers",
    apiKeyInfo: {
      fieldLabel: "OpenRouter API Key",
      setupInstructions: "Create an API key from your OpenRouter account key management page.",
      dashboardUrl: "https://openrouter.ai/keys",
      inputPlaceholder: "sk-or-v1-...",
      usageDescription: "Routes to multiple AI model providers through a single key",
    },
  },
};

const PROVIDER_KEY_HINTS: Record<string, {
  pattern: RegExp;
  hint: string;
  example: string;
}> = {
  anthropic: { pattern: /^sk-ant-/, hint: "Starts with sk-ant-", example: "sk-ant-api03-..." },
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

const QUICK_START_PROVIDER_IDS = ["anthropic", "openai", "google", "gemini", "ollama"] as const;

const ONBOARDING_CURATED_PROVIDER_FAMILY_ORDER = [
  "anthropic",
  "claude-cli",
  "openai-codex",
  "gemini",
  "minimax",
  "kimi",
  "zai",
] as const;

const ONBOARDING_PROVIDER_FAMILY_ALIASES: Record<string, (typeof ONBOARDING_CURATED_PROVIDER_FAMILY_ORDER)[number]> = {
  anthropic: "anthropic",
  "claude-cli": "claude-cli",
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

function validateApiKeyFormat(providerId: string, key: string): string | null {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return "API key is required";
  }

  const providerHint = PROVIDER_KEY_HINTS[providerId] ?? PROVIDER_KEY_HINTS_FALLBACK;
  if (providerHint.pattern.test(trimmedKey)) {
    return null;
  }

  const providerName = getProviderDisplayName(providerId);
  return `${providerName} keys should follow this format: ${providerHint.hint} (e.g. ${providerHint.example})`;
}

const API_KEY_INFO_FALLBACK: ApiKeyInfo = {
  fieldLabel: "API Key",
  setupInstructions: "Enter your API key for this provider.",
  inputPlaceholder: "Enter API key",
  usageDescription: "Used by Fusion to authenticate requests to this provider",
};

/** Fallback description for providers not in the map */
const PROVIDER_INFO_FALLBACK: ProviderInfo = {
  description: "AI provider — connect to start using AI models",
  apiKeyInfo: API_KEY_INFO_FALLBACK,
};

function getProviderInfo(providerId: string): ProviderInfo {
  return PROVIDER_INFO[providerId] ?? PROVIDER_INFO_FALLBACK;
}

function getApiKeyInfo(provider: AuthProvider): ApiKeyInfo {
  const info = getProviderInfo(provider.id);
  return info.apiKeyInfo ?? API_KEY_INFO_FALLBACK;
}

/** Props for OnboardingDisclosure component */
interface OnboardingDisclosureProps {
  summary: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Progressive disclosure component that reveals additional content on click.
 * Used to hide technical details behind expandable "Learn more" sections.
 */
function OnboardingDisclosure({ summary, children, className = "" }: OnboardingDisclosureProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className={`onboarding-disclosure ${className}`}>
      <button
        className="onboarding-disclosure-trigger"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        type="button"
      >
        <ChevronRight
          size={14}
          className="onboarding-disclosure-chevron"
          aria-hidden="true"
        />
        <span>{summary}</span>
      </button>
      {isOpen && (
        <div className="onboarding-disclosure-content">
          {children}
        </div>
      )}
    </div>
  );
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
  const hasAttentionItems = items.some((item) => item.status !== "connected");

  if (!hasAttentionItems) {
    return (
      <div className="onboarding-readiness-summary" data-testid="readiness-summary" role="status">
        <p className="onboarding-readiness-all-connected">✓ All integrations connected</p>
      </div>
    );
  }

  return (
    <div className="onboarding-readiness-summary" data-testid="readiness-summary" role="status">
      <p className="onboarding-readiness-header">Setup Summary</p>
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
          Format: {providerKeyHint.hint}
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
          Get your API key →
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
          <span className="auth-status-badge connected">✓ API key saved</span>
        </div>
        <button
          className="btn btn-sm"
          onClick={() => onClear(provider.id)}
          disabled={isSaving}
        >
          {isSaving ? "Removing…" : "Remove Key"}
        </button>
        <OnboardingDisclosure summary="Advanced setup details">
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
          placeholder={apiKeyInfo.inputPlaceholder ?? "Enter API key"}
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
          {isSaving ? "Saving…" : "Save"}
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
      <OnboardingDisclosure summary="Advanced setup details">
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
  type OnboardingStep,
} from "./model-onboarding-state";
import { trackOnboardingEvent } from "./onboarding-events";
import type { SectionId } from "./SettingsModal";

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
 * 3. First Task - CTA to create first task or import from GitHub
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
}: ModelOnboardingModalProps) {
  // Initialize from persisted state if available (allows resume from last step)
  const persistedState = getOnboardingState();
  const initialStep: OnboardingStep = persistedState && persistedState.currentStep !== "complete"
    ? persistedState.currentStep as OnboardingStep
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
  const [authProviders, setAuthProviders] = useState<AuthProvider[]>([]);
  const [ghCliStatus, setGhCliStatus] = useState<GhCliStatus | undefined>(undefined);
  const [authLoading, setAuthLoading] = useState(true);
  const [authActionInProgress, setAuthActionInProgress] = useState<string | null>(null);
  const [loginInstructions, setLoginInstructions] = useState<Record<string, string>>({});
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [apiKeyErrors, setApiKeyErrors] = useState<Record<string, string>>({});
  const [apiKeySuccess, setApiKeySuccess] = useState<Record<string, string | null>>({});
  const apiKeySuccessTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const onboardingContentRef = useRef<HTMLDivElement | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [loginOutcomes, setLoginOutcomes] = useState<Record<string, LoginOutcome>>({});
  const [isGithubSkipped, setIsGithubSkipped] = useState<boolean>(() => {
    const state = getOnboardingState();
    return state?.stepData?.github?.skipped === true;
  });
  const pollCountRef = useRef<number>(0);
  const previousCreatedTaskRef = useRef<Task | null | undefined>(firstCreatedTask);
  const hasTrackedWizardOpenRef = useRef(false);
  const resumedFromStep = persistedState?.currentStep;
  const isResumedFlow = !!persistedState && persistedState.currentStep !== "complete";

  // Initialize skippedProviders from persisted state
  const [skippedProviders, setSkippedProviders] = useState<Record<string, boolean>>(
    () => {
      const state = getOnboardingState();
      const data = state?.stepData?.["ai-setup"];
      return (data?.skippedProviders as Record<string, boolean>) ?? {};
    }
  );

  // Step definitions for progress indicator
  const steps = [
    { key: "ai-setup" as const, label: "AI Setup" },
    { key: "github" as const, label: "GitHub" },
    { key: "first-task" as const, label: "First Task" },
  ];

  // Get current step index for progress indicator
  const currentStepIndex = steps.findIndex((s) => s.key === step);

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
      setAuthProviders(providers);
      setGhCliStatus(ghCli);
      setLoginInstructions((prev) => {
        const next: Record<string, string> = {};
        for (const [providerId, instructions] of Object.entries(prev)) {
          const provider = providers.find((candidate) => candidate.id === providerId);
          if (provider && !provider.authenticated) {
            next[providerId] = instructions;
          }
        }
        return Object.keys(next).length === Object.keys(prev).length ? prev : next;
      });
      // Remove from skippedProviders when a provider becomes authenticated
      setSkippedProviders((prev) => {
        const updated = { ...prev };
        for (const p of providers) {
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

  // Reload auth status when returning to AI Setup step from another step (not on initial mount)
  const aiSetupReturnRef = useRef(false);
  useEffect(() => {
    if (aiSetupReturnRef.current) {
      loadAuthStatus();
    }
    aiSetupReturnRef.current = step !== "ai-setup";
  }, [step, loadAuthStatus]);

  // OAuth status for the GitHub provider (used for OAuth-specific controls like Connect/Disconnect).
  const githubProvider = authProviders.find((p) => p.id === "github");
  const hasGithubProvider = !!githubProvider;
  const isGithubAuthenticated = githubProvider?.authenticated ?? false;
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
      connected: { text: "✓ Connected", className: "auth-status-badge connected" },
      "not-connected": { text: "Not connected", className: "auth-status-badge not-connected" },
      skipped: { text: "Skipped", className: "auth-status-badge skipped" },
      retry: { text: "Retry", className: "auth-status-badge retry" },
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
      connected: { text: "✓ Connected", className: "auth-status-badge connected" },
      pending: { text: "⏳ Connecting…", className: "auth-status-badge pending" },
      failed: { text: "✗ Connection failed", className: "auth-status-badge retry" },
      skipped: { text: "Skipped", className: "auth-status-badge skipped" },
      "not-connected": { text: "Not connected", className: "auth-status-badge not-connected" },
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

    if (step === "ai-setup") {
      setStep("github");
    } else if (step === "github") {
      setStep("first-task");
    }
  }, [step, isGithubAuthenticated, setGitHubSkippedState]);

  // Navigate forward without marking completion
  const handleSkip = useCallback(() => {
    setSkippedSteps((prev) => [...new Set([...prev, step])]);
    markStepSkipped(step);
    trackOnboardingEvent("onboarding:step-skipped", { step });

    if (step === "github" && !isGithubAuthenticated) {
      setGitHubSkippedState(true);
    }

    if (step === "ai-setup") {
      setStep("github");
    } else if (step === "github") {
      setStep("first-task");
    }
  }, [step, isGithubAuthenticated, setGitHubSkippedState]);

  // Navigate to previous step
  const handleBack = useCallback(() => {
    // Remove current step from completed/skipped when going back (undoing progress)
    const currentStepKey = step;
    setCompletedSteps((prev) => prev.filter((s) => s !== currentStepKey));
    setSkippedSteps((prev) => prev.filter((s) => s !== currentStepKey));

    if (currentStepKey === "github" && !isGithubAuthenticated) {
      setGitHubSkippedState(false);
    }

    if (step === "github") {
      setStep("ai-setup");
    } else if (step === "first-task") {
      setStep("github");
    }
  }, [step, isGithubAuthenticated, setGitHubSkippedState]);

  const handleSkipGitHubStep = useCallback(() => {
    handleSkip();
  }, [handleSkip]);

  // OAuth login handler
  const handleLogin = useCallback(
    async (providerId: string) => {
      // Clear any previous terminal outcome before starting a new login attempt
      setLoginOutcomes((prev) => {
        const outcome = prev[providerId];
        if (outcome && outcome !== "pending") {
          const { [providerId]: _, ...rest } = prev;
          return rest;
        }
        return prev;
      });

      setLoginInstructions((prev) => {
        if (!(providerId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[providerId];
        return next;
      });

      // Set outcome to pending
      setLoginOutcomes((prev) => ({ ...prev, [providerId]: "pending" }));
      setAuthActionInProgress(providerId);
      pollCountRef.current = 0;

      try {
        const { url, instructions } = await loginProvider(providerId);
        if (instructions?.trim()) {
          setLoginInstructions((prev) => ({ ...prev, [providerId]: instructions }));
        }
        window.open(appendTokenQuery(url), "_blank");

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
            setLoginOutcomes((prev) => ({ ...prev, [providerId]: "timeout" }));
            setLoginInstructions((prev) => {
              if (!(providerId in prev)) {
                return prev;
              }
              const next = { ...prev };
              delete next[providerId];
              return next;
            });
            addToast("Login timed out. Please try again.", "warning");
            return;
          }

          try {
            const { providers, ghCli } = await fetchAuthStatus();
            setAuthProviders(providers);
            setGhCliStatus(ghCli);
            const provider = providers.find((p) => p.id === providerId);
            if (provider?.authenticated) {
              if (pollIntervalRef.current) {
                clearInterval(pollIntervalRef.current);
                pollIntervalRef.current = null;
              }
              setAuthActionInProgress(null);
              setLoginOutcomes((prev) => ({ ...prev, [providerId]: "success" }));
              setLoginInstructions((prev) => {
                if (!(providerId in prev)) {
                  return prev;
                }
                const next = { ...prev };
                delete next[providerId];
                return next;
              });
              if (providerId === "github") {
                setGitHubSkippedState(false);
              }
              addToast("Login successful", "success");
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
          addToast("Login already in progress. Please wait or cancel the current attempt.", "warning");
          setLoginOutcomes((prev) => ({ ...prev, [providerId]: "failed" }));
        } else {
          addToast(err instanceof Error ? err.message : "Login failed", "error");
          setLoginOutcomes((prev) => ({ ...prev, [providerId]: "failed" }));
        }
        setAuthActionInProgress(null);
        setLoginInstructions((prev) => {
          if (!(providerId in prev)) {
            return prev;
          }
          const next = { ...prev };
          delete next[providerId];
          return next;
        });
      }
    },
    [addToast, setGitHubSkippedState],
  );

  // Cancellation handler for in-progress logins
  const handleCancelLogin = useCallback((providerId: string) => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setAuthActionInProgress(null);
    pollCountRef.current = 0;
    setLoginOutcomes((prev) => ({ ...prev, [providerId]: "cancelled" }));
    setLoginInstructions((prev) => {
      if (!(providerId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[providerId];
      return next;
    });
  }, []);

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
      const validationError = validateApiKeyFormat(providerId, key);
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
          [providerId]: "✓ Key saved",
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

        addToast("API key saved", "success");
      } catch (err: unknown) {
        const errorMessage =
          err instanceof TypeError && err.message.includes("Failed to fetch")
            ? "Could not reach the server. Check your connection and try again."
            : err instanceof Error
              ? err.message
              : "Failed to save API key";

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
        addToast("API key removed", "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : "Failed to clear API key",
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
        addToast("Logged out", "success");
      } catch (err: unknown) {
        addToast(
          err instanceof Error ? err.message : "Logout failed",
          "error",
        );
      } finally {
        setAuthActionInProgress(null);
      }
    },
    [addToast, loadAuthStatus],
  );

  // Handle model selection from CustomModelDropdown
  const handleModelSelect = useCallback((value: string) => {
    setSelectedModel(value);
  }, []);

  const completeOnboarding = useCallback(async () => {
    try {
      const updates: Record<string, unknown> = {
        modelOnboardingComplete: true,
      };

      // If a model was selected, persist it as the default
      if (selectedModel) {
        const slashIdx = selectedModel.indexOf("/");
        const provider =
          slashIdx !== -1 ? selectedModel.slice(0, slashIdx) : undefined;
        const modelId =
          slashIdx !== -1 ? selectedModel.slice(slashIdx + 1) : selectedModel;

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
    setSaving(true);
    try {
      await completeOnboarding();
      trackOnboardingEvent("onboarding:completed", { completedSteps, skippedSteps });
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
      setTaskCreationError("Please enter a task description.");
      return;
    }

    setTaskCreationError(null);
    setIsCreatingFirstTask(true);

    let success = false;

    try {
      const createdTask = await createTask({ description: trimmedDescription }, projectId);
      setInlineCreatedTask(createdTask);
      setShowTaskCreated(true);
      trackOnboardingEvent("onboarding:first-task-created", { taskId: createdTask?.id });
      addToast("Task created", "success");
      success = true;
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Something went wrong creating your task. Please try again.";
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

  if (!isOpen) return null;

  const githubStatus = getGitHubStatus();

  const aiProviders = authProviders.filter((provider) => provider.id !== "github");
  const orderedAiProviders = [...aiProviders].sort(compareOnboardingProviders);
  const hasOauthProviders = orderedAiProviders.some((provider) => !provider.type || provider.type === "oauth");
  const hasApiKeyProviders = orderedAiProviders.some((provider) => provider.type === "api_key");
  const connectedAiProviders = aiProviders.filter((provider) => provider.authenticated);
  const hasAiProvider = connectedAiProviders.length > 0;
  const hasProjectSelected = Boolean(projectId);
  // True when on GitHub step but skipped AI setup (no AI provider connected)
  const aiSetupSkipped = step === "github" && !hasAiProvider;

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
      label: "Project",
      status: "connected",
      detail: "Project selected — task creation and imports are available",
    });
  } else {
    readinessItems.push({
      label: "Project",
      status: "missing",
      detail: "Register a project to enable task creation and imports",
    });
  }

  if (hasAiProvider) {
    const firstConnectedProviderName = getProviderDisplayName(connectedAiProviders[0]?.id ?? "");
    readinessItems.push({
      label: "AI Provider",
      status: "connected",
      detail: `${firstConnectedProviderName} connected — AI agents can work on tasks`,
    });
  } else if (
    aiProviders.length > 0
    && aiProviders.some((provider) => skippedProviders[provider.id])
  ) {
    readinessItems.push({
      label: "AI Provider",
      status: "skipped",
      detail: "AI agents won't be available until you connect a provider",
    });
  } else {
    readinessItems.push({
      label: "AI Provider",
      status: "missing",
      detail: "Connect a provider in Settings → AI Setup",
    });
  }

  if (isGitHubReady) {
    readinessItems.push({
      label: "GitHub",
      status: "connected",
      detail: isGitHubReadyViaCli
        ? "Connected via GitHub CLI — imports and PR tracking are available"
        : "Issues and PRs can be imported",
    });
  } else if (!hasGithubProvider || isGithubSkipped) {
    readinessItems.push({
      label: "GitHub",
      status: "skipped",
      detail: "You can connect anytime from Settings",
    });
  } else {
    readinessItems.push({
      label: "GitHub",
      status: "missing",
      detail: "Connect to import issues as tasks",
    });
  }

  if (selectedModelDisplayName) {
    readinessItems.push({
      label: "Default Model",
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
  const quickStartProviders = orderedAiProviders
    .filter((provider) => quickStartSet.has(provider.id))
    .sort((a, b) => {
      const rankA = QUICK_START_PROVIDER_IDS.indexOf(a.id as (typeof QUICK_START_PROVIDER_IDS)[number]);
      const rankB = QUICK_START_PROVIDER_IDS.indexOf(b.id as (typeof QUICK_START_PROVIDER_IDS)[number]);
      if (rankA !== rankB) {
        return rankA - rankB;
      }
      return compareOnboardingProviders(a, b);
    });
  const connectedNonQuickStartProviders = orderedAiProviders.filter(
    (provider) => provider.authenticated && !quickStartSet.has(provider.id),
  );
  const advancedProviders = orderedAiProviders.filter(
    (provider) => !provider.authenticated && !quickStartSet.has(provider.id),
  );

  const renderAiProviderCard = (provider: AuthProvider) => {
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

    if (provider.type === "api_key") {
      const providerInfo = getProviderInfo(provider.id);
      const apiKeyInfo = getApiKeyInfo(provider);

      return (
        <div
          key={provider.id}
          data-testid={`onboarding-provider-card-${provider.id}`}
          className={`onboarding-provider-card${provider.authenticated ? " onboarding-provider-card--connected" : ""}`}
        >
          <div className="onboarding-provider-card__icon">
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
              <span className="auth-key-hint">Key: {provider.keyHint}</span>
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
              isConnected={provider.authenticated}
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
        <div className="onboarding-provider-card__icon">
          <ProviderIcon provider={provider.id} size="md" />
        </div>
        <div className="onboarding-provider-card__body">
          <strong className="onboarding-provider-card__name">{provider.name}</strong>
          <span className="onboarding-provider-card__description">
            {getProviderInfo(provider.id).description}
          </span>
          <ProviderStatusBadge status={getProviderStatus(provider)} />
        </div>
        <div className="onboarding-provider-card__actions">
          {authActionInProgress === provider.id ? (
            <>
              <button className="btn btn-sm" disabled>
                {provider.authenticated
                  ? "Logging out…"
                  : "Waiting for login…"}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => handleCancelLogin(provider.id)}
              >
                Cancel
              </button>
            </>
          ) : provider.authenticated ? (
            <button
              className="btn btn-sm"
              onClick={() => handleLogout(provider.id)}
            >
              Logout
            </button>
          ) : (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => handleLogin(provider.id)}
            >
              Login
            </button>
          )}
        </div>
        {authActionInProgress === provider.id && loginInstructions[provider.id] && (
          <p
            className="auth-login-instructions"
            data-testid={`onboarding-login-instructions-${provider.id}`}
          >
            {loginInstructions[provider.id]}
          </p>
        )}
        {loginOutcomes[provider.id] === "timeout" && authActionInProgress !== provider.id && (
          <p className="onboarding-helper-text onboarding-inline-feedback">
            Login timed out. Please try again.
          </p>
        )}
        {loginOutcomes[provider.id] === "failed" && authActionInProgress !== provider.id && (
          <p className="field-error onboarding-inline-feedback">
            Login failed. Please try again.
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
      <div className="modal model-onboarding-modal">
        {/* Header */}
        <div className="model-onboarding-header">
          <h2 id="onboarding-title" className="model-onboarding-title">
            {step === "ai-setup" && (
              <>
                <Zap size={24} /> Set Up AI <span className="onboarding-optional-badge">Optional</span>
              </>
            )}
            {step === "github" && (
              <>
                <GitPullRequest size={24} /> Connect GitHub <span className="onboarding-optional-badge">Optional</span>
              </>
            )}
            {step === "first-task" && (
              <>
                <Rocket size={24} /> Create Your First Task
              </>
            )}
            {step === "complete" && (
              <>
                <CheckCircle size={24} /> All Set!
              </>
            )}
          </h2>
          {step !== "complete" && (
            <button
              className="modal-close"
              onClick={handleDismiss}
              aria-label="Skip onboarding"
              title="Skip for now"
            >
              <X size={20} />
            </button>
          )}
        </div>

        {/* Step indicator - 3 progress steps + complete */}
        <div className="model-onboarding-steps">
          {steps.map((s, index) => {
            // A step is done if it's in completedSteps AND is before current position
            const isDone = completedSteps.includes(s.key) && currentStepIndex > index;
            const isSkipped = skippedSteps.includes(s.key) && !completedSteps.includes(s.key) && currentStepIndex > index;
            // Clickable if it's a completed/skipped step (can review)
            const isClickable = isDone || isSkipped;
            return (
              <div key={s.key} className="onboarding-step-wrapper">
                {index > 0 && (
                  <div
                    className={`model-onboarding-step-connector ${
                      index <= currentStepIndex ? "done" : ""
                    }`}
                  />
                )}
                {isClickable ? (
                  <button
                    className={`model-onboarding-step-indicator ${
                      step === s.key ? "active" : ""
                    } ${isDone ? "done" : ""} ${isSkipped ? "skipped" : ""}`}
                    onClick={() => setStep(s.key)}
                    aria-label={`Go back to ${s.label}`}
                    title={`Review ${s.label}`}
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
                Fusion uses AI models to plan, write, and review code for you.
                Connect an AI provider below to get started — you can use a hosted
                service or enter an API key.
              </p>
              <p className="onboarding-helper-text model-onboarding-primary-helper">
                You only need one provider to get started.
              </p>

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
                    summaryText = `✓ ${connectedCount} of ${totalAiProviders} provider${totalAiProviders !== 1 ? "s" : ""} connected`;
                  } else if (skippedCount > 0) {
                    summaryClass += " onboarding-provider-summary--skipped";
                    summaryText = `${skippedCount} provider${skippedCount !== 1 ? "s" : ""} skipped`;
                  } else {
                    summaryClass += " onboarding-provider-summary--none";
                    summaryText = "No providers connected yet";
                  }

                  return (
                    <div className={summaryClass} data-testid="provider-summary">
                      {summaryText}
                    </div>
                  );
                })()
              )}

              {/* Provider explanation disclosure */}
              <OnboardingDisclosure summary="What are AI providers?">
                <p className="onboarding-helper-text">
                  AI providers like OpenAI and Anthropic power the AI capabilities in Fusion.
                  Connecting a provider lets Fusion's agents use AI models to help with your tasks.
                </p>
              </OnboardingDisclosure>

              {/* Show helper text when providers exist but none are authenticated */}
              {authProviders.length > 0 && !authProviders.some((p) => p.authenticated) && (
                <p className="onboarding-helper-text">
                  Skip this step if you'd like — you can always add providers later from Settings.
                </p>
              )}

              {authLoading ? (
                <div className="model-onboarding-loading">
                  <Loader2 size={24} className="animate-spin" />
                  <span>Loading providers…</span>
                </div>
              ) : authProviders.length === 0 ? (
                <div className="model-onboarding-empty">
                  No AI providers are configured. Please check your Fusion
                  configuration.
                </div>
              ) : (
                <>
                  <section className="onboarding-provider-section" data-testid="onboarding-quick-start-providers">
                    <h3 className="onboarding-section-title">Quick start providers</h3>
                    {quickStartProviders.length > 0 ? (
                      <div className="model-onboarding-providers">
                        {quickStartProviders.map((provider) => renderAiProviderCard(provider))}
                      </div>
                    ) : (
                      <p className="onboarding-helper-text">
                        No quick-start providers are available in this environment.
                      </p>
                    )}
                  </section>

                  {connectedNonQuickStartProviders.length > 0 && (
                    <section className="onboarding-provider-section" data-testid="onboarding-connected-providers">
                      <h3 className="onboarding-section-title">Connected providers</h3>
                      <div className="model-onboarding-providers">
                        {connectedNonQuickStartProviders.map((provider) => renderAiProviderCard(provider))}
                      </div>
                    </section>
                  )}

                  <OnboardingDisclosure summary="Advanced provider settings" className="onboarding-provider-advanced">
                    <div data-testid="onboarding-advanced-provider-settings">
                      {advancedProviders.length > 0 ? (
                        <div className="model-onboarding-providers">
                          {advancedProviders.map((provider) => renderAiProviderCard(provider))}
                        </div>
                      ) : (
                        <p className="onboarding-helper-text">
                          All currently available providers are already shown above.
                        </p>
                      )}
                    </div>
                  </OnboardingDisclosure>

                  {/* OAuth login disclosure */}
                  {hasOauthProviders && (
                    <OnboardingDisclosure summary="How does login work?">
                      <p className="onboarding-helper-text">
                        Clicking Login opens the provider's website in a new tab where you sign in.
                        Once you authorize Fusion, this page will automatically detect the connection.
                        Your credentials are never stored in Fusion.
                      </p>
                    </OnboardingDisclosure>
                  )}

                  {/* API key disclosure */}
                  {hasApiKeyProviders && (
                    <OnboardingDisclosure summary="What is an API key?">
                      <p className="onboarding-helper-text">
                        An API key is a secret token that authenticates Fusion with the provider.
                        You can find your key in the provider's dashboard under API settings.
                        Keys are stored securely on your machine.
                      </p>
                    </OnboardingDisclosure>
                  )}

                </>
              )}

              {/* Model Selection */}
              <div className="onboarding-model-section">
                <h3 className="onboarding-section-title">
                  Default Model (Optional)
                </h3>
                <p className="model-onboarding-description">
                  Pick a default model for AI tasks, or leave this blank to choose
                  later. Models vary in speed, capability, and cost.
                </p>

                <OnboardingDisclosure summary="How do I choose a model?">
                  <p className="onboarding-helper-text">
                    Models vary in speed, capability, and cost. A good default is usually
                    the latest model from your connected provider. You can always change this
                    later in Settings.
                  </p>
                </OnboardingDisclosure>

                {availableModels.length === 0 ? (
                  <div className="model-onboarding-empty">
                    No models available yet. Connect a provider above to see model options.
                  </div>
                ) : (
                  <div className="onboarding-model-selector">
                    <CustomModelDropdown
                      models={availableModels}
                      value={selectedModel}
                      onChange={handleModelSelect}
                      placeholder="Select a default model…"
                      label="Default model"
                    />
                  </div>
                )}

                {selectedModel && (
                  <div className="onboarding-model-preview">
                    <small className="settings-muted">
                      Selected:{" "}
                      {availableModels.find((m) => m.id === selectedModel)
                        ?.name ?? selectedModel}
                    </small>
                  </div>
                )}
              </div>

            </div>
          )}

          {step === "github" && (
            <div className="model-onboarding-github">
              <p className="model-onboarding-description">
                Connecting GitHub unlocks issue imports and pull request tracking. You can skip this — task creation works without it.
              </p>
              <div className="onboarding-feature-list">
                <ul>
                  <li className="onboarding-feature-list-heading">
                    <strong>Without GitHub (available now):</strong>
                  </li>
                  <li className="onboarding-helper-text">Create tasks manually</li>
                  <li className="onboarding-helper-text">Describe work for AI agents</li>
                  <li className="onboarding-helper-text">Track progress on the board</li>
                  <li className="onboarding-feature-list-heading">
                    <strong>With GitHub (after connecting):</strong>
                  </li>
                  <li className="onboarding-helper-text onboarding-feature-list-item--with-github">Import issues as tasks</li>
                  <li className="onboarding-helper-text onboarding-feature-list-item--with-github">Sync pull request status</li>
                  <li className="onboarding-helper-text onboarding-feature-list-item--with-github">Link code changes to tasks</li>
                </ul>
              </div>

              {/* Skip-state banner: shown when AI setup was skipped */}
              {aiSetupSkipped && (
                <div className="onboarding-skip-banner" role="status">
                  <strong>No AI provider connected</strong>
                  <p>
                    AI features like task planning and code generation won&apos;t be available until you connect one.
                    You can set this up later in Settings.
                  </p>
                </div>
              )}

              <OnboardingDisclosure summary="What does GitHub integration do?">
                <p className="onboarding-helper-text">
                  Without GitHub, you can still create and manage tasks manually. GitHub integration adds the ability to import issues as tasks, track pull request status alongside your work, and automatically link commits to tasks. Connect anytime from Settings → Authentication.
                </p>
              </OnboardingDisclosure>

              {!hasGithubProvider ? (
                <div className="model-onboarding-github-optional">
                  <GitPullRequest size={48} className="optional-icon" />
                  {isGitHubReadyViaCli ? (
                    <p>
                      GitHub CLI is already authenticated, so imports and PR tracking work now.
                      OAuth integration in Settings → Authentication is optional and only controls
                      dashboard-managed connect/disconnect.
                    </p>
                  ) : (
                    <p>
                      GitHub OAuth isn&apos;t connected yet. You can set it up in Settings → Authentication,
                      or continue now and connect later.
                    </p>
                  )}
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => setStep("first-task")}
                  >
                    Continue without GitHub →
                  </button>
                </div>
              ) : (
                <>
                  <div className="onboarding-provider-row">
                    <div className="onboarding-provider-info">
                      <strong>
                        <GitPullRequest size={16} className="onboarding-provider-title-icon" />
                        GitHub
                      </strong>
                      <span data-testid="onboarding-auth-status-github">
                        <GitHubStatusBadge status={githubStatus} />
                      </span>
                    </div>
                    {isGithubAuthenticated && (
                      authActionInProgress === "github" ? (
                        <button className="btn btn-sm" disabled>
                          Logging out…
                        </button>
                      ) : (
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogout("github")}
                        >
                          Disconnect
                        </button>
                      )
                    )}
                  </div>

                  {(githubStatus === "not-connected" || githubStatus === "pending") && (
                    <div className="onboarding-github-connect-cta" data-testid="onboarding-github-connect-cta">
                      {authActionInProgress === "github" ? (
                        <div className="onboarding-github-connect-actions">
                          <button className="btn btn-sm" disabled>
                            Waiting for login…
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => handleCancelLogin("github")}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className="btn btn-primary btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          <GitPullRequest size={16} />
                          Connect
                        </button>
                      )}
                    </div>
                  )}

                  {githubStatus === "connected" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--success">
                      {isGitHubReadyViaCli
                        ? "GitHub CLI is authenticated. Imports and pull request tracking are available. Connect OAuth in Settings → Authentication if you want dashboard-managed sign-in controls."
                        : "GitHub OAuth is connected. You can import issues and track pull requests."}
                    </div>
                  )}

                  {githubStatus === "failed" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--error">
                      <p>Connection failed or timed out.</p>
                      <div className="onboarding-github-feedback-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          Retry
                        </button>
                        <button
                          className="onboarding-skip-step-link"
                          onClick={handleSkipGitHubStep}
                        >
                          Skip for now
                        </button>
                      </div>
                    </div>
                  )}

                  {githubStatus === "pending" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--info">
                      Waiting for GitHub authorization…
                    </div>
                  )}

                  {githubStatus === "skipped" && (
                    <div className="onboarding-github-feedback onboarding-github-feedback--info">
                      <p>GitHub was skipped. You can connect anytime from Settings → Authentication.</p>
                      <div className="onboarding-github-feedback-actions">
                        <button
                          className="btn btn-sm"
                          onClick={() => handleLogin("github")}
                        >
                          Connect anyway
                        </button>
                      </div>
                    </div>
                  )}

                  {githubStatus === "not-connected" && (
                    <p className="onboarding-helper-text">
                      No worries if you're not ready — connect GitHub anytime from Settings → Authentication.
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {step === "first-task" && (
            <div className="model-onboarding-first-task">
              <p className="model-onboarding-description">
                {hasProjectSelected
                  ? "Your workspace is ready. Here's how to get started:"
                  : "Before creating your first task, register a project directory."}
              </p>

              {showTaskCreated && createdTaskForDisplay ? (
                <div className="onboarding-task-created">
                  <CheckCircle size={56} className="success-icon" />
                  <h3 className="onboarding-task-created__title">Your first task is ready!</h3>
                  <div className="onboarding-task-created__task-id">{createdTaskForDisplay.id}</div>
                  {firstCreatedTaskPreview && (
                    <p className="onboarding-task-created__description">{firstCreatedTaskPreview}</p>
                  )}
                  <p className="onboarding-task-created__hint">
                    Your task has been created and will appear on the board.
                  </p>
                  <div className="onboarding-task-created__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleViewCreatedTask}
                    >
                      View Task
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleGoToDashboard}
                    >
                      Go to Dashboard
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {!hasProjectSelected ? (
                    <div className="onboarding-project-prerequisite" data-testid="onboarding-project-prerequisite">
                      <p className="onboarding-helper-text">
                        A project must be selected before you can create tasks or import from GitHub.
                      </p>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={onOpenSetupWizard}
                        data-testid="onboarding-open-setup-wizard"
                      >
                        Set Up Project
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="onboarding-first-task-form">
                        <label className="onboarding-first-task-form__label" htmlFor="onboarding-first-task-input">
                          Describe your first task
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
                          placeholder="Example: Build a login page with email and password"
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
                                <span>Creating task…</span>
                              </>
                            ) : (
                              "Create First Task"
                            )}
                          </button>
                        </div>
                      </div>

                      {taskCreationError && (
                        <div className="onboarding-task-error" role="alert" data-testid="onboarding-task-error">
                          <p className="field-error">{taskCreationError}</p>
                          <p className="onboarding-helper-text">Your text has been preserved — fix the issue and try again.</p>
                        </div>
                      )}
                    </>
                  )}

                  <ReadinessSummary items={readinessItems} />

                  {hasProjectSelected && (
                    <>
                      <OnboardingDisclosure summary="What happens when I create a task?">
                        <p className="onboarding-helper-text">
                          A task describes something you want done. Fusion's AI agents will read
                          your description and work on implementing it. You can track progress on
                          the board and review the results.
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
                            <strong>Create a New Task</strong>
                            <span>Describe what you need built and AI will work on it</span>
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
                            <strong>Import from GitHub</strong>
                            <span>Turn GitHub issues into tasks you can track here</span>
                            {!isGitHubReady && (
                              <small className="onboarding-cta-note">Requires GitHub connection</small>
                            )}
                          </div>
                        </button>
                      </div>

                      <p className="onboarding-skip-note">
                        You can create tasks anytime from the board, or use{" "}
                        <code>fn task create</code> in the terminal.
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
                Setup complete! Head to the board to create your first task, or
                explore the dashboard to see what's available.
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="model-onboarding-footer">
          {step === "ai-setup" && (
            <>
              <button
                className="btn btn-sm"
                onClick={handleDismiss}
                disabled={saving}
              >
                Skip for now
              </button>
              <button className="onboarding-skip-step-link" onClick={handleSkip}>
                Skip setup →
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                Next →
              </button>
            </>
          )}

          {step === "github" && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                ← Back
              </button>
              <button className="onboarding-skip-step-link" onClick={handleSkip}>
                Skip GitHub →
              </button>
              <button className="btn btn-primary" onClick={handleNext}>
                Next →
              </button>
            </>
          )}

          {step === "first-task" && !showTaskCreated && (
            <>
              <button className="btn btn-sm" onClick={handleBack}>
                ← Back
              </button>
              <button
                className="btn btn-primary"
                onClick={handleComplete}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <span>Saving…</span>
                  </>
                ) : (
                  "Finish Setup"
                )}
              </button>
            </>
          )}

          {step === "complete" && (
            <button className="btn btn-primary" onClick={handleFinish}>
              <CheckCircle size={16} />
              <span>Get Started</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

import type { ProjectInfo } from "../api";
import type { ColorTheme, Column, MergeResult, Task, ThemeMode } from "@fusion/core";
import type { UseProjectActionsResult } from "../hooks/useProjectActions";
import type { ModalManager } from "../hooks/useModalManager";
import type { UseTaskHandlersResult } from "../hooks/useTaskHandlers";
import type { Toast } from "../hooks/useToast";
import { ModalErrorBoundary } from "./ErrorBoundary";
import { TaskDetailModal } from "./TaskDetailModal";
import { SettingsModal } from "./SettingsModal";
import { GitHubImportModal } from "./GitHubImportModal";
import { PlanningModeModal } from "./PlanningModeModal";
import { SubtaskBreakdownModal } from "./SubtaskBreakdownModal";
import { TerminalModal } from "./TerminalModal";
import { ScriptsModal } from "./ScriptsModal";
import { FileBrowserModal } from "./FileBrowserModal";
import { UsageIndicator } from "./UsageIndicator";
import { ScheduledTasksModal } from "./ScheduledTasksModal";
import { NewTaskModal } from "./NewTaskModal";
import { ActivityLogModal } from "./ActivityLogModal";
import { GitManagerModal } from "./GitManagerModal";
import { WorkflowStepManager } from "./WorkflowStepManager";
import { AgentListModal } from "./AgentListModal";
import { SetupWizardModal } from "./SetupWizardModal";
import { ToastContainer } from "./ToastContainer";

interface AppModalsProps {
  projectId?: string;
  tasks: Task[];
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  addToast: (message: string, type?: ToastType) => void;
  toasts: Toast[];
  removeToast: (id: number) => void;
  modalManager: ModalManager;
  projectActions: Pick<UseProjectActionsResult, "handleSetupComplete" | "handleModelOnboardingComplete">;
  taskHandlers: Pick<UseTaskHandlersResult, "handleModalCreate" | "handlePlanningTaskCreated" | "handlePlanningTasksCreated" | "handleSubtaskTasksCreated" | "handleGitHubImport">;
  taskOperations: {
    moveTask: (taskId: string, column: Column, position?: number) => Promise<Task>;
    deleteTask: (taskId: string) => Promise<Task>;
    mergeTask: (taskId: string) => Promise<MergeResult>;
    retryTask: (taskId: string) => Promise<Task>;
    duplicateTask: (taskId: string) => Promise<Task>;
  };
  deepLink: {
    handleDetailClose: () => void;
  };
  settings: {
    prAuthAvailable: boolean;
    themeMode: ThemeMode;
    colorTheme: ColorTheme;
    setThemeMode: (mode: ThemeMode) => void;
    setColorTheme: (theme: ColorTheme) => void;
  };
  /** Optional override for the settings modal close handler. When provided, this is called instead of modalManager.closeSettings. */
  onSettingsClose?: () => void;
}

export function AppModals({
  projectId,
  tasks,
  projects,
  currentProject,
  addToast,
  toasts,
  removeToast,
  modalManager,
  projectActions,
  taskHandlers,
  taskOperations,
  deepLink,
  settings,
  onSettingsClose,
}: AppModalsProps) {
  // Use the override handler if provided, otherwise fall back to modalManager.closeSettings
  const handleSettingsClose = onSettingsClose ?? modalManager.closeSettings;

  // Handlers for onboarding CTAs
  const handleOpenNewTask = useCallback(() => {
    modalManager.openNewTask();
  }, [modalManager]);

  const handleOpenGitHubImport = useCallback(() => {
    modalManager.openGitHubImport();
  }, [modalManager]);

  return (
    <>
      {modalManager.detailTask && (
        <ModalErrorBoundary>
          <TaskDetailModal
            task={modalManager.detailTask}
            projectId={projectId}
            tasks={tasks}
            onClose={deepLink.handleDetailClose}
            onOpenDetail={modalManager.openDetailTask}
            onMoveTask={taskOperations.moveTask}
            onDeleteTask={taskOperations.deleteTask}
            onMergeTask={taskOperations.mergeTask}
            onRetryTask={taskOperations.retryTask}
            onDuplicateTask={taskOperations.duplicateTask}
            onTaskUpdated={modalManager.updateDetailTask}
            addToast={addToast}
            prAuthAvailable={settings.prAuthAvailable}
            initialTab={modalManager.detailTaskInitialTab}
          />
        </ModalErrorBoundary>
      )}

      {modalManager.settingsOpen && (
        <ModalErrorBoundary>
          <SettingsModal
            onClose={handleSettingsClose}
            addToast={addToast}
            initialSection={modalManager.settingsInitialSection}
            projectId={projectId}
            themeMode={settings.themeMode}
            colorTheme={settings.colorTheme}
            onThemeModeChange={settings.setThemeMode}
            onColorThemeChange={settings.setColorTheme}
          />
        </ModalErrorBoundary>
      )}

      <GitHubImportModal
        isOpen={modalManager.githubImportOpen}
        onClose={modalManager.closeGitHubImport}
        onImport={taskHandlers.handleGitHubImport}
        tasks={tasks}
        projectId={projectId}
      />

      <ModalErrorBoundary>
        <PlanningModeModal
          isOpen={modalManager.isPlanningOpen}
          onClose={modalManager.closePlanning}
          onTaskCreated={taskHandlers.handlePlanningTaskCreated}
          onTasksCreated={taskHandlers.handlePlanningTasksCreated}
          tasks={tasks}
          initialPlan={modalManager.planningInitialPlan ?? undefined}
          projectId={projectId}
          resumeSessionId={modalManager.planningResumeSessionId}
        />
      </ModalErrorBoundary>

      <ModalErrorBoundary>
        <SubtaskBreakdownModal
          isOpen={modalManager.isSubtaskOpen}
          onClose={modalManager.closeSubtask}
          initialDescription={modalManager.subtaskInitialDescription ?? ""}
          onTasksCreated={taskHandlers.handleSubtaskTasksCreated}
          projectId={projectId}
          resumeSessionId={modalManager.subtaskResumeSessionId}
        />
      </ModalErrorBoundary>

      <TerminalModal
        isOpen={modalManager.terminalOpen}
        onClose={modalManager.closeTerminal}
        initialCommand={modalManager.terminalInitialCommand}
        projectId={projectId}
      />

      <ScriptsModal
        isOpen={modalManager.scriptsOpen}
        onClose={modalManager.closeScripts}
        addToast={addToast}
        onRunScript={modalManager.runScript}
        projectId={projectId}
      />

      {modalManager.filesOpen && (
        <FileBrowserModal
          initialWorkspace={modalManager.fileBrowserWorkspace}
          isOpen={true}
          onClose={modalManager.closeFiles}
          onWorkspaceChange={modalManager.setFileWorkspace}
          projectId={projectId}
        />
      )}

      <UsageIndicator
        isOpen={modalManager.usageOpen}
        onClose={modalManager.closeUsage}
        projectId={projectId}
      />

      {modalManager.schedulesOpen && (
        <ScheduledTasksModal
          onClose={modalManager.closeSchedules}
          addToast={addToast}
        />
      )}

      <ModalErrorBoundary>
        <NewTaskModal
          isOpen={modalManager.newTaskModalOpen}
          onClose={modalManager.closeNewTask}
          tasks={tasks}
          onCreateTask={taskHandlers.handleModalCreate}
          addToast={addToast}
          projectId={projectId}
          onPlanningMode={modalManager.openPlanningWithInitialPlan}
          onSubtaskBreakdown={modalManager.openSubtaskBreakdown}
        />
      </ModalErrorBoundary>

      <ActivityLogModal
        isOpen={modalManager.activityLogOpen}
        onClose={modalManager.closeActivityLog}
        tasks={tasks}
        projectId={projectId}
        projects={projects}
        currentProject={currentProject}
        onOpenTaskDetail={(taskId) => {
          const task = tasks.find((candidate) => candidate.id === taskId);
          if (task) {
            modalManager.openDetailTask(task);
          }
        }}
      />

      <ModalErrorBoundary>
        <GitManagerModal
          isOpen={modalManager.gitManagerOpen}
          onClose={modalManager.closeGitManager}
          tasks={tasks}
          addToast={addToast}
          projectId={projectId}
        />
      </ModalErrorBoundary>

      <ModalErrorBoundary>
        <WorkflowStepManager
          isOpen={modalManager.workflowStepsOpen}
          onClose={modalManager.closeWorkflowSteps}
          addToast={addToast}
          projectId={projectId}
        />
      </ModalErrorBoundary>

      <AgentListModal
        isOpen={modalManager.agentsOpen}
        onClose={modalManager.closeAgents}
        addToast={addToast}
        projectId={projectId}
      />

      {modalManager.setupWizardOpen && (
        <SetupWizardModal
          onProjectRegistered={projectActions.handleSetupComplete}
          onClose={modalManager.closeSetupWizard}
        />
      )}

      {modalManager.modelOnboardingOpen && (
        <ModelOnboardingModal
          onComplete={projectActions.handleModelOnboardingComplete}
          addToast={addToast}
          onOpenNewTask={handleOpenNewTask}
          onOpenGitHubImport={handleOpenGitHubImport}
        />
      )}

      <ToastContainer toasts={toasts} onRemove={removeToast} />
    </>
  );
}

export interface UseAuthOnboardingOptions {
  projectId?: string;
  openModelOnboarding: () => void;
  openSettings: (section?: SectionId) => void;
}

/**
 * Runs auth/onboarding checks and opens the appropriate setup modal.
 *
 * This hook implements a one-shot guard: the auto-trigger logic runs at most
 * once per hook instance (regardless of effect re-runs due to dependency changes).
 * This prevents repeat auto-opens on incidental rerenders or project context churn.
 *
 * Trigger behavior:
 * - First-run (onboarding incomplete): opens model onboarding wizard
 * - Completed onboarding + unauthenticated providers: opens Settings → Authentication
 * - Already configured: no auto-open
 */
export function useAuthOnboarding({
  projectId,
  openModelOnboarding,
  openSettings,
}: UseAuthOnboardingOptions): void {
  // One-shot guard: prevents the auto-trigger logic from running more than once
  // per hook instance, even if the effect re-runs due to dependency changes.
  const hasTriggeredRef = useRef(false);

  useEffect(() => {
    // Skip if we've already triggered (one-shot guard)
    if (hasTriggeredRef.current) return;
    // Mark as triggered immediately to prevent any race condition on re-runs
    hasTriggeredRef.current = true;

    let shouldOpenOnboarding = false;
    let shouldOpenSettings = false;

    fetchAuthStatus()
      .then(({ providers }) => {
        const hasAuthenticatedProvider = providers.some((provider) => provider.authenticated);
        const needsSetup = providers.length > 0 && !hasAuthenticatedProvider;

        if (needsSetup || (providers.length > 0 && hasAuthenticatedProvider)) {
          return fetchGlobalSettings()
            .then((globalSettings) => {
              const hasDefaultModel = !!(
                globalSettings.defaultProvider && globalSettings.defaultModelId
              );
              // Explicit first-run detection: onboarding is incomplete when
              // modelOnboardingComplete is false or undefined
              const onboardingIncomplete =
                globalSettings.modelOnboardingComplete === false ||
                globalSettings.modelOnboardingComplete === undefined;
              const setupIncomplete = !hasAuthenticatedProvider || !hasDefaultModel;

              if (onboardingIncomplete && setupIncomplete) {
                shouldOpenOnboarding = true;
              } else if (!hasAuthenticatedProvider) {
                // Completed onboarding but no authenticated provider → fallback
                // to Settings Authentication section
                shouldOpenSettings = true;
              }
            });
        }
      })
      .then(() => {
        // Execute after the promise chain resolves
        if (shouldOpenOnboarding) {
          openModelOnboarding();
        } else if (shouldOpenSettings) {
          openSettings("authentication");
        }
      })
      .catch(() => {
        // Fail silently - non-blocking behavior preserves dashboard usability.
        // Onboarding can be manually triggered later via Settings if needed.
      });
  }, [projectId, openModelOnboarding, openSettings]);
}
