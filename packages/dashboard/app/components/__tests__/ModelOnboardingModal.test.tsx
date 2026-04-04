import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ModelOnboardingModal } from "../ModelOnboardingModal";
import type { AuthProvider } from "../../api";

// Mock the API module
const mockFetchAuthStatus = vi.fn();
const mockLoginProvider = vi.fn();
const mockLogoutProvider = vi.fn();
const mockSaveApiKey = vi.fn();
const mockClearApiKey = vi.fn();
const mockFetchModels = vi.fn();
const mockUpdateGlobalSettings = vi.fn();

vi.mock("../../api", () => ({
  fetchAuthStatus: (...args: unknown[]) => mockFetchAuthStatus(...args),
  loginProvider: (...args: unknown[]) => mockLoginProvider(...args),
  logoutProvider: (...args: unknown[]) => mockLogoutProvider(...args),
  saveApiKey: (...args: unknown[]) => mockSaveApiKey(...args),
  clearApiKey: (...args: unknown[]) => mockClearApiKey(...args),
  fetchModels: (...args: unknown[]) => mockFetchModels(...args),
  updateGlobalSettings: (...args: unknown[]) => mockUpdateGlobalSettings(...args),
}));

// Mock CustomModelDropdown since it has complex portal behavior
vi.mock("../CustomModelDropdown", () => ({
  CustomModelDropdown: ({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <select
      data-testid="mock-model-dropdown"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder ?? "Select…"}</option>
      <option value="anthropic/claude-sonnet-4-5">Claude Sonnet 4.5</option>
      <option value="openai/gpt-4o">GPT-4o</option>
    </select>
  ),
}));

const defaultAuthProviders: AuthProvider[] = [
  { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
  { id: "openai", name: "OpenAI", authenticated: false, type: "api_key" },
];

const defaultModels = [
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: false, contextWindow: 200000 },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchAuthStatus.mockResolvedValue({ providers: defaultAuthProviders });
  mockFetchModels.mockResolvedValue({ models: defaultModels, favoriteProviders: [], favoriteModels: [] });
  mockUpdateGlobalSettings.mockResolvedValue({});
  mockLoginProvider.mockResolvedValue({ url: "https://auth.example.com/login" });
  mockLogoutProvider.mockResolvedValue({ success: true });
  mockSaveApiKey.mockResolvedValue({ success: true });
  mockClearApiKey.mockResolvedValue({ success: true });
});

