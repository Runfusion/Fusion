import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LinearImportView } from "../LinearImportView.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const issue = {
  id: "iss-1",
  identifier: "ENG-1",
  title: "Fix plugin import",
  description: "Linear body",
  url: "https://linear.app/acme/issue/ENG-1/fix-plugin-import",
  state: { name: "Todo", type: "unstarted" },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
  assignee: { id: "user-1", name: "Ada" },
  labels: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("LinearImportView", () => {
  it("renders missing-auth setup state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, authenticated: false, configured: false })));
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    expect(await screen.findByText(/Add a Linear API key/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Browse issues/i })).toBeDisabled();
  });

  it("renders desktop filters and calls plugin route with projectId", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, issues: [issue], pageInfo: { hasNextPage: false, endCursor: null } }));
    vi.stubGlobal("fetch", fetch);
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    await userEvent.type(screen.getByLabelText(/Search/i), "plugin");
    await userEvent.type(screen.getByLabelText(/Team key/i), "ENG");
    await userEvent.click(screen.getByRole("button", { name: /Browse issues/i }));
    await screen.findByText("Fix plugin import");
    expect(fetch.mock.calls[0][0]).toBe("/api/plugins/fusion-plugin-linear-import/status?projectId=proj-1");
    expect(fetch.mock.calls[1][0]).toBe("/api/plugins/fusion-plugin-linear-import/issues");
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toEqual(expect.objectContaining({ projectId: "proj-1", query: "plugin", teamKey: "ENG" }));
  });

  it("renders mobile/narrow controls without hidden focus traps", async () => {
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 390 });
    fireEvent(window, new Event("resize"));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ok: true, authenticated: true })));
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    expect(screen.getByLabelText(/Search/i)).toBeVisible();
    expect(screen.getByLabelText(/Team key/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /Browse issues/i })).toBeVisible();
  });

  it("shows empty results", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, issues: [], pageInfo: { hasNextPage: false, endCursor: null } })));
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    await userEvent.click(screen.getByRole("button", { name: /Browse issues/i }));
    expect(await screen.findByText(/No Linear issues matched/i)).toBeInTheDocument();
  });

  it("previews issue descriptions and imports one issue", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, issues: [issue], pageInfo: { hasNextPage: false, endCursor: null } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, imported: true, duplicate: false, taskId: "FN-8" }, 201));
    vi.stubGlobal("fetch", fetch);
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    await userEvent.click(screen.getByRole("button", { name: /Browse issues/i }));
    expect(await screen.findByText("Linear body")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Import previewed issue/i }));
    expect(await screen.findByText(/Imported ENG-1 as task FN-8/i)).toBeInTheDocument();
  });

  it("shows duplicate import response", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, issues: [issue], pageInfo: { hasNextPage: false, endCursor: null } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, imported: false, duplicate: true, taskId: "FN-2" })));
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    await userEvent.click(screen.getByRole("button", { name: /Browse issues/i }));
    await screen.findByText("Fix plugin import");
    await userEvent.click(screen.getByRole("button", { name: /Import previewed issue/i }));
    expect(await screen.findByText(/existing task FN-2/i)).toBeInTheDocument();
  });

  it("shows GraphQL error responses", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: "Linear GraphQL error: broken", code: "graphql_error" }, 400)));
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    await userEvent.click(screen.getByRole("button", { name: /Browse issues/i }));
    expect(await screen.findByText(/Linear GraphQL error: broken/i)).toBeInTheDocument();
  });

  it("imports selected issues", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, authenticated: true }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, issues: [issue], pageInfo: { hasNextPage: false, endCursor: null } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, imported: 1, duplicates: 0, results: [] })));
    render(<LinearImportView context={{ projectId: "proj-1" } as any} />);
    await screen.findByText("Linear connected");
    await userEvent.click(screen.getByRole("button", { name: /Browse issues/i }));
    await screen.findByText("Fix plugin import");
    await userEvent.click(screen.getByLabelText(/Select ENG-1/i));
    await waitFor(() => expect(screen.getByRole("button", { name: /Import selected/i })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /Import selected/i }));
    expect(await screen.findByText(/1 imported, 0 duplicates/i)).toBeInTheDocument();
  });
});
