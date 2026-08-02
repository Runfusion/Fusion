import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { AuthenticationSection, type AuthenticationSectionData } from "../settings/sections/AuthenticationSection";
import type { AuthProvider } from "../../api";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  newProviderInstanceId: () => "acct-new",
  removeProviderInstance: vi.fn().mockResolvedValue({ success: true }),
  renameProviderInstance: vi.fn().mockResolvedValue({ success: true }),
  setProviderDefaultInstance: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock("../ProviderIcon", () => ({ ProviderIcon: () => <span /> }));
vi.mock("../PluginSlot", () => ({ PluginSlot: () => null }));
vi.mock("../LoginInstructions", () => ({ LoginInstructions: () => null }));
vi.mock("../LoadingSpinner", () => ({ LoadingSpinner: () => null }));
vi.mock("../OAuthManualCodeForm", () => ({ OAuthManualCodeForm: () => null }));
vi.mock("../CustomProvidersSection", () => ({ CustomProvidersSection: () => null }));

function renderSection(providers: AuthProvider[]) {
  const handlers = {
    handleLogin: vi.fn(), handleLogout: vi.fn(), handleCancelLogin: vi.fn(),
    handleSaveApiKey: vi.fn(), handleClearApiKey: vi.fn(), handleSubmitManualCode: vi.fn(),
  };
  function Harness() {
    const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
    const [manualCodeInputs, setManualCodeInputs] = useState<Record<string, string>>({});
    const auth: AuthenticationSectionData = {
      addToast: vi.fn(), authProviders: providers, authLoading: false, authActionInProgress: null,
      apiKeyInputs, setApiKeyInputs, apiKeyErrors: {}, opencodeApiKeyRefreshStatus: {}, deviceCodes: {},
      loginInstructions: {}, manualCodeConfigs: {}, manualCodeInputs, setManualCodeInputs,
      manualCodeSubmitInProgress: null, loadAuthStatus: vi.fn(), ...handlers,
    };
    return <AuthenticationSection auth={auth} />;
  }
  render(<Harness />);
  return handlers;
}

describe("AuthenticationSection credential instances", () => {
  it("keeps a single account card free of instance chrome", () => {
    renderSection([{ id: "brave", name: "Brave", authenticated: true, type: "api_key", instances: [{ instanceId: "default", authenticated: true, isDefault: true, type: "api_key" }] }]);
    expect(screen.queryByTestId("auth-instances-brave")).not.toBeInTheDocument();
    expect(screen.getByText("Add another account")).toBeInTheDocument();
  });

  it("scopes every multi-instance API-key save to its account and pending row", () => {
    const handlers = renderSection([{ id: "brave", name: "Brave", authenticated: true, type: "api_key", instances: [
      { instanceId: "default", label: "Primary", authenticated: true, isDefault: true, type: "api_key", keyHint: "abc••••defg" },
      { instanceId: "acct-two", label: "Second", authenticated: false, isDefault: false, type: "api_key" },
    ] }]);
    const list = screen.getByTestId("auth-instances-brave");
    const second = within(list).getByText("Second").closest(".auth-instance-row") as HTMLElement;
    fireEvent.change(within(second).getByPlaceholderText("Enter API key"), { target: { value: "second-key" } });
    fireEvent.click(within(second).getByText("Save"));
    expect(handlers.handleSaveApiKey).toHaveBeenLastCalledWith("brave", "acct-two", undefined);

    fireEvent.click(screen.getByText("Add another account"));
    const pending = screen.getByTestId("auth-pending-instance-brave");
    fireEvent.change(within(pending).getByPlaceholderText("Enter API key"), { target: { value: "pending-key" } });
    fireEvent.click(within(pending).getByText("Save"));
    expect(handlers.handleSaveApiKey).toHaveBeenLastCalledWith("brave", "acct-new", undefined);
  });

  it("binds OAuth instance actions to the selected instance", () => {
    const handlers = renderSection([{ id: "github-copilot", name: "GitHub", authenticated: true, type: "oauth", instances: [
      { instanceId: "default", authenticated: true, isDefault: true, type: "oauth" },
      { instanceId: "acct-two", authenticated: true, isDefault: false, type: "oauth" },
    ] }]);
    const row = within(screen.getByTestId("auth-instances-github-copilot")).getByText("acct-two").closest(".auth-instance-row") as HTMLElement;
    fireEvent.click(within(row).getByText("Logout"));
    expect(handlers.handleLogout).toHaveBeenCalledWith("github-copilot", "acct-two");
  });
});