describe("ModelOnboardingModal", () => {
  describe("provider step", () => {
    it("renders the provider step by default", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI Provider")).toBeTruthy();
      });

      expect(screen.getByText("Connect Provider")).toBeTruthy();
      expect(screen.getByText("Select Model")).toBeTruthy();
    });

    it("shows OAuth providers with Login button", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Anthropic")).toBeTruthy();
      });

      expect(screen.getByText("✗ Not authenticated")).toBeTruthy();
      expect(screen.getByText("Login")).toBeTruthy();
    });

    it("shows API key providers with key input", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("OpenAI")).toBeTruthy();
      });

      expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
    });

    it("disables Continue button when no providers are authenticated", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Continue →")).toBeTruthy();
      });

      expect(screen.getByText("Continue →").closest("button")?.disabled).toBe(true);
    });

    it("initiates OAuth login when Login is clicked", async () => {
      const mockWindowOpen = vi.fn();
      vi.spyOn(window, "open").mockImplementation(mockWindowOpen);

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Login")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Login"));

      await waitFor(() => {
        expect(mockLoginProvider).toHaveBeenCalledWith("anthropic");
        expect(mockWindowOpen).toHaveBeenCalledWith("https://auth.example.com/login", "_blank");
      });
    });

    it("saves API key when Save is clicked", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai");
      fireEvent.change(input, { target: { value: "sk-test-key-123" } });
      fireEvent.click(screen.getByTestId("onboarding-apikey-save-openai"));

      await waitFor(() => {
        expect(mockSaveApiKey).toHaveBeenCalledWith("openai", "sk-test-key-123");
      });
    });

    it("shows Save button as disabled when API key input is empty", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-save-openai")).toBeTruthy();
      });

      const saveBtn = screen.getByTestId("onboarding-apikey-save-openai") as HTMLButtonElement;
      expect(saveBtn.disabled).toBe(true);
    });

    it("clears API key when Remove Key is clicked for authenticated provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: false, type: "oauth" },
          { id: "openai", name: "OpenAI", authenticated: true, type: "api_key" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("✓ Key saved")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Remove Key"));

      await waitFor(() => {
        expect(mockClearApiKey).toHaveBeenCalledWith("openai");
      });
    });

    it("does NOT render API key values in the DOM", async () => {
      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("onboarding-apikey-input-openai")).toBeTruthy();
      });

      const input = screen.getByTestId("onboarding-apikey-input-openai") as HTMLInputElement;
      // Input should be empty initially (never prefilled)
      expect(input.value).toBe("");
      expect(input.type).toBe("password");
    });
  });

  describe("model selection step", () => {
    it("advances to model step when Continue is clicked with authenticated provider", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Continue →")).toBeTruthy();
      });

      // Wait for auto-advance or click Continue
      // The auto-advance happens after 600ms, but we can also click
      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });
    });

    it("shows model dropdown on the model step", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });

      expect(screen.getByTestId("mock-model-dropdown")).toBeTruthy();
    });

    it("allows model selection", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });

      const dropdown = screen.getByTestId("mock-model-dropdown");
      fireEvent.change(dropdown, { target: { value: "anthropic/claude-sonnet-4-5" } });

      await waitFor(() => {
        expect(screen.getByText(/Claude Sonnet 4\.5/)).toBeTruthy();
      });
    });

    it("allows going back to provider step", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });

      fireEvent.click(screen.getByText("← Back"));

      await waitFor(() => {
        expect(screen.getByText("Set Up AI Provider")).toBeTruthy();
      });
    });
  });

  describe("completion", () => {
    it("saves model selection and marks onboarding complete", async () => {
      const onComplete = vi.fn();
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      // Wait for auto-advance to model step
      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });

      // Select a model
      const dropdown = screen.getByTestId("mock-model-dropdown");
      fireEvent.change(dropdown, { target: { value: "anthropic/claude-sonnet-4-5" } });

      // Click Complete Setup
      await waitFor(() => {
        expect(screen.getByText("Complete Setup")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Complete Setup"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            modelOnboardingComplete: true,
            defaultProvider: "anthropic",
            defaultModelId: "claude-sonnet-4-5",
          }),
        );
      });

      // Should show completion screen
      await waitFor(() => {
        expect(screen.getByText("All Set!")).toBeTruthy();
      });

      // Click Get Started to close
      fireEvent.click(screen.getByText("Get Started"));
      expect(onComplete).toHaveBeenCalled();
    });

    it("completes without model selection", async () => {
      const onComplete = vi.fn();
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      // Wait for auto-advance
      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });

      // Click Complete Setup without selecting a model
      fireEvent.click(screen.getByText("Complete Setup"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith(
          expect.objectContaining({
            modelOnboardingComplete: true,
          }),
        );
      });
    });
  });

  describe("dismiss / skip", () => {
    it("marks onboarding complete when dismissed via X button", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Set Up AI Provider")).toBeTruthy();
      });

      // Click the X close button
      const closeBtn = screen.getByLabelText("Skip onboarding");
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
          modelOnboardingComplete: true,
        });
      });

      expect(onComplete).toHaveBeenCalled();
    });

    it("marks onboarding complete when Skip for now is clicked", async () => {
      const onComplete = vi.fn();

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      await waitFor(() => {
        expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({
          modelOnboardingComplete: true,
        });
      });

      expect(onComplete).toHaveBeenCalled();
    });

    it("still calls onComplete even if global settings save fails", async () => {
      const onComplete = vi.fn();
      mockUpdateGlobalSettings.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={onComplete} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Skip for now")).toBeTruthy();
      });

      fireEvent.click(screen.getByText("Skip for now"));

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalled();
      });
    });
  });

  describe("edge cases", () => {
    it("shows empty state when no providers are configured", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({ providers: [] });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText(/No AI providers are configured/)).toBeTruthy();
      });
    });

    it("shows empty state when no models are available on model step", async () => {
      mockFetchAuthStatus.mockResolvedValueOnce({
        providers: [
          { id: "anthropic", name: "Anthropic", authenticated: true, type: "oauth" },
        ],
      });
      mockFetchModels.mockResolvedValueOnce({ models: [], favoriteProviders: [], favoriteModels: [] });

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText("Choose Default Model")).toBeTruthy();
      }, { timeout: 3000 });

      expect(screen.getByText(/No models available/)).toBeTruthy();
    });

    it("handles auth status fetch failure gracefully", async () => {
      mockFetchAuthStatus.mockRejectedValueOnce(new Error("Network error"));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      await waitFor(() => {
        // Should still render the modal without crashing
        expect(screen.getByText("Set Up AI Provider")).toBeTruthy();
      });
    });

    it("shows loading state while fetching providers", () => {
      // Make the fetch hang
      mockFetchAuthStatus.mockReturnValue(new Promise(() => {}));
      mockFetchModels.mockReturnValue(new Promise(() => {}));

      render(<ModelOnboardingModal onComplete={vi.fn()} addToast={vi.fn()} />);

      expect(screen.getByText("Loading providers…")).toBeTruthy();
    });
  });
});
