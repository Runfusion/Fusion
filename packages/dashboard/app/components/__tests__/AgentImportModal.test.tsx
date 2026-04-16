import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentImportModal } from "../AgentImportModal";

interface MockResponse {
  ok: boolean;
  status?: number;
  body: unknown;
}

function mockResponse({ ok, status = ok ? 200 : 400, body }: MockResponse): Promise<Response> {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe("AgentImportModal", () => {
  const onClose = vi.fn();
  const onImported = vi.fn();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  function renderModal(isOpen = true) {
    return render(
      <AgentImportModal
        isOpen={isOpen}
        onClose={onClose}
        onImported={onImported}
      />,
    );
  }

  async function goToPreview(manifest = "---\nname: Reviewer\nrole: reviewer\n---") {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          agents: [
            { name: "Reviewer", role: "reviewer", title: "Code Reviewer", skills: ["review"] },
            { name: "Planner", role: "triage", title: "Planner" },
          ],
          skills: [
            { name: "review", description: "Review implementation details" },
            { name: "strategy" },
          ],
          created: ["Reviewer", "Planner"],
          skipped: [],
          errors: [],
          dryRun: true,
        },
      }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Manifest content"), manifest);
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("Acme AI")).toBeInTheDocument();
      expect(screen.getByText("2 agents found")).toBeInTheDocument();
    });
  }

  it("returns null when isOpen=false", () => {
    renderModal(false);
    expect(screen.queryByText("Import Agents")).not.toBeInTheDocument();
  });

  it("renders title when open", () => {
    renderModal(true);
    expect(screen.getByText("Import Agents")).toBeInTheDocument();
  });

  it("shows file upload area and textarea in input step", () => {
    renderModal(true);

    expect(screen.getByRole("button", { name: "Choose File" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select Directory" })).toBeInTheDocument();
    expect(screen.getByLabelText("Manifest content")).toBeInTheDocument();
  });

  it("disables Preview when manifest is empty and enables after typing", async () => {
    renderModal(true);

    const user = userEvent.setup();
    const preview = screen.getByRole("button", { name: "Preview" });
    expect(preview).toBeDisabled();

    await user.type(screen.getByLabelText("Manifest content"), "name: test-agent");
    expect(preview).toBeEnabled();
  });

  it("handleParse posts dryRun import request and moves to preview step", async () => {
    renderModal(true);

    await goToPreview();

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/agents/import",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({
      dryRun: true,
      manifest: expect.stringContaining("name: Reviewer"),
    });
  });

  it("preview shows company name, count, and agent list", async () => {
    renderModal(true);

    await goToPreview();

    expect(screen.getByText("Acme AI")).toBeInTheDocument();
    expect(screen.getByText("2 agents found")).toBeInTheDocument();
    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText(/reviewer/)).toBeInTheDocument();
    expect(screen.getByText(/triage/)).toBeInTheDocument();
    expect(screen.getByText("2 skills found")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("strategy")).toBeInTheDocument();
    expect(screen.getByText("Review implementation details")).toBeInTheDocument();
  });

  it("Back button returns to input step", async () => {
    renderModal(true);
    await goToPreview();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.getByLabelText("Manifest content")).toBeInTheDocument();
    expect(screen.queryByText("2 agents found")).not.toBeInTheDocument();
  });

  it("does not render skills section when no package skills are returned", async () => {
    renderModal(true);

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          agents: [{ name: "Reviewer", role: "reviewer" }],
          created: ["Reviewer"],
          skipped: [],
          errors: [],
          dryRun: true,
        },
      }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Manifest content"), "---\nname: Reviewer\nrole: reviewer\n---");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("1 agent found")).toBeInTheDocument();
    });

    expect(screen.queryByText(/skills found/)).not.toBeInTheDocument();
  });

  it("handleImport posts live import request and transitions to result step", async () => {
    renderModal(true);

    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }],
          skipped: ["Planner"],
          errors: [{ name: "Writer", error: "Invalid role" }],
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(screen.getByText("Import Complete")).toBeInTheDocument();
    });

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]!.body as string);
    expect(body).toMatchObject({
      manifest: expect.stringContaining("name: Reviewer"),
      skipExisting: true,
    });
    expect(body).not.toHaveProperty("dryRun");
  });

  it("result step shows created/skipped/error counts and created names", async () => {
    renderModal(true);
    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }, { id: "agent-2", name: "Planner" }],
          skipped: ["Writer"],
          errors: [{ name: "Ops", error: "Bad schema" }],
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 created/)).toBeInTheDocument();
      expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
      expect(screen.getByText(/1 error/)).toBeInTheDocument();
    });

    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
  });

  it("calls onImported after successful import", async () => {
    renderModal(true);
    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }],
          skipped: [],
          errors: [],
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(onImported).toHaveBeenCalledTimes(1);
    });
  });

  it("shows parse API errors", async () => {
    renderModal(true);

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({ ok: false, body: { error: "No agents found" } }),
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Manifest content"), "invalid manifest");
    await user.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("No agents found")).toBeInTheDocument();
    });
  });

  it("shows import API errors", async () => {
    renderModal(true);
    await goToPreview();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({ ok: false, body: { error: "Import failed" } }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents/i }));

    await waitFor(() => {
      expect(screen.getByText("Import failed")).toBeInTheDocument();
    });
  });

  it("Cancel/Close calls onClose and resets state", async () => {
    const { rerender } = renderModal(true);

    await goToPreview();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    expect(screen.getByLabelText("Manifest content")).toHaveValue("");
    expect(screen.queryByText("2 agents found")).not.toBeInTheDocument();
  });

  it("clicking overlay triggers handleClose", () => {
    const { container } = renderModal(true);

    const overlay = container.querySelector(".agent-dialog-overlay");
    expect(overlay).toBeTruthy();

    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  describe("Browse Catalog Mode", () => {
    function createMockResponse(body: unknown): Response {
      return {
        ok: true,
        status: 200,
        headers: new globalThis.Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as unknown as Response;
    }

    it("shows companies when fetch succeeds", async () => {
      const mockCompanies = [
        { slug: "test-company", name: "Test Company", tagline: "A great company" },
        { slug: "another-co", name: "Another Company" },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse({ companies: mockCompanies }));

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));

      await waitFor(() => {
        expect(screen.getByText("Test Company")).toBeInTheDocument();
        expect(screen.getByText("Another Company")).toBeInTheDocument();
      });
    });

    it("shows error message when companies.sh returns error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse({
        companies: [],
        error: "Failed to fetch companies.sh catalog: Network unreachable",
      }));

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));

      await waitFor(() => {
        expect(screen.getByText(/Failed to fetch companies.sh catalog/)).toBeInTheDocument();
      });
    });

    it("shows Retry button when error occurs", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse({
        companies: [],
        error: "Failed to fetch companies.sh catalog: Network unreachable",
      }));

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
      });
    });

    it("does not retry infinitely after error", async () => {
      let fetchCallCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        fetchCallCount++;
        return Promise.resolve(createMockResponse({
          companies: [],
          error: "Network unreachable",
        }));
      });

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));

      // Wait for the error to appear
      await waitFor(() => {
        expect(screen.getByText(/Network unreachable/)).toBeInTheDocument();
      });

      // Allow a bit of time for any potential extra fetches
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should have exactly 1 fetch call (no infinite retry)
      expect(fetchCallCount).toBe(1);
    });

    it("retry button allows re-fetching after error", async () => {
      // Use a ref to track call count
      const callCountRef = { current: 0 };

      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCountRef.current++;
        const callNum = callCountRef.current;

        // First call returns error, subsequent calls return success
        if (callNum === 1) {
          return Promise.resolve(createMockResponse({
            companies: [],
            error: "Network unreachable",
          }));
        }
        return Promise.resolve(createMockResponse({
          companies: [{ slug: "test-co", name: "Test Company" }],
        }));
      });

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));

      // Wait for error
      await waitFor(() => {
        expect(screen.getByText(/Network unreachable/)).toBeInTheDocument();
      });

      // Verify only 1 fetch happened
      expect(callCountRef.current).toBe(1);

      // Click retry using act to ensure state updates are processed
      const retryButton = screen.getByRole("button", { name: /Retry/i });
      await act(async () => {
        await user.click(retryButton);
      });

      // Wait for the error to be cleared (indicating retry is in progress)
      await waitFor(() => {
        expect(screen.queryByText(/Network unreachable/)).not.toBeInTheDocument();
      });

      // The mock should return success on second call, so we should see the companies
      await waitFor(() => {
        expect(screen.getByText("Test Company")).toBeInTheDocument();
      });

      // Verify a second fetch happened
      expect(callCountRef.current).toBe(2);
    });
  });
});
