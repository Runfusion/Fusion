import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomProviderForm } from "../CustomProviderForm";

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

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: "my-proxy",
      name: "My Proxy",
      baseUrl: "https://proxy.example.com/v1",
      api: "openai-responses",
      apiKey: "MY_API_KEY",
      models: [expect.objectContaining({ id: "gpt-4.1-mini", name: "GPT 4.1 Mini" })],
    }));
  });

  it("shows external error state", () => {
    render(<CustomProviderForm onSave={vi.fn()} error="Request failed" />);
    expect(screen.getByText("Request failed")).toBeInTheDocument();
  });
});
