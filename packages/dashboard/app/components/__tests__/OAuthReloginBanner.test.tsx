import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthReloginBanner } from "../OAuthReloginBanner";
import { OAUTH_RELOGIN_SUCCESS_EVENT } from "../../auth";
import * as api from "../../api";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, values?: Record<string, string>) => {
      let text = fallback ?? _key;
      if (values) {
        for (const [key, value] of Object.entries(values)) {
          text = text.replaceAll(`{{${key}}}`, value);
        }
      }
      return text;
    },
  }),
}));

vi.mock("../../api", () => ({
  fetchAuthStatus: vi.fn(),
}));

const mockFetchAuthStatus = vi.mocked(api.fetchAuthStatus);

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("OAuthReloginBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockFetchAuthStatus.mockReset();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("shows expired Anthropic subscription urgency when Claude CLI is authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [
        { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        { id: "claude-cli", name: "Anthropic — via Claude CLI", type: "cli", authenticated: true },
      ],
      ghCli: { available: false, authenticated: false },
    });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);

    expect(await screen.findByRole("status")).toHaveTextContent("Re-login required: Anthropic Subscription");
    expect(screen.getByRole("status")).toHaveTextContent("keep agents running");
  });

  it("hides expired Anthropic subscription urgency when API key and Claude CLI are authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [
        { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        { id: "anthropic-api-key", name: "Anthropic API Key", type: "api_key", authenticated: true, keyHint: "sk-••••1234" },
        { id: "claude-cli", name: "Anthropic — via Claude CLI", type: "cli", authenticated: true },
      ],
      ghCli: { available: false, authenticated: false },
    });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);

    await waitFor(() => expect(mockFetchAuthStatus).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(/Re-login required: Anthropic Subscription/i)).toBeNull();
  });

  it("shows expired Anthropic subscription urgency when no Anthropic fallback is authenticated", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [
        { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        { id: "anthropic-api-key", name: "Anthropic API Key", type: "api_key", authenticated: false },
        { id: "claude-cli", name: "Anthropic — via Claude CLI", type: "cli", authenticated: false },
      ],
      ghCli: { available: false, authenticated: false },
    });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);

    expect(await screen.findByRole("status")).toHaveTextContent("Re-login required: Anthropic Subscription");
    expect(screen.getByRole("status")).toHaveTextContent("keep agents running");
  });

  it("keeps unrelated expired OAuth providers visible when Anthropic fallback suppresses subscription urgency", async () => {
    mockFetchAuthStatus.mockResolvedValueOnce({
      providers: [
        { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        { id: "anthropic-api-key", name: "Anthropic API Key", type: "api_key", authenticated: true, keyHint: "sk-••••1234" },
        { id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: false, expired: true },
      ],
      ghCli: { available: false, authenticated: false },
    });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);

    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI Codex");
    expect(screen.getByRole("status")).not.toHaveTextContent("Anthropic Subscription");
  });

  it("clears the banner when OAuth success is dispatched for the status provider id", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [
          { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: false, expired: true },
        ],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [
          { id: "anthropic-subscription", name: "Anthropic Subscription", type: "oauth", authenticated: true, expired: false },
        ],
        ghCli: { available: false, authenticated: false },
      });

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Anthropic Subscription");

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT, { detail: { providerId: "anthropic-subscription" } }));
      await flushPromises();
    });

    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("keeps a dismissed GitHub Copilot banner hidden across refresh and re-expiry", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: true, expired: false }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      });

    const firstRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("GitHub Copilot");
    fireEvent.click(screen.getByLabelText("Dismiss OAuth re-login banner"));
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).toContain("github-copilot");

    firstRender.unmount();
    const refreshedRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    await waitFor(() => expect(mockFetchAuthStatus).toHaveBeenCalledTimes(2));
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).toContain("github-copilot");

    refreshedRender.unmount();
    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    await waitFor(() => expect(mockFetchAuthStatus).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps multiple dismissed providers suppressed while showing newly expired providers", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [
          { id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true },
          { id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: false, expired: true },
        ],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({ providers: [], ghCli: { available: false, authenticated: false } })
      .mockResolvedValueOnce({
        providers: [
          { id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: false, expired: true },
          { id: "google-gemini", name: "Google Gemini", type: "oauth", authenticated: false, expired: true },
        ],
        ghCli: { available: false, authenticated: false },
      });

    const firstRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("GitHub Copilot, OpenAI Codex");
    fireEvent.click(screen.getByLabelText("Dismiss OAuth re-login banner"));
    firstRender.unmount();

    const clearedRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    await waitFor(() => expect(mockFetchAuthStatus).toHaveBeenCalledTimes(2));
    clearedRender.unmount();

    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("Google Gemini");
    expect(screen.getByRole("status")).not.toHaveTextContent("OpenAI Codex");
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).toContain("github-copilot");
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).toContain("openai-codex");
  });

  it("keeps GitHub Copilot dismissed after a successful OAuth re-login", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: true, expired: false }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      });

    const firstRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("GitHub Copilot");
    fireEvent.click(screen.getByLabelText("Dismiss OAuth re-login banner"));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT, { detail: { providerId: "github-copilot" } }));
      await flushPromises();
    });
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).toContain("github-copilot");

    firstRender.unmount();
    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    await waitFor(() => expect(mockFetchAuthStatus).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("re-arms other dismissed providers after a successful OAuth re-login", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [{ id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: true, expired: false }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "openai-codex", name: "OpenAI Codex", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      });

    const firstRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI Codex");
    fireEvent.click(screen.getByLabelText("Dismiss OAuth re-login banner"));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT, { detail: { providerId: "openai-codex" } }));
      await flushPromises();
    });
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).not.toContain("openai-codex");

    firstRender.unmount();
    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("OpenAI Codex");
  });

  it("does not clear dismissed providers for an OAuth success event without a provider id", async () => {
    mockFetchAuthStatus
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      })
      .mockResolvedValueOnce({
        providers: [{ id: "github-copilot", name: "GitHub Copilot", type: "oauth", authenticated: false, expired: true }],
        ghCli: { available: false, authenticated: false },
      });

    const firstRender = render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    expect(await screen.findByRole("status")).toHaveTextContent("GitHub Copilot");
    fireEvent.click(screen.getByLabelText("Dismiss OAuth re-login banner"));

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OAUTH_RELOGIN_SUCCESS_EVENT));
      await flushPromises();
    });
    expect(window.localStorage.getItem("fusion:oauth-relogin-dismissed")).toContain("github-copilot");

    firstRender.unmount();
    render(<OAuthReloginBanner onReLogin={vi.fn()} pollIntervalMs={60_000} />);
    await waitFor(() => expect(mockFetchAuthStatus).toHaveBeenCalledTimes(3));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
