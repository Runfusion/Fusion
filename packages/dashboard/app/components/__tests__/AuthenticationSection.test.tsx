import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AuthenticationSection, type AuthenticationSectionData } from "../settings/sections/AuthenticationSection";
import type { AuthProvider } from "../../api";
import { loadComponentCss } from "../../test/cssFixture";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`mock-icon-${provider}`}>{provider}</span>,
}));

vi.mock("../PluginSlot", () => ({
  PluginSlot: ({ slotId }: { slotId: string }) => <div data-testid={`plugin-slot-${slotId}`} />,
}));

vi.mock("../LoginInstructions", () => ({
  LoginInstructions: ({ instructions }: { instructions: string }) => <div>{instructions}</div>,
}));

vi.mock("../LoadingSpinner", () => ({
  LoadingSpinner: ({ label }: { label: string }) => <div>{label}</div>,
}));

vi.mock("../OAuthManualCodeForm", () => ({
  OAuthManualCodeForm: ({ prompt }: { prompt: string }) => <div>{prompt}</div>,
}));

vi.mock("../CustomProvidersSection", () => ({
  CustomProvidersSection: () => <div data-testid="custom-providers-section" />,
}));

vi.mock("../ClaudeCliProviderCard", () => ({
  ClaudeCliProviderCard: ({ authenticated }: { authenticated: boolean }) => (
    <div data-testid="claude-cli-provider-card" data-authenticated={authenticated ? "true" : "false"} />
  ),
}));
vi.mock("../CursorCliProviderCard", () => ({
  CursorCliProviderCard: ({ authenticated }: { authenticated: boolean }) => (
    <div data-testid="cursor-cli-provider-card" data-authenticated={authenticated ? "true" : "false"} />
  ),
}));
vi.mock("../LlamaCppProviderCard", () => ({
  LlamaCppProviderCard: ({ authenticated }: { authenticated: boolean }) => (
    <div data-testid="llama-cpp-provider-card" data-authenticated={authenticated ? "true" : "false"} />
  ),
}));

function authCardOrder(groupLabel: "Authenticated" | "Available") {
  const group = screen.getByText(groupLabel).closest(".auth-provider-group") as HTMLElement;
  return Array.from(group.children)
    .map((child) => {
      const element = child as HTMLElement;
      if (element.dataset.testid === "claude-cli-provider-card") return "claude-cli";
      if (element.dataset.testid === "cursor-cli-provider-card") return "cursor-cli";
      if (element.dataset.testid === "llama-cpp-provider-card") return "llama-cpp";
      const icon = element.querySelector<HTMLElement>("[data-testid^='auth-provider-icon-']");
      return icon?.dataset.testid?.replace("auth-provider-icon-", "") ?? null;
    })
    .filter((providerId): providerId is string => Boolean(providerId));
}

function renderAuthSection(providers: AuthProvider[], overrides: Partial<AuthenticationSectionData> = {}) {
  const handleLogin = vi.fn();
  const handleLogout = vi.fn();
  const handleSaveApiKey = vi.fn();
  const handleClearApiKey = vi.fn();

  function Harness() {
    const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
    const [manualCodeInputs, setManualCodeInputs] = useState<Record<string, string>>({});
    const auth: AuthenticationSectionData = {
      addToast: vi.fn(),
      authProviders: providers,
      authLoading: false,
      authActionInProgress: null,
      apiKeyInputs,
      setApiKeyInputs,
      apiKeyErrors: {},
      opencodeApiKeyRefreshStatus: {},
      deviceCodes: {},
      loginInstructions: {},
      manualCodeConfigs: {},
      manualCodeInputs,
      setManualCodeInputs,
      manualCodeSubmitInProgress: null,
      loadAuthStatus: vi.fn(),
      handleLogin,
      handleLogout,
      handleCancelLogin: vi.fn(),
      handleSaveApiKey,
      handleClearApiKey,
      handleSubmitManualCode: vi.fn(),
      ...overrides,
    };
    return <AuthenticationSection auth={auth} />;
  }

  render(<Harness />);
  return { handleLogin, handleLogout, handleSaveApiKey, handleClearApiKey };
}

