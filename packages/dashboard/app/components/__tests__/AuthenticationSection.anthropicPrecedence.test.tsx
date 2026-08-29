/*
FNXC:ProviderAuth 2026-07-24-17:05:
An operator can hold two live Anthropic credentials at once — a raw API key and a Claude
subscription OAuth login — and runtime auth silently preferred the key. A stale or revoked
saved key therefore produced `401 invalid x-api-key` on every lane that calls Anthropic
directly, while BOTH cards still read "✓ Active" and nothing named the credential in use.

Invariant asserted here: when (and only when) both Anthropic credentials are connected,
Settings names which one is in use, and the operator can change it. The control writes the
global `anthropicAuthPreference` through the shell-owned form, never directly.
*/

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { AuthenticationSection, type AuthenticationSectionData } from "../settings/sections/AuthenticationSection";
import type { AuthProvider } from "../../api";
import type { Settings } from "@fusion/core";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`mock-icon-${provider}`}>{provider}</span>,
}));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("../LoginInstructions", () => ({ LoginInstructions: () => null }));
vi.mock("../LoadingSpinner", () => ({ LoadingSpinner: () => null }));
vi.mock("../OAuthManualCodeForm", () => ({ OAuthManualCodeForm: () => null }));
vi.mock("../CustomProvidersSection", () => ({ CustomProvidersSection: () => null }));

const apiKeyCard: AuthProvider = {
  id: "anthropic-api-key",
  name: "Anthropic API Key",
  type: "api_key",
  authenticated: true,
} as AuthProvider;

const subscriptionCard: AuthProvider = {
  id: "anthropic-subscription",
  name: "Claude Subscription",
  type: "oauth",
  authenticated: true,
} as AuthProvider;

function renderSection(providers: AuthProvider[], initialForm: Partial<Settings> = {}) {
  const observed: { form: Partial<Settings> } = { form: initialForm };

  function Harness() {
    const [form, setForm] = useState<Partial<Settings>>(initialForm);
    observed.form = form;
    const auth = {
      addToast: vi.fn(),
      authProviders: providers,
      authLoading: false,
      authActionInProgress: null,
      apiKeyInputs: {},
      setApiKeyInputs: vi.fn(),
      apiKeyErrors: {},
      opencodeApiKeyRefreshStatus: {},
      deviceCodes: {},
      loginInstructions: {},
      manualCodeConfigs: {},
      manualCodeInputs: {},
      setManualCodeInputs: vi.fn(),
      manualCodeSubmitInProgress: null,
      loadAuthStatus: vi.fn(),
      handleLogin: vi.fn(),
      handleLogout: vi.fn(),
      handleCancelLogin: vi.fn(),
      handleSaveApiKey: vi.fn(),
      handleClearApiKey: vi.fn(),
      handleSubmitManualCode: vi.fn(),
    } as unknown as AuthenticationSectionData;
    return (
      <AuthenticationSection
        auth={auth}
        form={form as never}
        setForm={setForm as never}
      />
    );
  }

  render(<Harness />);
  return observed;
}

describe("Anthropic credential precedence in Settings → Authentication", () => {
  it("names the credential in use when both Anthropic credentials are connected", () => {
    renderSection([apiKeyCard, subscriptionCard]);

    // Default preference is the API key, matching runtime resolution.
    expect(screen.getByTestId("auth-precedence-active-anthropic-api-key")).toBeTruthy();
    expect(screen.getByTestId("auth-precedence-overridden-anthropic-subscription")).toBeTruthy();
  });

  it("moves the in-use marker when the operator prefers the subscription", () => {
    renderSection([apiKeyCard, subscriptionCard], { anthropicAuthPreference: "subscription" });

    expect(screen.getByTestId("auth-precedence-active-anthropic-subscription")).toBeTruthy();
    expect(screen.getByTestId("auth-precedence-overridden-anthropic-api-key")).toBeTruthy();
  });

  it("writes the operator's choice into the shell-owned settings form", () => {
    const observed = renderSection([apiKeyCard, subscriptionCard]);

    fireEvent.change(screen.getByLabelText(/Anthropic credential to use/i), {
      target: { value: "subscription" },
    });

    expect(observed.form.anthropicAuthPreference).toBe("subscription");
  });

  it("hides the control when only one Anthropic credential is connected", () => {
    // Nothing to disambiguate — resolution reaches the single credential either way.
    renderSection([apiKeyCard, { ...subscriptionCard, authenticated: false }]);

    expect(screen.queryByLabelText(/Anthropic credential to use/i)).toBeNull();
    expect(screen.queryByTestId("auth-precedence-active-anthropic-api-key")).toBeNull();
  });

  it("hides the control when the shell does not supply the settings form", () => {
    const auth = {
      addToast: vi.fn(),
      authProviders: [apiKeyCard, subscriptionCard],
      authLoading: false,
      authActionInProgress: null,
      apiKeyInputs: {},
      setApiKeyInputs: vi.fn(),
      apiKeyErrors: {},
      opencodeApiKeyRefreshStatus: {},
      deviceCodes: {},
      loginInstructions: {},
      manualCodeConfigs: {},
      manualCodeInputs: {},
      setManualCodeInputs: vi.fn(),
      manualCodeSubmitInProgress: null,
      loadAuthStatus: vi.fn(),
      handleLogin: vi.fn(),
      handleLogout: vi.fn(),
      handleCancelLogin: vi.fn(),
      handleSaveApiKey: vi.fn(),
      handleClearApiKey: vi.fn(),
      handleSubmitManualCode: vi.fn(),
    } as unknown as AuthenticationSectionData;

    render(<AuthenticationSection auth={auth} />);

    expect(screen.queryByLabelText(/Anthropic credential to use/i)).toBeNull();
  });
});
