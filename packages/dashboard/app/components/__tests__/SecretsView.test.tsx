import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { loadAllAppCss } from "../../test/cssFixture";
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

function installAllCss() {
  const style = document.createElement("style");
  style.setAttribute("data-test-all-app-css", "true");
  style.textContent = loadAllAppCss();
  document.head.appendChild(style);
}

function removeAllCss() {
  document.head.querySelector('[data-test-all-app-css="true"]')?.remove();
}

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function mockClipboardFallback(result: boolean) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
  const execCommand = vi.fn().mockReturnValue(result);
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return execCommand;
}

function restoreClipboardMocks() {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  Object.defineProperty(document, "execCommand", { configurable: true, value: originalExecCommand });
}

function expectVisibleActionIcon(button: HTMLElement) {
  const svg = button.querySelector("svg");
  expect(svg).not.toBeNull();
  const svgStyle = getComputedStyle(svg as SVGElement);
  const buttonStyle = getComputedStyle(button);
  expect(svg).toHaveClass("secrets-action-icon");
  expect(Number.parseFloat(svgStyle.width)).toBeGreaterThan(0);
  expect(Number.parseFloat(svgStyle.height)).toBeGreaterThan(0);
  expect(svgStyle.display).toBe("block");
  expect(svgStyle.stroke.toLowerCase()).not.toBe("none");
  expect(svgStyle.stroke).not.toBe(buttonStyle.backgroundColor);
}

// FNXC:Secrets 2026-06-23-01:30: The cross-node sync passphrase status/actions now live behind a collapsed-by-default
// disclosure below the secrets list, so tests must click the toggle before the status text / Set passphrase / Clear
// controls become visible.
async function expandPassphraseDisclosure() {
  await userEvent.click(screen.getByTestId("secrets-passphrase-disclosure"));
}

describe("SecretsView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.dataset.theme = "dark";
    installAllCss();
  });

  afterEach(() => {
    restoreClipboardMocks();
    removeAllCss();
    delete document.documentElement.dataset.theme;
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

    await expandPassphraseDisclosure();
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

    await expandPassphraseDisclosure();
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

    await expandPassphraseDisclosure();
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
    await expandPassphraseDisclosure();
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
    await expandPassphraseDisclosure();
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
    await expandPassphraseDisclosure();
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

  it.each(["dark", "light"] as const)("keeps header and row action icons visible in %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;

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
    await screen.findByText("VISIBLE");

    expectVisibleActionIcon(screen.getByRole("button", { name: "Refresh" }));
    expectVisibleActionIcon(screen.getByRole("button", { name: "Add Secret" }));
    expectVisibleActionIcon(screen.getByRole("button", { name: "Reveal" }));
    expectVisibleActionIcon(screen.getByRole("button", { name: "Copy" }));
    expectVisibleActionIcon(screen.getByRole("button", { name: "Edit" }));
    expectVisibleActionIcon(screen.getByRole("button", { name: "Delete" }));
  });

  it("copies revealed secrets through the execCommand fallback when Clipboard API is unavailable", async () => {
    const execCommand = mockClipboardFallback(true);
    const addToast = vi.fn();
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
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { key: "VISIBLE", value: "super-secret-value" } })),
    );

    render(<SecretsView addToast={addToast} />);
    await screen.findByText("VISIBLE");
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("super-secret-value")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Copied", "success");
    expect(screen.getByRole("button", { name: "Copy" }).querySelector(".lucide-check")).toBeInTheDocument();
  });

  it("shows a failure toast without marking a secret copied when both clipboard paths fail", async () => {
    const execCommand = mockClipboardFallback(false);
    const addToast = vi.fn();
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
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { key: "VISIBLE", value: "super-secret-value" } })),
    );

    render(<SecretsView addToast={addToast} />);
    await screen.findByText("VISIBLE");
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("super-secret-value")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(addToast).toHaveBeenCalledWith("Failed to copy secret", "error");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("revealed secret can be hidden again from the row toggle", async () => {
    const fetchMock = vi
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
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { key: "VISIBLE", value: "super-secret-value" } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByText("VISIBLE");

    const revealButton = screen.getByRole("button", { name: "Reveal" });
    const copyButton = screen.getByRole("button", { name: "Copy" });
    expect(copyButton).toBeDisabled();

    await userEvent.click(revealButton);

    expect(await screen.findByText("super-secret-value")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide" })).toBeInTheDocument();
    expect(copyButton).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Hide" }));

    await waitFor(() => {
      expect(screen.queryByText("super-secret-value")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Reveal" })).toBeInTheDocument();
    expect(copyButton).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each(["dark", "light"] as const)("keeps the modal value toggle icon visible in %s theme", async (theme) => {
    document.documentElement.dataset.theme = theme;

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
        .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } })),
    );

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByTestId("secrets-passphrase-disclosure");

    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));
    expectVisibleActionIcon(screen.getByRole("button", { name: "Show value" }));
  });
});
