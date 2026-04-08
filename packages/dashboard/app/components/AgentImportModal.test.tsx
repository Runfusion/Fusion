import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AgentImportModal } from "./AgentImportModal";

interface MockResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

function mockFetchResponse({ ok, status, body }: MockResponse): Promise<Response> {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
  } as Response);
}

describe("AgentImportModal", () => {
  const onClose = vi.fn();
  const onImported = vi.fn();
  const originalFileReader = globalThis.FileReader;

  beforeEach(() => {
    vi.clearAllMocks();

    class MockFileReader {
      onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => any) | null = null;
      onerror: ((this: FileReader, ev: ProgressEvent<FileReader>) => any) | null = null;

      readAsText(file: Blob): void {
        const content = (file as any).__content ?? "";
        this.onload?.call(this as unknown as FileReader, {
          target: { result: content },
        } as ProgressEvent<FileReader>);
      }
    }

    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.FileReader = originalFileReader;
  });

  it("renders the input step with file upload, directory button, and textarea", () => {
    render(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    expect(screen.getByText("Import Agents")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose File" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select Directory" })).toBeTruthy();
    expect(screen.getByLabelText("Manifest content")).toBeTruthy();
  });

  it("loads selected .md file content into the manifest textarea", async () => {
    render(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    const fileInput = screen.getByLabelText("Upload agent manifest file") as HTMLInputElement;
    const file = new File(["---\nname: CEO\n---\nLead"], "AGENTS.md", { type: "text/markdown" });
    (file as any).__content = "---\nname: CEO\n---\nLead";

    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      const textarea = screen.getByLabelText("Manifest content") as HTMLTextAreaElement;
      expect(textarea.value).toContain("name: CEO");
    });
  });

  it("shows parse preview using API-provided agents array", async () => {
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => mockFetchResponse({
      ok: true,
      status: 200,
      body: {
        dryRun: true,
        companyName: "Acme Co",
        agents: [
          {
            name: "CEO",
            role: "executor",
            title: "Chief Executive",
            skills: ["review"],
          },
        ],
        created: ["CEO"],
        skipped: [],
        errors: [],
      },
    }));

    render(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    fireEvent.change(screen.getByLabelText("Manifest content"), {
      target: { value: "---\nname: CEO\n---\nLead" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("CEO")).toBeTruthy();
      expect(screen.getByText(/executor/)).toBeTruthy();
      expect(screen.getByText(/Chief Executive/)).toBeTruthy();
    });
  });

  it("imports agents from preview step and shows result summary", async () => {
    vi.mocked(globalThis.fetch)
      .mockImplementationOnce(() => mockFetchResponse({
        ok: true,
        status: 200,
        body: {
          dryRun: true,
          companyName: "Acme Co",
          agents: [{ name: "CEO", role: "executor", title: "Chief Executive", skills: ["review"] }],
          created: ["CEO"],
          skipped: [],
          errors: [],
        },
      }))
      .mockImplementationOnce(() => mockFetchResponse({
        ok: true,
        status: 200,
        body: {
          companyName: "Acme Co",
          created: [{ id: "agent-1", name: "CEO" }],
          skipped: [],
          errors: [],
        },
      }));

    render(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    fireEvent.change(screen.getByLabelText("Manifest content"), {
      target: { value: "---\nname: CEO\n---\nLead" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Import 1 Agent/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Import 1 Agent/i }));

    await waitFor(() => {
      expect(screen.getByText("Import Complete")).toBeTruthy();
      expect(screen.getByText(/1 created/)).toBeTruthy();
    });

    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it("shows API errors to the user", async () => {
    vi.mocked(globalThis.fetch).mockImplementationOnce(() => mockFetchResponse({
      ok: false,
      status: 400,
      body: { error: "No agents found" },
    }));

    render(<AgentImportModal isOpen={true} onClose={onClose} onImported={onImported} />);

    fireEvent.change(screen.getByLabelText("Manifest content"), {
      target: { value: "invalid content" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      expect(screen.getByText("No agents found")).toBeTruthy();
    });
  });
});
