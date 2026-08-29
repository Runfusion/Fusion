// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CliPrintingPressManageView } from "../manage-view";
import type { ServiceDraft } from "../wizard/types";

vi.mock("lucide-react", () => ({
  List: () => null,
  Pencil: () => null,
  RefreshCw: () => null,
  Trash2: () => null,
  Play: () => null,
  CheckCircle2: () => null,
  AlertTriangle: () => null,
}));

function makeDraft(id: string, name = "Demo"): ServiceDraft {
  const now = new Date().toISOString();
  return {
    id,
    name,
    slug: id,
    description: "",
    baseUrl: `https://${id}.example.com`,
    transport: "http",
    endpoints: [{ id: `${id}-e1`, name: "Ping", method: "GET", path: "/ping" }],
    credential: { kind: "none" },
    createdAt: now,
    updatedAt: now,
  };
}

describe("CliPrintingPressManageView", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders empty state", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
    render(<CliPrintingPressManageView />);
    expect(await screen.findByText(/No saved drafts yet/i)).toBeTruthy();
  });

  it("renders list, detail, edit/save, regenerate, and delete", async () => {
    const draft1 = makeDraft("draft-1", "Draft One");
    const draft2 = makeDraft("draft-2", "Draft Two");
    const updated = { ...draft1, name: "Draft One Edited" };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "GET" && url.endsWith("/drafts")) {
        return { ok: true, json: async () => ([
          { id: draft1.id, name: draft1.name, slug: draft1.slug, updatedAt: draft1.updatedAt },
          { id: draft2.id, name: draft2.name, slug: draft2.slug, updatedAt: draft2.updatedAt },
        ]) };
      }
      if (method === "GET" && url.endsWith(`/drafts/${draft1.id}`)) return { ok: true, json: async () => draft1 };
      if (method === "GET" && url.endsWith(`/drafts/${draft2.id}`)) return { ok: true, json: async () => draft2 };
      if (method === "PUT" && url.endsWith(`/drafts/${draft1.id}`)) return { ok: true, json: async () => updated };
      if (method === "POST" && url.endsWith(`/drafts/${draft1.id}/regenerate`)) {
        const generatedAt = new Date().toISOString();
        return { ok: true, json: async () => ({ draft: { ...updated, regeneratedAt: generatedAt, generatedAt, artifactPath: "/tmp/demo.mjs" }, artifact: { draftId: draft1.id, slug: draft1.slug, binPath: "/tmp/demo.mjs", entrypoint: "node", generatedAt } }) };
      }
      if (method === "DELETE" && url.endsWith(`/drafts/${draft1.id}`)) return { ok: true, status: 204, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({ error: "Not found" }) };
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    const user = userEvent.setup();
    render(<CliPrintingPressManageView />);

    expect(await screen.findByText("Draft One")).toBeTruthy();
    expect(screen.getByText("Draft Two")).toBeTruthy();
    expect(await screen.findByText(/Base URL:/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Edit/i }));
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Draft One Edited");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/drafts/${draft1.id}`), expect.objectContaining({ method: "PUT" })));

    await user.click(screen.getByRole("button", { name: /^Regenerate$/i }));
    expect(await screen.findByText(/Regenerated at/i)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Delete/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/drafts/${draft1.id}`), expect.objectContaining({ method: "DELETE" })));
  });
});
