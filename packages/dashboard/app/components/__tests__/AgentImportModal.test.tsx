import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
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

const stylesPath = path.join(__dirname, "../../styles.css");
const readStyles = () => fs.readFileSync(stylesPath, "utf-8");

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

  it("enables Preview for directory imports with parsed agents even when manifest text is empty", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          dryRun: true,
          companyName: "Directory Import",
          agents: [{ name: "Dir Agent", role: "reviewer" }],
          skills: [],
          created: ["Dir Agent"],
          skipped: [],
          errors: [],
        },
      }),
    );

    renderModal(true);

    const preview = screen.getByRole("button", { name: "Preview" });
    expect(preview).toBeDisabled();

    const directoryInput = screen.getByLabelText(/Select directory/i) as HTMLInputElement;
    const manifest = `---\nname: Dir Agent\nrole: reviewer\n---\nDirectory instructions`;
    const directoryFile = new File([manifest], "AGENTS.md", { type: "text/markdown" });
    Object.defineProperty(directoryFile, "webkitRelativePath", { value: "agents/AGENTS.md" });

    fireEvent.change(directoryInput, { target: { files: [directoryFile] } });

    await waitFor(() => {
      expect(preview).toBeEnabled();
    });

    const user = userEvent.setup();
    await user.click(preview);

    await waitFor(() => {
      expect(screen.getByText("Directory Import")).toBeInTheDocument();
      expect(screen.getByText("1 agent found")).toBeInTheDocument();
    });

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0][1]!.body as string);
    expect(body).toMatchObject({
      dryRun: true,
      agents: [
        expect.objectContaining({
          name: "Dir Agent",
          role: "reviewer",
        }),
      ],
    });
    expect(body).not.toHaveProperty("manifest");
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
    expect(screen.getByRole("button", { name: "Import 2 Agents + 2 Skills" })).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
    expect(screen.getByText("strategy")).toBeInTheDocument();
    expect(screen.getByText("Review implementation details")).toBeInTheDocument();
    expect(screen.getByLabelText("Select agent Reviewer")).toBeChecked();
    expect(screen.getByLabelText("Select skill review")).toBeChecked();
  });

  it("allows selecting a subset of agents and skills before import", async () => {
    renderModal(true);

    await goToPreview();

    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Select agent Planner"));
    await user.click(screen.getByLabelText("Select skill strategy"));

    expect(screen.getByRole("button", { name: "Import 1 Agent + 1 Skill" })).toBeInTheDocument();

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      await mockResponse({
        ok: true,
        body: {
          companyName: "Acme AI",
          created: [{ id: "agent-1", name: "Reviewer" }],
          skipped: [],
          errors: [],
          skills: {
            imported: [{ name: "review", path: "skills/imported/acme-ai/review/SKILL.md" }],
            skipped: [],
            errors: [],
          },
        },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Import 1 Agent + 1 Skill" }));

    await waitFor(() => {
      expect(screen.getByText("Import Complete")).toBeInTheDocument();
    });

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[1][1]!.body as string);
    expect(body).toMatchObject({
      selectedAgents: ["Reviewer"],
      selectedSkills: ["review"],
    });
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
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

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
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 created/)).toBeInTheDocument();
      expect(screen.getByText(/1 skipped/)).toBeInTheDocument();
      expect(screen.getByText(/1 error/)).toBeInTheDocument();
    });

    expect(screen.getByText("Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
  });

  it("result step shows skill import stats when skills are imported", async () => {
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
          skills: {
            imported: [
              { name: "review", path: "skills/imported/acme-ai/review/SKILL.md" },
              { name: "strategy", path: "skills/imported/acme-ai/strategy/SKILL.md" },
            ],
            skipped: [],
            errors: [],
          },
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 skills imported/)).toBeInTheDocument();
      expect(screen.getByText("review")).toBeInTheDocument();
      expect(screen.getByText("strategy")).toBeInTheDocument();
    });
  });

  it("result step shows skill skipped count when skills already exist", async () => {
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
          skills: {
            imported: [],
            skipped: ["review", "strategy"],
            errors: [],
          },
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

    await waitFor(() => {
      expect(screen.getByText(/2 skills skipped/)).toBeInTheDocument();
    });
  });

  it("result step shows skill error count when skill writes fail", async () => {
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
          skills: {
            imported: [],
            skipped: [],
            errors: [{ name: "review", error: "Permission denied" }],
          },
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 skill error/)).toBeInTheDocument();
      expect(screen.getByText(/review: Permission denied/)).toBeInTheDocument();
    });
  });

  it("result step shows 'No skills in package' when skills array is empty", async () => {
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
          skills: {
            imported: [],
            skipped: [],
            errors: [],
          },
        },
      }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

    await waitFor(() => {
      expect(screen.getByText(/No skills in package/)).toBeInTheDocument();
    });
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
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

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
    await user.click(screen.getByRole("button", { name: /Import 2 Agents \+ 2 Skills/i }));

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

  it("uses token-based semantic colors for result and browse styling", () => {
    const styles = readStyles();

    expect(styles).toContain('.agent-import-result-stat--success');
    expect(styles).toContain('color: var(--color-success);');
    expect(styles).toContain('.agent-import-result-error');
    expect(styles).toContain('background: color-mix(in srgb, var(--color-error) 8%, transparent);');
    expect(styles).toContain('.agent-import-browse-selected');
    expect(styles).toContain('background: color-mix(in srgb, var(--todo) 10%, transparent);');
    expect(styles).toContain('.agent-import-browse-item-repo');
    expect(styles).toContain('font-family: var(--font-mono);');
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

    it("uses the shared small button class for selected catalog actions", async () => {
      const mockCompanies = [
        { slug: "test-company", name: "Test Company", tagline: "A great company" },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse({ companies: mockCompanies }));

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));
      await user.click(await screen.findByText("Test Company"));

      const changeButton = await screen.findByRole("button", { name: "Change" });
      expect(changeButton).toHaveClass("btn-sm");
      expect(changeButton).not.toHaveClass("btn--small");
    });

    it("shows package skills in browse-mode preview and import results", async () => {
      globalThis.fetch = vi.fn().mockImplementation((input, init) => {
        const url = String(input);
        if (url === "/api/agents/companies") {
          return Promise.resolve(createMockResponse({
            companies: [{ slug: "acme-ai", name: "Acme AI", tagline: "Agent package with skills" }],
          }));
        }

        if (url === "/api/agents/import") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { dryRun?: boolean };
          if (body.dryRun) {
            return Promise.resolve(createMockResponse({
              dryRun: true,
              companyName: "Acme AI",
              companySlug: "acme-ai",
              agents: [{ name: "Reviewer", role: "reviewer" }],
              skills: [
                { name: "review", description: "Review changes" },
                { name: "strategy", description: "Plan delivery" },
              ],
              created: ["Reviewer"],
              skipped: [],
              errors: [],
            }));
          }

          return Promise.resolve(createMockResponse({
            companyName: "Acme AI",
            companySlug: "acme-ai",
            created: [{ id: "agent-1", name: "Reviewer" }],
            skipped: [],
            errors: [],
            skills: {
              imported: [{ name: "review", path: "skills/imported/acme-ai/review/SKILL.md" }],
              skipped: ["strategy"],
              errors: [],
            },
          }));
        }

        return Promise.reject(new Error(`Unexpected fetch URL: ${url}`));
      });

      renderModal(true);

      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "Browse Catalog" }));
      await user.click(await screen.findByText("Acme AI"));
      await user.click(screen.getByRole("button", { name: "Preview" }));

      await waitFor(() => {
        expect(screen.getByText("1 agent found")).toBeInTheDocument();
        expect(screen.getByText("2 skills found")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Import 1 Agent + 2 Skills" })).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText("Select skill strategy"));
      expect(screen.getByRole("button", { name: "Import 1 Agent + 1 Skill" })).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Import 1 Agent + 1 Skill" }));

      await waitFor(() => {
        expect(screen.getByText("Import Complete")).toBeInTheDocument();
        expect(screen.getByText(/1 skill imported/)).toBeInTheDocument();
        expect(screen.getByText(/1 skill skipped/)).toBeInTheDocument();
      });

      const importBody = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[2]?.[1]?.body ?? "{}"));
      expect(importBody).toMatchObject({
        importSource: "companies.sh",
        companySlug: "acme-ai",
        selectedAgents: ["Reviewer"],
        selectedSkills: ["review"],
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
