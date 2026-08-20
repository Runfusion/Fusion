import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomProviderForm } from "../CustomProviderForm";
import * as api from "../../api";

describe("CustomProviderForm", () => {
  it("renders base fields", () => {
    render(<CustomProviderForm onSave={vi.fn()} />);
    expect(screen.getByLabelText("Provider ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Display Name")).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.getByLabelText("API Type")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
  });

  it("validates required fields and rejects built-in IDs", async () => {
    const user = userEvent.setup();
    render(<CustomProviderForm onSave={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Save Provider" }));
    expect(screen.getByText("Provider ID is required.")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Provider ID"), "openai");
    await user.type(screen.getByLabelText("Base URL"), "https://proxy.example.com/v1");
    await user.type(screen.getByLabelText("Model ID 1"), "gpt-4o-mini");
    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    expect(screen.getByText("Provider ID conflicts with a built-in provider.")).toBeInTheDocument();
  });

  it("submits valid config", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<CustomProviderForm onSave={onSave} />);

    await user.type(screen.getByLabelText("Provider ID"), "my-proxy");
    await user.type(screen.getByLabelText("Display Name"), "My Proxy");
    await user.type(screen.getByLabelText("Base URL"), "https://proxy.example.com/v1");
    await user.selectOptions(screen.getByLabelText("API Type"), "openai-responses");
    await user.type(screen.getByLabelText("API Key"), "MY_API_KEY");
    await user.type(screen.getByLabelText("Model ID 1"), "gpt-4.1-mini");
    await user.type(screen.getByLabelText("Model name 1"), "GPT 4.1 Mini");

    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    expect(onSave).toHaveBeenCalledWith({
      id: "my-proxy",
      name: "My Proxy",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-responses",
      apiKey: "MY_API_KEY",
      models: [{
        id: "gpt-4.1-mini",
        name: "GPT 4.1 Mini",
        contextWindow: undefined,
        maxTokens: undefined,
      }],
    });
  });

  it("does not render a reasoning capability toggle", () => {
    render(<CustomProviderForm onSave={vi.fn()} />);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText("Reasoning")).not.toBeInTheDocument();
  });

  it("shows external error state", () => {
    render(<CustomProviderForm onSave={vi.fn()} error="Request failed" />);
    expect(screen.getByText("Request failed")).toBeInTheDocument();
  });
});

