import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CustomProvidersSection } from "../CustomProvidersSection";

const mockFetchCustomProviders = vi.fn();
const mockAddCustomProvider = vi.fn();
const mockUpdateCustomProvider = vi.fn();
const mockDeleteCustomProvider = vi.fn();
const mockProbeProviderModels = vi.fn();
const mockRefreshProviderModels = vi.fn();

vi.mock("../../api", () => ({
  fetchCustomProviders: (...args: unknown[]) => mockFetchCustomProviders(...args),
  addCustomProvider: (...args: unknown[]) => mockAddCustomProvider(...args),
  updateCustomProvider: (...args: unknown[]) => mockUpdateCustomProvider(...args),
  deleteCustomProvider: (...args: unknown[]) => mockDeleteCustomProvider(...args),
  probeProviderModels: (...args: unknown[]) => mockProbeProviderModels(...args),
  refreshProviderModels: (...args: unknown[]) => mockRefreshProviderModels(...args),
}));

vi.mock("lucide-react", () => ({
  AlertCircle: () => <svg data-testid="icon-alert" />,
  ChevronRight: () => <svg data-testid="icon-chevron-right" />,
  Loader2: ({ className }: { className?: string }) => <svg data-testid="icon-loader" className={className} />,
  Pencil: () => <svg data-testid="icon-pencil" />,
  Plus: () => <svg data-testid="icon-plus" />,
  RefreshCw: () => <svg data-testid="icon-refresh" />,
  Search: () => <svg data-testid="icon-search" />,
  Trash2: () => <svg data-testid="icon-trash" />,
}));

