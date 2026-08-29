// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliPrintingPressTestRunner } from "../run/TestRunnerPanel";
import type { ServiceDraft } from "../wizard/types";

vi.mock("lucide-react", () => ({
  Play: () => null,
  RefreshCw: () => null,
  CheckCircle2: () => null,
  AlertTriangle: () => null,
}));

function makeDraft(): ServiceDraft {
  const now = new Date().toISOString();
  return {
    id: "draft-1",
    name: "Demo",
    slug: "demo",
    description: "",
    baseUrl: "https://example.com",
    transport: "http",
    endpoints: [{ id: "e1", name: "Ping", method: "GET", path: "/ping", params: "q" }],
    credential: { kind: "none" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("CliPrintingPressTestRunner", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("submits run request and renders output states", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/run")) {
        return {
          ok: true,
          json: async () => ({ stdout: "ok", stderr: "", exitCode: 0, durationMs: 12, timedOut: false, argv: ["demo.mjs", "--endpoint", "e1", "--q", "***"] }),
        };
      }
      if (url.endsWith("/regenerate")) {
        return { ok: true, json: async () => ({ draft: makeDraft(), artifact: { draftId: "draft-1", slug: "demo", binPath: "/tmp/demo.mjs", entrypoint: "node", generatedAt: new Date().toISOString() } }) };
      }
      return { ok: false, status: 404, json: async () => ({ error: "missing" }) };
    });

    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<CliPrintingPressTestRunner draftId="draft-1" draft={makeDraft()} />);

    expect(screen.getByRole("combobox")).toBeTruthy();
    await user.type(screen.getByLabelText("q"), "hello");
    await user.type(screen.getByPlaceholderText("api_key"), "secret-value");
    await user.click(screen.getByRole("button", { name: /^Run$/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/run"), expect.objectContaining({ method: "POST" })));
    const runCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/run"));
    expect(runCall).toBeTruthy();
    expect(JSON.parse(String((runCall?.[1] as RequestInit).body))).toMatchObject({ endpointId: "e1", params: { q: "hello" } });
    expect(await screen.findByText("ok")).toBeTruthy();
    expect(screen.queryByText("secret-value")).toBeNull();
  });

  it("renders error and timeout output states", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/run")) {
        calls += 1;
        if (calls === 1) {
          return {
            ok: true,
            json: async () => ({ stdout: "", stderr: "boom", exitCode: 1, durationMs: 22, timedOut: false, argv: ["demo.mjs"] }),
          };
        }
        return {
          ok: true,
          json: async () => ({ stdout: "", stderr: "", exitCode: null, durationMs: 33, timedOut: true, argv: ["demo.mjs"] }),
        };
      }
      return { ok: false, status: 404, json: async () => ({ error: "missing" }) };
    });

    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<CliPrintingPressTestRunner draftId="draft-1" draft={makeDraft()} />);

    await user.click(screen.getByRole("button", { name: /^Run$/i }));
    expect(await screen.findByText("boom")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Run$/i }));
    expect(await screen.findByText("Failed")).toBeTruthy();
  });
});