describe("AuthenticationSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sorts visible Anthropic standard providers together near the top", () => {
    renderAuthSection([
      { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
      { id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" },
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
      { id: "openrouter", name: "OpenRouter", authenticated: false, type: "api_key" },
    ]);

    expect(authCardOrder("Available")).toEqual([
      "anthropic-subscription",
      "anthropic-api-key",
      "github-copilot",
      "openai",
      "openrouter",
    ]);
  });

  it("prioritizes Anthropic cards within each auth state without crossing group boundaries", () => {
    renderAuthSection([
      { id: "openai", name: "OpenAI", authenticated: true, type: "api_key" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
      { id: "github-copilot", name: "GitHub Copilot", authenticated: false, type: "oauth" },
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: true, type: "oauth" },
      { id: "openrouter", name: "OpenRouter", authenticated: true, type: "api_key" },
    ]);

    expect(authCardOrder("Authenticated")).toEqual(["anthropic-subscription", "openai", "openrouter"]);
    expect(authCardOrder("Available")).toEqual(["anthropic-api-key", "github-copilot"]);
  });

  it("hides legacy Anthropic when separated cards are present without breaking priority order", () => {
    renderAuthSection([
      { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
      { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
    ]);

    expect(screen.queryByTestId("auth-provider-icon-anthropic")).not.toBeInTheDocument();
    expect(authCardOrder("Available")).toEqual(["anthropic-subscription", "anthropic-api-key", "openai"]);
  });

  it("keeps Claude CLI first among CLI-backed authentication cards", () => {
    renderAuthSection([
      { id: "llama-cpp", name: "Llama.cpp", authenticated: false, type: "cli" },
      { id: "cursor-cli", name: "Cursor CLI", authenticated: false, type: "cli" },
      { id: "claude-cli", name: "Anthropic — via Claude CLI", authenticated: false, type: "cli" },
    ]);

    expect(authCardOrder("Available")).toEqual(["claude-cli", "cursor-cli", "llama-cpp"]);
  });

  it("groups Anthropic CLI, subscription, and API-key cards before other CLI providers", () => {
    renderAuthSection([
      { id: "cursor-cli", name: "Cursor CLI", authenticated: false, type: "cli" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
      { id: "llama-cpp", name: "Llama.cpp", authenticated: false, type: "cli" },
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
      { id: "claude-cli", name: "Anthropic — via Claude CLI", authenticated: false, type: "cli" },
    ]);

    expect(authCardOrder("Available")).toEqual([
      "claude-cli",
      "anthropic-subscription",
      "anthropic-api-key",
      "cursor-cli",
      "llama-cpp",
    ]);
  });

  it("renders separate Anthropic subscription OAuth and API-key cards", () => {
    const { handleLogin, handleSaveApiKey } = renderAuthSection([
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: false, type: "oauth" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: false, type: "api_key" },
      { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;
    const apiKeyCard = screen.getByTestId("auth-provider-icon-anthropic-api-key").closest(".auth-provider-card") as HTMLElement;
    expect(screen.queryByTestId("auth-provider-icon-anthropic")).not.toBeInTheDocument();

    fireEvent.click(within(subscriptionCard).getByRole("button", { name: "Login" }));
    expect(within(subscriptionCard).queryByPlaceholderText("Enter API key")).not.toBeInTheDocument();
    expect(handleLogin).toHaveBeenCalledWith("anthropic-subscription");

    fireEvent.change(within(apiKeyCard).getByPlaceholderText("Enter API key"), { target: { value: "sk-ant-api03-new" } });
    fireEvent.click(within(apiKeyCard).getByRole("button", { name: "Save" }));
    expect(within(apiKeyCard).queryByRole("button", { name: "Login" })).not.toBeInTheDocument();
    expect(handleSaveApiKey).toHaveBeenCalledWith("anthropic-api-key");
  });

  it("renders an OAuth refresh failure durably on the affected provider card", () => {
    renderAuthSection([
      {
        id: "anthropic-subscription",
        name: "Anthropic Subscription",
        authenticated: false,
        type: "oauth",
        expired: true,
        loginError: "This OAuth session expired and could not be refreshed. Re-login to restore model access.",
      },
      { id: "openai-codex", name: "OpenAI Codex", authenticated: true, type: "oauth" },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;
    const alert = within(subscriptionCard).getByRole("alert");
    const header = subscriptionCard.querySelector(".auth-provider-header");
    expect(alert).toHaveTextContent("expired and could not be refreshed");
    expect(alert).toHaveClass("auth-provider-login-error");
    expect(alert.tagName).toBe("P");
    expect(header).not.toContainElement(alert);
    expect(header?.nextElementSibling).toBe(alert);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("keeps a connected OAuth loginError as a wrapping card banner under the header", () => {
    renderAuthSection([
      {
        id: "anthropic-subscription",
        name: "Anthropic Subscription",
        authenticated: true,
        type: "oauth",
        expired: true,
        loginError: "This OAuth session expired and could not be refreshed. Re-login to restore model access.",
      },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;
    const alert = within(subscriptionCard).getByRole("alert");
    const header = subscriptionCard.querySelector(".auth-provider-header");
    expect(alert).toHaveClass("auth-provider-login-error");
    expect(header).not.toContainElement(alert);
    expect(header?.nextElementSibling).toBe(alert);
  });

  it("renders the built-in catalog action without removing the custom provider section", () => {
    renderAuthSection([{ id: "openai", name: "OpenAI", authenticated: false, type: "api_key" }]);

    expect(screen.getByRole("button", { name: "Refresh Models" })).toBeInTheDocument();
    expect(screen.getByTestId("custom-providers-section")).toBeInTheDocument();
  });

  it("wraps the provider loginError banner inside the card on a narrow Settings width", () => {
    const css = loadComponentCss("settings/sections/AuthenticationSection.css");
    expect(css).toMatch(/\.auth-provider-login-error\s*\{[^}]*display:\s*block/);
    expect(css).toMatch(/\.auth-provider-login-error\s*\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.auth-provider-login-error\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.auth-provider-login-error\s*\{[^}]*word-break:\s*break-word/);
    expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*\.auth-provider-login-error\s*\{[\s\S]*margin-inline:\s*var\(--space-sm\)/);
    expect(css).toMatch(/\.auth-model-refresh\s*\{[\s\S]*display:\s*flex/);
    expect(css).toMatch(/\.auth-model-refresh-feedback--error\s*\{[^}]*color:\s*var\(--color-error\)/);
    expect(css).toMatch(/@media[^{]*\(max-width:\s*768px\)[^{]*\{[\s\S]*\.auth-model-refresh\s*>\s*\.btn\s*\{[\s\S]*flex:\s*1 1 100%/);
  });

  it("keeps Anthropic OAuth logout separate from a stored API key clear action", () => {
    const { handleLogout, handleClearApiKey } = renderAuthSection([
      { id: "anthropic-subscription", name: "Anthropic Subscription", authenticated: true, type: "oauth" },
      { id: "anthropic-api-key", name: "Anthropic API Key", authenticated: true, type: "api_key", keyHint: "sk-•••••dkey" },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;
    const apiKeyCard = screen.getByTestId("auth-provider-icon-anthropic-api-key").closest(".auth-provider-card") as HTMLElement;

    fireEvent.click(within(subscriptionCard).getByRole("button", { name: "Logout" }));
    expect(within(subscriptionCard).queryByRole("button", { name: "Clear" })).not.toBeInTheDocument();
    expect(handleLogout).toHaveBeenCalledWith("anthropic-subscription");

    expect(within(apiKeyCard).getByText("Key: sk-•••••dkey")).toBeInTheDocument();
    fireEvent.click(within(apiKeyCard).getByRole("button", { name: "Clear" }));
    expect(within(apiKeyCard).queryByRole("button", { name: "Logout" })).not.toBeInTheDocument();
    expect(handleClearApiKey).toHaveBeenCalledWith("anthropic-api-key");
  });

  it("ignores legacy supportsApiKey flags on OAuth cards", () => {
    const { handleLogin, handleSaveApiKey } = renderAuthSection([
      {
        id: "anthropic-subscription",
        name: "Anthropic Subscription",
        authenticated: false,
        type: "oauth",
        supportsApiKey: true,
      } as AuthProvider & { supportsApiKey: true },
    ]);

    const subscriptionCard = screen.getByTestId("auth-provider-icon-anthropic-subscription").closest(".auth-provider-card") as HTMLElement;

    expect(within(subscriptionCard).getByRole("button", { name: "Login" })).toBeInTheDocument();
    expect(within(subscriptionCard).queryByPlaceholderText("Enter API key")).not.toBeInTheDocument();

    fireEvent.click(within(subscriptionCard).getByRole("button", { name: "Login" }));
    expect(handleLogin).toHaveBeenCalledWith("anthropic-subscription");
    expect(handleSaveApiKey).not.toHaveBeenCalled();
  });

  /*
  FNXC:ProviderAuth 2026-08-18-06:10:
  Settings shares onboarding's persistent login dialog. While that dialog owns a flow, the provider
  row must NOT also render the instructions and paste field — two inputs for the same code, one of
  them behind the dialog. Suppression is keyed by `stateKey` (provider + credential instance), so a
  second named account for the same provider keeps its own inline field while the first is in the
  dialog; that is the case a bare provider-id check would break.
  */
  describe("persistent login dialog handoff", () => {
    const dialogFlowOverrides = {
      loginInstructions: { "anthropic-subscription": "Complete login in your browser." },
      manualCodeConfigs: { "anthropic-subscription": { prompt: "Paste the final redirect URL" } },
      authActionInProgress: { "anthropic-subscription": true },
    } as unknown as Partial<AuthenticationSectionData>;

    const subscriptionProvider = [{
      id: "anthropic-subscription",
      name: "Anthropic Subscription",
      authenticated: false,
      type: "oauth",
    } as AuthProvider];

    it("renders its own paste field when no dialog owns the flow", () => {
      renderAuthSection(subscriptionProvider, { ...dialogFlowOverrides, activeLoginDialogKey: null });

      expect(screen.getByText("Paste the final redirect URL")).toBeInTheDocument();
      expect(screen.getByText("Complete login in your browser.")).toBeInTheDocument();
    });

    it("yields both to the dialog that owns the flow", () => {
      renderAuthSection(subscriptionProvider, {
        ...dialogFlowOverrides,
        activeLoginDialogKey: "anthropic-subscription",
      });

      expect(screen.queryByText("Paste the final redirect URL")).not.toBeInTheDocument();
      expect(screen.queryByText("Complete login in your browser.")).not.toBeInTheDocument();
    });

    it("keeps a sibling account's inline field when another instance is in the dialog", () => {
      renderAuthSection(subscriptionProvider, {
        ...dialogFlowOverrides,
        activeLoginDialogKey: "anthropic-subscription[work]",
      });

      expect(screen.getByText("Paste the final redirect URL")).toBeInTheDocument();
    });
  });
});