describe("CustomProvidersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    mockFetchCustomProviders.mockResolvedValue([]);
    mockAddCustomProvider.mockResolvedValue({
      id: "test-id",
      name: "Test Provider",
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com",
    });
    mockUpdateCustomProvider.mockResolvedValue({
      id: "test-id",
      name: "Updated",
      apiType: "openai-compatible",
      baseUrl: "https://api.example.com",
    });
    mockDeleteCustomProvider.mockResolvedValue({ success: true });
    mockProbeProviderModels.mockResolvedValue({ models: [], count: 0 });
    mockRefreshProviderModels.mockResolvedValue({
      provider: {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "fresh-model", name: "Fresh model" }],
      },
      modelsRefreshed: 1,
    });
  });

  it("renders collapsed disclosure by default", () => {
    render(<CustomProvidersSection />);
    expect(screen.getByRole("button", { name: /Advanced: Custom Providers/i })).toBeTruthy();
    expect(screen.queryByText("No custom providers configured.")).toBeNull();
  });

  it("loads providers when disclosure is expanded", async () => {
    render(<CustomProvidersSection />);

    fireEvent.click(screen.getByRole("button", { name: /Advanced: Custom Providers/i }));

    await waitFor(() => {
      expect(mockFetchCustomProviders).toHaveBeenCalledTimes(1);
      expect(screen.getByText("No custom providers configured.")).toBeTruthy();
    });
  });

  it("fetches providers on mount when embedded", async () => {
    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(mockFetchCustomProviders).toHaveBeenCalledTimes(1);
    });
  });

  it("adds a provider and refreshes list", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Test Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
        },
      ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));

    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Test Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith({
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
      });
      expect(screen.getByText("Test Provider")).toBeTruthy();
    });
  });

  it("shows OpenAI Responses option and posts openai-responses apiType", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));

    const apiTypeSelect = screen.getByLabelText("API type") as HTMLSelectElement;
    expect(screen.getByRole("option", { name: "OpenAI Responses" })).toBeTruthy();
    fireEvent.change(apiTypeSelect, { target: { value: "openai-responses" } });
    expect(apiTypeSelect.value).toBe("openai-responses");

    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Responses Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith({
        name: "Responses Provider",
        apiType: "openai-responses",
        baseUrl: "https://api.example.com/v1",
      });
    });
  });

  it("exposes Google Generative AI in the add provider API type dropdown", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));

    const apiTypeSelect = screen.getByLabelText("API type") as HTMLSelectElement;
    expect(Array.from(apiTypeSelect.options).map((option) => option.value)).toContain("google-generative-ai");
    expect(screen.getByRole("option", { name: "Google Generative AI" })).toBeTruthy();
  });

  it("exposes Google Generative AI in the edit provider API type dropdown", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Editable Provider",
        apiType: "anthropic-compatible",
        baseUrl: "https://api.example.com",
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Editable Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Editable Provider"));

    const apiTypeSelect = screen.getByLabelText("API type") as HTMLSelectElement;
    expect(Array.from(apiTypeSelect.options).map((option) => option.value)).toContain("google-generative-ai");
    expect(screen.getByRole("option", { name: "Google Generative AI" })).toBeTruthy();
  });

  it("selects Google Generative AI when editing an existing Google provider", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "google-id",
        name: "Google Provider",
        apiType: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Google Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Google Provider"));

    const apiTypeSelect = screen.getByLabelText("API type") as HTMLSelectElement;
    expect(apiTypeSelect.value).toBe("google-generative-ai");
    expect(apiTypeSelect.selectedOptions[0]?.value).toBe("google-generative-ai");
  });

  it("shows validation errors for empty name and invalid baseUrl", async () => {
    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(screen.getByText("Provider name is required.")).toBeTruthy();
    });

    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Name" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "ftp://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(screen.getByText("Base URL must be a valid http/https URL.")).toBeTruthy();
    });
  });

  it("normalizes legacy openai-responses api to apiType on edit", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([
        {
          id: "legacy-id",
          name: "Legacy Responses",
          baseUrl: "https://legacy.example.com/v1",
          api: "openai-responses",
          models: [{ id: "r1", name: "Responses 1" }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "legacy-id",
          name: "Legacy Responses",
          apiType: "openai-responses",
          baseUrl: "https://legacy.example.com/v1",
        },
      ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Legacy Responses")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Legacy Responses"));
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("legacy-id", expect.objectContaining({
        apiType: "openai-responses",
      }));
    });
  });

  it("edits an existing provider", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Test Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Updated Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.updated.example.com",
        },
      ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Test Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Test Provider"));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Updated Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.updated.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-id", {
        name: "Updated Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.updated.example.com",
      });
      expect(screen.getByText("Updated Provider")).toBeTruthy();
    });
  });

  it("does not echo the masked key back when editing without retyping", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Keyed Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
          // Server returns the key masked for display.
          apiKey: "abc•••••wxyz",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Keyed Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
        },
      ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Keyed Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Keyed Provider"));

    // The API key field must start empty, never seeded with the mask.
    const apiKeyInput = screen.getByLabelText("API key") as HTMLInputElement;
    expect(apiKeyInput.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledTimes(1);
    });
    // apiKey is omitted entirely so the stored credential is preserved.
    const [, payload] = mockUpdateCustomProvider.mock.calls[0];
    expect(payload).not.toHaveProperty("apiKey");
  });

  it("renders one refresh button per populated provider and none for an empty list", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
      },
    ]);

    const { unmount } = render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Refresh models for Test Provider" }).closest(".custom-provider-item-actions")).toBeTruthy();

    unmount();
    mockFetchCustomProviders.mockResolvedValueOnce([]);
    render(<CustomProvidersSection />);
    fireEvent.click(screen.getByRole("button", { name: /Advanced: Custom Providers/i }));

    await waitFor(() => {
      expect(screen.getByText("No custom providers configured.")).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /Refresh models for/i })).toBeNull();
  });

  it("refreshes one provider's models and shows a success message", async () => {
    const onProviderChange = vi.fn();
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
    ]);

    render(<CustomProvidersSection embedded onProviderChange={onProviderChange} />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Test Provider" }));

    await waitFor(() => {
      expect(mockRefreshProviderModels).toHaveBeenCalledWith("test-id");
      expect(onProviderChange).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Refreshed 1 model(s).")).toBeTruthy();
    });
  });

  it("disables only the refreshing provider while refresh is pending", async () => {
    let resolveRefresh: (value: unknown) => void = () => undefined;
    mockRefreshProviderModels.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
      },
      {
        id: "other-id",
        name: "Other Provider",
        apiType: "openai-compatible",
        baseUrl: "https://other.example.com",
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Test Provider" }));

    expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toHaveAttribute("disabled");
    expect(screen.getByRole("button", { name: "Refresh models for Other Provider" })).not.toHaveAttribute("disabled");

    resolveRefresh({
      provider: {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "fresh-model", name: "Fresh model" }],
      },
      modelsRefreshed: 1,
    });

    await waitFor(() => {
      expect(screen.getByText("Refreshed 1 model(s).")).toBeTruthy();
    });
  });

  it("syncs an open edit form after refreshing models so save preserves the refreshed list", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Test Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
          apiKey: "sk••••test",
          models: [{ id: "stale-model", name: "Stale model" }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Renamed Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
          apiKey: "sk••••test",
          models: [{ id: "fresh-model", name: "Fresh model" }],
        },
      ]);
    mockRefreshProviderModels.mockResolvedValueOnce({
      provider: {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        apiKey: "sk••••test",
        models: [{ id: "fresh-model", name: "Fresh model" }],
      },
      modelsRefreshed: 1,
    });

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Test Provider"));
    expect(screen.getByLabelText("Available models")).toHaveValue("stale-model");

    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Test Provider" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Available models")).toHaveValue("fresh-model");
    });

    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Renamed Provider" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-id", expect.objectContaining({
        name: "Renamed Provider",
        models: [{ id: "fresh-model", name: "fresh-model" }],
      }));
    });
  });

  it("shows refresh failures without closing the edit form or erasing models", async () => {
    mockRefreshProviderModels.mockRejectedValueOnce(new Error("provider offline"));
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "stale-model", name: "Stale model" }],
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Test Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Test Provider"));
    expect(screen.getByLabelText("Available models")).toHaveValue("stale-model");
    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Test Provider" }));

    await waitFor(() => {
      expect(screen.getByText("provider offline")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
    expect(screen.getByLabelText("Available models")).toHaveValue("stale-model");
  });

  it("keeps refresh actions in the reusable mobile-safe action container", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toBeTruthy();
    });

    const actions = screen.getByRole("button", { name: "Refresh models for Test Provider" }).closest(".custom-provider-item-actions");
    expect(actions).toBeTruthy();
    expect(actions?.querySelectorAll("button")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Refresh models for Test Provider" })).toHaveTextContent("Refresh Models");
  });

  it("deletes provider after confirmation", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Test Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
        },
      ])
      .mockResolvedValueOnce([]);

    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Delete Test Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Delete Test Provider"));

    await waitFor(() => {
      expect(window.confirm).toHaveBeenCalled();
      expect(mockDeleteCustomProvider).toHaveBeenCalledWith("test-id");
      expect(screen.getByText("No custom providers configured.")).toBeTruthy();
    });
  });

  it("shows load error when fetchCustomProviders fails", async () => {
    mockFetchCustomProviders.mockRejectedValueOnce(new Error("load failed"));
    render(<CustomProvidersSection />);

    fireEvent.click(screen.getByRole("button", { name: /Advanced: Custom Providers/i }));

    await waitFor(() => {
      expect(screen.getByText("load failed")).toBeTruthy();
    });
  });

  it("shows save error when addCustomProvider fails", async () => {
    mockAddCustomProvider.mockRejectedValueOnce(new Error("add failed"));
    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Test Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(screen.getByText("add failed")).toBeTruthy();
    });
  });
});
