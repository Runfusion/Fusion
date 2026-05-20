import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SecretsView } from "../SecretsView";

type JsonResponse = {
  ok: boolean;
  status?: number;
  body: unknown;
};

function mockJsonResponse({ ok, status = ok ? 200 : 400, body }: JsonResponse): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function expectVisibleEyeIcon(svg: SVGElement) {
  const style = getComputedStyle(svg);
  expect(svg).toBeInTheDocument();
  expect(svg.getAttribute("width")).toBeTruthy();
  expect(svg.getAttribute("height")).toBeTruthy();
  expect(style.display).toBe("block");
  expect(style.stroke).not.toBe("none");
}

describe("SecretsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders Not configured status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } })),
    );

    render(<SecretsView addToast={vi.fn()} />);

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("renders Configured status and clear button", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: true } })),
    );

    render(<SecretsView addToast={vi.fn()} />);

    expect(await screen.findByText("Configured")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear" })).toBeInTheDocument();
  });

  it("FN-5222: does not render a docs link in the cross-node sync card", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } })),
    );

    render(<SecretsView addToast={vi.fn()} />);

    await screen.findByText("Not configured");
    expect(screen.queryByRole("link", { name: "Learn more" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/docs/secrets.md"]')).toBeNull();
  });

  it("submitting matching passphrases issues PUT and re-fetches status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { success: true } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: true } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByText("Not configured");

    await userEvent.click(screen.getByRole("button", { name: "Set passphrase" }));
    const dialog = screen.getByRole("dialog", { name: "Set sync passphrase" });
    await userEvent.type(within(dialog).getByLabelText("Passphrase"), "shared-pass");
    await userEvent.type(within(dialog).getByLabelText("Confirm passphrase"), "shared-pass");
    await userEvent.click(within(dialog).getByRole("button", { name: "Set passphrase" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/secrets/sync-passphrase",
        expect.objectContaining({ method: "PUT" }),
      );
    });
    expect(await screen.findByText("Configured")).toBeInTheDocument();
  });

  it("mismatched confirmation disables submit and does not call PUT", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByText("Not configured");

    await userEvent.click(screen.getByRole("button", { name: "Set passphrase" }));
    const dialog = screen.getByRole("dialog", { name: "Set sync passphrase" });
    await userEvent.type(within(dialog).getByLabelText("Passphrase"), "a");
    await userEvent.type(within(dialog).getByLabelText("Confirm passphrase"), "b");

    const submitButton = within(dialog).getByRole("button", { name: "Set passphrase" });
    expect(submitButton).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clear button issues DELETE after confirmation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: true } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { success: true } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByText("Configured");

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/secrets/sync-passphrase",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  it("filters reserved key from main list", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            ok: true,
            body: {
              secrets: [
                { id: "1", key: "__sync_passphrase__", scope: "global", description: null, accessPolicy: "deny", envExportable: false, envExportKey: null, lastReadAt: null },
                { id: "2", key: "VISIBLE", scope: "project", description: null, accessPolicy: "prompt", envExportable: false, envExportKey: null, lastReadAt: null },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } })),
    );

    render(<SecretsView addToast={vi.fn()} />);

    expect(await screen.findByText("VISIBLE")).toBeInTheDocument();
    expect(screen.queryByText("__sync_passphrase__")).not.toBeInTheDocument();
  });

  it("renders a visible row reveal icon", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          mockJsonResponse({
            ok: true,
            body: {
              secrets: [
                { id: "secret-1", key: "VISIBLE", scope: "project", description: null, accessPolicy: "prompt", envExportable: false, envExportKey: null, lastReadAt: null },
              ],
            },
          }),
        )
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } })),
    );

    render(<SecretsView addToast={vi.fn()} />);

    const revealButton = await screen.findByRole("button", { name: "Reveal" });
    const svg = revealButton.querySelector("svg");
    expect(svg).not.toBeNull();
    expectVisibleEyeIcon(svg as SVGElement);
  });

  it("renders a visible modal value toggle icon", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } })),
    );

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByText("Not configured");

    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));

    const toggleButton = screen.getByRole("button", { name: "Show value" });
    const svg = toggleButton.querySelector("svg");
    expect(svg).not.toBeNull();
    expectVisibleEyeIcon(svg as SVGElement);
  });
});
