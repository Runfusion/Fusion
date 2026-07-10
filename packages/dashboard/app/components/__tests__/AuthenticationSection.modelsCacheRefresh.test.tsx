import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { AuthenticationSection, type AuthenticationSectionData } from "../settings/sections/AuthenticationSection";
import type { AuthProvider } from "../../api";

/*
FNXC:ModelCatalog 2026-07-08-00:00:
FN-7710 regression coverage: every CLI provider card's `onToggled` callback must refresh the
shared model catalog (`refreshModelsCache()`) in addition to the Settings Authentication panel
(`loadAuthStatus()`), so newly-enabled/disabled grok-cli/cursor-cli (and, for parity,
claude-cli/llama-cpp) rows propagate to every live picker without a Settings navigation.
This asserts the AuthenticationSection wiring only — the underlying refreshModelsCache()
single-flight/notify semantics are covered in useModelsCache.test.ts.
*/

const loadAuthStatus = vi.fn();
const refreshModelsCache = vi.fn().mockResolvedValue(undefined);

vi.mock("../../hooks/useModelsCache", () => ({
  refreshModelsCache: (...args: unknown[]) => refreshModelsCache(...args),
}));

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: ({ provider }: { provider: string }) => <span data-testid={`mock-icon-${provider}`}>{provider}</span>,
}));
vi.mock("../PluginSlot", () => ({
  PluginSlot: () => null,
}));
vi.mock("../CustomProvidersSection", () => ({
  CustomProvidersSection: () => null,
}));

function mockCliCard(testId: string) {
  return ({ onToggled }: { onToggled?: (nextEnabled: boolean) => void }) => (
    <button data-testid={testId} onClick={() => onToggled?.(true)}>
      toggle {testId}
    </button>
  );
}

vi.mock("../ClaudeCliProviderCard", () => ({
  ClaudeCliProviderCard: mockCliCard("claude-cli-toggle"),
}));
vi.mock("../CursorCliProviderCard", () => ({
  CursorCliProviderCard: mockCliCard("cursor-cli-toggle"),
}));
vi.mock("../GrokCliProviderCard", () => ({
  GrokCliProviderCard: mockCliCard("grok-cli-toggle"),
}));
vi.mock("../LlamaCppProviderCard", () => ({
  LlamaCppProviderCard: mockCliCard("llama-cpp-toggle"),
}));

function renderAuthSection(providers: AuthProvider[]) {
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
      loadAuthStatus,
      handleLogin: vi.fn(),
      handleLogout: vi.fn(),
      handleCancelLogin: vi.fn(),
      handleSaveApiKey: vi.fn(),
      handleClearApiKey: vi.fn(),
      handleSubmitManualCode: vi.fn(),
    };
    return <AuthenticationSection auth={auth} />;
  }
  render(<Harness />);
}

describe("AuthenticationSection CLI toggle -> shared models cache refresh (FN-7710)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the shared models cache when grok-cli is toggled", async () => {
    renderAuthSection([{ id: "grok-cli", name: "Grok — via Grok CLI", authenticated: false, type: "cli" }]);

    screen.getByTestId("grok-cli-toggle").click();

    expect(loadAuthStatus).toHaveBeenCalledTimes(1);
    expect(refreshModelsCache).toHaveBeenCalledTimes(1);
  });

  it("refreshes the shared models cache when cursor-cli is toggled", async () => {
    renderAuthSection([{ id: "cursor-cli", name: "Cursor — via Cursor CLI", authenticated: false, type: "cli" }]);

    screen.getByTestId("cursor-cli-toggle").click();

    expect(loadAuthStatus).toHaveBeenCalledTimes(1);
    expect(refreshModelsCache).toHaveBeenCalledTimes(1);
  });

  it("refreshes the shared models cache when claude-cli is toggled (parity)", async () => {
    renderAuthSection([{ id: "claude-cli", name: "Anthropic — via Claude CLI", authenticated: false, type: "cli" }]);

    screen.getByTestId("claude-cli-toggle").click();

    expect(refreshModelsCache).toHaveBeenCalledTimes(1);
  });

  it("refreshes the shared models cache when llama-cpp is toggled (parity)", async () => {
    renderAuthSection([{ id: "llama-cpp", name: "Llama.cpp", authenticated: false, type: "cli" }]);

    screen.getByTestId("llama-cpp-toggle").click();

    expect(refreshModelsCache).toHaveBeenCalledTimes(1);
  });

  it("refreshes on the disable transition too (onToggled fires for both directions)", async () => {
    renderAuthSection([{ id: "grok-cli", name: "Grok — via Grok CLI", authenticated: true, type: "cli" }]);

    // The mocked card's onToggled callback fires regardless of enable/disable direction —
    // the real CursorCliProviderCard/GrokCliProviderCard call onToggled?.(result.enabled) on
    // every successful toggle result, so a single shared handler covers both transitions.
    screen.getByTestId("grok-cli-toggle").click();
    screen.getByTestId("grok-cli-toggle").click();

    expect(refreshModelsCache).toHaveBeenCalledTimes(2);
  });
});