// FNXC:CustomProviderModelWindows 2026-08-19-16:01:
// RUFU-123: the legacy ModelOnboardingModal form already renders per-model numeric
// contextWindow/maxTokens inputs, but the API mirror (createCustomProvider) used to drop
// them on persistence. This pins the legacy create path: a submitted config with per-model
// windows must reach createCustomProvider unmodified.
describe("legacy create path — per-model window carry-through (RUFU-123)", () => {
  it("submits per-model contextWindow/maxTokens to createCustomProvider unmodified", async () => {
    const createSpy = vi.spyOn(api, "createCustomProvider").mockResolvedValue({
      id: "my-proxy",
      name: "My Proxy",
      apiType: "openai-compatible",
      baseUrl: "https://proxy.example.com/v1",
      models: [{ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 }],
    });

    render(<CustomProviderForm onSave={(config) => createSpy(config)} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Provider ID"), "my-proxy");
    await user.type(screen.getByLabelText("Base URL"), "https://proxy.example.com/v1");
    await user.type(screen.getByLabelText("Model ID 1"), "deepseek-v4");
    await user.type(screen.getByLabelText("Context window 1"), "32768");
    await user.type(screen.getByLabelText("Max tokens 1"), "4096");
    await user.click(screen.getByRole("button", { name: "Save Provider" }));

    // FN-043 (origin) replaced the per-model reasoning boolean with canonical thinking
    // levels, so the form no longer submits a reasoning field — the expectation is
    // window carry-through only (the test's purpose).
    expect(createSpy).toHaveBeenCalledWith({
      id: "my-proxy",
      name: undefined,
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-completions",
      apiKey: undefined,
      models: [{ id: "deepseek-v4", name: undefined, contextWindow: 32768, maxTokens: 4096 }],
    });
    createSpy.mockRestore();
  });
});

describe("Detect Models", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("shows the Detect Models button for openai-completions API type", () => {
    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: "gpt-4o", name: "GPT 4o" }],
        }}
      />
    );
    expect(screen.getByRole("button", { name: /detect models/i })).toBeInTheDocument();
  });

  it("shows the Detect Models button for openai-responses API type", () => {
    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://api.example.com/v1",
          api: "openai-responses",
          apiKey: "sk-test",
          models: [{ id: "gpt-4o", name: "GPT 4o" }],
        }}
      />
    );
    expect(screen.getByRole("button", { name: /detect models/i })).toBeInTheDocument();
  });

  it("shows the Detect Models button for anthropic-messages API type", () => {
    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://api.anthropic.com",
          api: "anthropic-messages",
          apiKey: "sk-ant-test",
          models: [{ id: "claude-3", name: "Claude 3" }],
        }}
      />
    );
    expect(screen.getByRole("button", { name: /detect models/i })).toBeInTheDocument();
  });

  it("shows the Detect Models button for google-generative-ai API type", () => {
    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://generativelanguage.googleapis.com",
          api: "google-generative-ai",
          apiKey: "sk-google",
          models: [{ id: "gemini-pro", name: "Gemini Pro" }],
        }}
      />
    );
    expect(screen.getByRole("button", { name: /detect models/i })).toBeInTheDocument();
  });

  it("calls probeProviderModels and adds discovered models", async () => {
    const mockProbe = vi.spyOn(api, "probeProviderModels").mockResolvedValue({
      models: [
        { id: "gpt-4o", name: "GPT 4o" },
        { id: "gpt-4", name: "GPT 4" },
      ],
      count: 2,
    });

    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: "", name: "" }],
        }}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /detect models/i }));

    expect(mockProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.example.com/v1",
        apiKey: "sk-test",
        apiType: "openai-compatible",
      })
    );

    // Models should be added to the list
    expect(screen.getByDisplayValue("gpt-4o")).toBeInTheDocument();
    expect(screen.getByDisplayValue("gpt-4")).toBeInTheDocument();
  });

  it("deduplicates models when detecting", async () => {
    const mockProbe = vi.spyOn(api, "probeProviderModels").mockResolvedValue({
      models: [
        { id: "gpt-4o", name: "GPT 4o" },
        { id: "gpt-4", name: "GPT 4" },
      ],
      count: 2,
    });

    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [
            { id: "gpt-4o", name: "GPT 4o" },
            { id: "", name: "" },
          ],
        }}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /detect models/i }));

    // gpt-4o should appear only once (existing + deduplicated)
    const gpt4oInputs = screen.queryAllByDisplayValue("gpt-4o");
    expect(gpt4oInputs).toHaveLength(1);
    // gpt-4 should be added
    expect(screen.getByDisplayValue("gpt-4")).toBeInTheDocument();
  });

  it("shows error when detection fails", async () => {
    const mockProbe = vi.spyOn(api, "probeProviderModels").mockRejectedValue(
      new Error("Provider returned 401 Unauthorized")
    );

    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "https://api.example.com/v1",
          api: "openai-completions",
          apiKey: "sk-invalid",
          models: [{ id: "", name: "" }],
        }}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /detect models/i }));

    expect(screen.getByText("Provider returned 401 Unauthorized")).toBeInTheDocument();
  });

  it("disables button when baseUrl is empty", () => {
    render(
      <CustomProviderForm
        onSave={vi.fn()}
        initialConfig={{
          id: "my-provider",
          baseUrl: "",
          api: "openai-completions",
          apiKey: "sk-test",
          models: [{ id: "", name: "" }],
        }}
      />
    );
    const detectBtn = screen.getByRole("button", { name: /detect models/i });
    expect(detectBtn).toBeDisabled();
  });
});
