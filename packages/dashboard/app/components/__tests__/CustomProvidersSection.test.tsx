import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  X: () => <svg data-testid="icon-x" />,
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
        // FNXC:CustomProviderModelWindows 2026-08-21-00:06:
        // RUFU-145 PR #3493 review (Greptile P1): the edit path always sends the row
        // result — an explicit empty array so the server partial merge cannot silently
        // keep a stored model list when the form's single row is blank.
        models: [],
      });
      expect(screen.getByText("Updated Provider")).toBeTruthy();
    });
  });

  it("sends an explicit empty models array when an edit clears the last remaining row", async () => {
    mockFetchCustomProviders
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Windowed Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
          models: [{ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 }],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "test-id",
          name: "Windowed Provider",
          apiType: "openai-compatible",
          baseUrl: "https://api.example.com",
          models: [],
        },
      ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Windowed Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Windowed Provider"));

    // The single remaining row cannot be removed; blanking its id is how the operator
    // deletes the last model. The save must persist that deletion instead of omitting
    // `models` and letting the server partial merge keep the stored list (Greptile P1 on
    // PR #3493: "Cleared models remain persisted").
    // FNXC:CustomProviderModelWindows 2026-08-21-00:06: RUFU-145 symptom verification —
    // this assertion is gone-green: the payload carries an explicit empty array.
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-id", expect.objectContaining({
        name: "Windowed Provider",
        models: [],
      }));
    });
  });

  it("omits models from the create payload when the only row is blank", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Bare Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    // Leave the single model row blank: a new provider simply has no registered models,
    // so the create payload omits the key entirely (the exact-match assertion pins it).
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith({
        name: "Bare Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
      });
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
    // FNXC:CustomProviderModelWindows 2026-08-19-16:49: RUFU-123 the comma input is gone; the row editor seeds row 1.
    expect(screen.getByLabelText("Model ID 1")).toHaveValue("stale-model");

    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Test Provider" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Model ID 1")).toHaveValue("fresh-model");
    });

    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Renamed Provider" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      // The refreshed model's persisted display name now round-trips through the row editor.
      expect(mockUpdateCustomProvider).toHaveBeenCalledWith("test-id", expect.objectContaining({
        name: "Renamed Provider",
        models: [{ id: "fresh-model", name: "Fresh model" }],
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
    expect(screen.getByLabelText("Model ID 1")).toHaveValue("stale-model");
    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Test Provider" }));

    await waitFor(() => {
      expect(screen.getByText("provider offline")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "Save Changes" })).toBeTruthy();
    expect(screen.getByLabelText("Model ID 1")).toHaveValue("stale-model");
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

  /*
  FNXC:CustomProviderModelWindows 2026-08-19-16:49:
  RUFU-123: row-editor coverage — per-model contextWindow/maxTokens flow from the form rows
  into the save payload, blank windows persist as absent, persisted windows pre-fill the
  editor, and detect/refresh merge probed windows without clobbering manual values.
  */
  it("adds a provider with per-model window values via the row editor", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "DeepSeek" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.deepseek.com" } });
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "deepseek-v4" } });
    fireEvent.change(screen.getByLabelText("Display name 1"), { target: { value: "DeepSeek V4" } });
    fireEvent.change(screen.getByLabelText("Context window 1"), { target: { value: "32768" } });
    fireEvent.change(screen.getByLabelText("Max output tokens 1"), { target: { value: "4096" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith({
        name: "DeepSeek",
        apiType: "openai-compatible",
        baseUrl: "https://api.deepseek.com",
        models: [{ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 }],
      });
    });
  });

  it("omits blank window fields from the save payload and keeps the display-name fallback", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Test Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "gpt-4" } });
    // Leave the display name and both window inputs blank: name falls back to the id and the
    // window keys are omitted so the registry builder's defaults apply at registration.
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith({
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "gpt-4", name: "gpt-4" }],
      });
    });
  });

  it("pre-fills numeric window inputs when editing a provider persisted with windows", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Windowed Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 }],
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Windowed Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Windowed Provider"));

    expect(screen.getByLabelText("Model ID 1")).toHaveValue("deepseek-v4");
    expect(screen.getByLabelText("Display name 1")).toHaveValue("DeepSeek V4");
    expect(screen.getByLabelText("Context window 1")).toHaveValue(32768);
    expect(screen.getByLabelText("Max output tokens 1")).toHaveValue(4096);
  });

  it("Detect Models appends probed rows with windows and preserves manual values on existing rows", async () => {
    mockFetchCustomProviders.mockResolvedValue([]);
    mockProbeProviderModels.mockResolvedValue({
      models: [
        { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
        { id: "existing-model", name: "Existing" },
      ],
      count: 2,
    });

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Probe Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    // Fill the initial row manually with its own windows before probing.
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "existing-model" } });
    fireEvent.change(screen.getByLabelText("Context window 1"), { target: { value: "8192" } });
    fireEvent.change(screen.getByLabelText("Max output tokens 1"), { target: { value: "1024" } });

    fireEvent.click(screen.getByRole("button", { name: "Detect Models" }));

    // The probed model is appended as row 2 with its probed windows; the probe reports no
    // window for existing-model, so the manual 8192/1024 survive the merge.
    await waitFor(() => {
      expect(screen.getByLabelText("Model ID 2")).toHaveValue("deepseek-v4");
      expect(screen.getByLabelText("Context window 2")).toHaveValue(32768);
      expect(screen.getByLabelText("Max output tokens 2")).toHaveValue(4096);
    });
    expect(screen.getByLabelText("Context window 1")).toHaveValue(8192);
    expect(screen.getByLabelText("Max output tokens 1")).toHaveValue(1024);

    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: expect.arrayContaining([
          // The probe's name fills the blank display-name field on the existing row
          // (RUFU-145 review fix: the detect merge now reaches the form).
          { id: "existing-model", name: "Existing", contextWindow: 8192, maxTokens: 1024 },
          { id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 },
        ]),
      }));
    });
  });

  // FNXC:CustomProviderModelRows 2026-08-20-22:12: RUFU-145 PR #3493 review: the row key
  // was derived from row.id, so every keystroke changed the key and React remounted the
  // row, dropping focus and keeping only the first typed character. Assert with real
  // per-character input (fireEvent.change cannot catch a remount: it sets the value
  // directly on the node).
  it("typing a multi-character Model ID keeps focus and the full value (stable row key)", async () => {
    mockFetchCustomProviders.mockResolvedValue([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Key Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });

    const modelId = screen.getByLabelText("Model ID 1");
    await userEvent.type(modelId, "gpt-4o");

    expect(modelId).toHaveValue("gpt-4o");
    expect(modelId).toHaveFocus();
  });

  // FNXC:CustomProviderModelRows 2026-08-20-22:12: RUFU-145 PR #3493 review: the detect
  // merge updated a parallel byId map but returned the untouched rows, so probed windows
  // for an already-typed model id never filled the blank form fields. Probe reports a
  // window for the typed id; the blank fields must be filled on the same row.
  it("Detect Models fills blank fields on an already-typed row from the probe", async () => {
    mockFetchCustomProviders.mockResolvedValue([]);
    mockProbeProviderModels.mockResolvedValue({
      models: [{ id: "existing-model", name: "Existing Name", contextWindow: 32768, maxTokens: 4096 }],
      count: 1,
    });

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Probe Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    // Only the Model ID is typed; display name, window, and max tokens stay blank.
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "existing-model" } });

    fireEvent.click(screen.getByRole("button", { name: "Detect Models" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Context window 1")).toHaveValue(32768);
      expect(screen.getByLabelText("Max output tokens 1")).toHaveValue(4096);
    });
    expect(screen.getByLabelText("Display name 1")).toHaveValue("Existing Name");
    // The merge fills the existing row; it must not append a duplicate row.
    expect(screen.queryByLabelText("Model ID 2")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: expect.arrayContaining([
          { id: "existing-model", name: "Existing Name", contextWindow: 32768, maxTokens: 4096 },
        ]),
      }));
    });
  });

  it("Refresh Models re-seeds an open edit form with the merged persisted windows", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Windowed Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "claude-x", name: "Claude X", contextWindow: 65536, maxTokens: 8192 }],
      },
    ]);
    // The server-side refresh already id-merges probed and persisted windows.
    mockRefreshProviderModels.mockResolvedValueOnce({
      provider: {
        id: "test-id",
        name: "Windowed Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [
          { id: "claude-x", name: "Claude X", contextWindow: 65536, maxTokens: 8192 },
          { id: "new-model", name: "New model", contextWindow: 32768 },
        ],
      },
      modelsRefreshed: 2,
    });

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Windowed Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Windowed Provider"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh models for Windowed Provider" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Model ID 2")).toHaveValue("new-model");
    });
    expect(screen.getByLabelText("Context window 1")).toHaveValue(65536);
    expect(screen.getByLabelText("Max output tokens 1")).toHaveValue(8192);
    expect(screen.getByLabelText("Context window 2")).toHaveValue(32768);
    // new-model's maxTokens was not reported/persisted, so its field stays blank.
    expect((screen.getByLabelText("Max output tokens 2") as HTMLInputElement).value).toBe("");
  });

  it("no longer renders the legacy comma-separated models input in either form", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Windowed Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "deepseek-v4", name: "DeepSeek V4", contextWindow: 32768, maxTokens: 4096 }],
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    // New-provider form variant: row editor present, no comma input.
    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    expect(screen.queryByPlaceholderText("e.g., gpt-4, gpt-3.5-turbo")).toBeNull();
    expect(screen.getByRole("button", { name: "Add model row" })).toBeTruthy();

    // Edit form variant: the row editor renders there too, no comma input.
    fireEvent.click(screen.getByLabelText("Edit Windowed Provider"));
    expect(screen.queryByPlaceholderText("e.g., gpt-4, gpt-3.5-turbo")).toBeNull();
    expect(screen.getByLabelText("Model ID 1")).toHaveValue("deepseek-v4");
  });

  /*
  FNXC:CustomProviderThinkingFormat 2026-08-21-06:20:
  RUFU-143: per-model thinking flags — the "Thinking format" select and "No thinking params"
  checkbox round-trip from persisted providers into the edit form, reach the save payload only
  when set (default rows keep the byte-identical shape), the opt-out disables the select and
  wins in the payload, detect-merge keeps flags on existing rows, and flagged rows without an
  id are still excluded (the id remains the validity anchor).
  */
  it("pre-fills the thinking format select and opt-out checkbox when editing a flagged provider", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([
      {
        id: "test-id",
        name: "Qwen Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "qwen3", name: "Qwen 3", thinkingFormat: "qwen-chat-template", reasoning: false }],
      },
    ]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByLabelText("Edit Qwen Provider")).toBeTruthy();
    });

    fireEvent.click(screen.getByLabelText("Edit Qwen Provider"));

    const select = screen.getByLabelText("Thinking format 1") as HTMLSelectElement;
    expect(select.value).toBe("qwen-chat-template");
    expect(screen.getByLabelText("No thinking params 1")).toBeChecked();
    // The opt-out wins: the format select is disabled while reasoning is false.
    expect(select).toBeDisabled();
  });

  it("sends the selected thinking format in the save payload and omits reasoning when not opted out", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Qwen" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://litellm.example.com" } });
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "qwen3" } });
    fireEvent.change(screen.getByLabelText("Thinking format 1"), { target: { value: "qwen-chat-template" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    // Exact model shape: no reasoning key — the opt-out checkbox was never touched.
    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: [{ id: "qwen3", name: "qwen3", thinkingFormat: "qwen-chat-template" }],
      }));
    });
  });

  it("disables the format select and sends reasoning: false (no thinkingFormat) when opted out", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Qwen" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://litellm.example.com" } });
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "qwen3" } });
    // Select a format first, then opt out — the opt-out must win in the payload.
    fireEvent.change(screen.getByLabelText("Thinking format 1"), { target: { value: "zai" } });
    fireEvent.click(screen.getByLabelText("No thinking params 1"));

    expect(screen.getByLabelText("Thinking format 1")).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    // Exact model shape: reasoning: false present, thinkingFormat omitted (opt-out wins).
    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: [{ id: "qwen3", name: "qwen3", reasoning: false }],
      }));
    });
  });

  it("Detect Models keeps per-model thinking flags on existing rows after re-detecting", async () => {
    mockFetchCustomProviders.mockResolvedValue([]);
    mockProbeProviderModels.mockResolvedValue({
      models: [
        { id: "qwen3", name: "Qwen 3" },
        { id: "qwen3-vl", name: "Qwen 3 VL" },
      ],
      count: 2,
    });

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Probe Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://litellm.example.com" } });
    // Row 1 gets its id + thinking format before the probe; the probe reports the same id
    // (no thinking data) plus one new model.
    fireEvent.change(screen.getByLabelText("Model ID 1"), { target: { value: "qwen3" } });
    fireEvent.change(screen.getByLabelText("Thinking format 1"), { target: { value: "qwen-chat-template" } });

    fireEvent.click(screen.getByRole("button", { name: "Detect Models" }));

    // The probed model is appended as row 2; the merge must keep row 1's format flag.
    await waitFor(() => {
      expect(screen.getByLabelText("Model ID 2")).toHaveValue("qwen3-vl");
    });
    expect((screen.getByLabelText("Thinking format 1") as HTMLSelectElement).value).toBe("qwen-chat-template");

    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith(expect.objectContaining({
        models: expect.arrayContaining([
          { id: "qwen3", name: "qwen3", thinkingFormat: "qwen-chat-template" },
          { id: "qwen3-vl", name: "Qwen 3 VL" },
        ]),
      }));
    });
  });

  it("excludes a flagged model row without an id from the save payload", async () => {
    mockFetchCustomProviders.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    render(<CustomProvidersSection embedded />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Add Custom Provider/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Add Custom Provider/i }));
    fireEvent.change(screen.getByLabelText("Provider name"), { target: { value: "Test Provider" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://api.example.com" } });
    // Row 1 gets a thinking format but never an id — it must still be dropped on save.
    fireEvent.change(screen.getByLabelText("Thinking format 1"), { target: { value: "deepseek" } });
    fireEvent.click(screen.getByRole("button", { name: "Add model row" }));
    fireEvent.change(screen.getByLabelText("Model ID 2"), { target: { value: "gpt-4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Provider" }));

    await waitFor(() => {
      expect(mockAddCustomProvider).toHaveBeenCalledWith({
        name: "Test Provider",
        apiType: "openai-compatible",
        baseUrl: "https://api.example.com",
        models: [{ id: "gpt-4", name: "gpt-4" }],
      });
    });
  });
});
