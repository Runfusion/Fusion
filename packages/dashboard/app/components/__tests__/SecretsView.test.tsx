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

/*
FNXC:Secrets 2026-07-30-10:10:
Read the DECLARED stroke for `.secrets-action-icon` out of the real stylesheet. jsdom cannot resolve
`currentColor`, so the declaration is the only place the paint source is observable in this
environment.
*/
function secretsActionIconStrokeDeclaration(): string | undefined {
  const css = loadAllAppCss();
  const rule = /\.secrets-action-icon\s*\{([^}]*)\}/.exec(css);
  return /stroke:\s*([^;]+);/.exec(rule?.[1] ?? "")?.[1]?.trim();
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
  /*
  FNXC:Secrets 2026-07-30-10:10 (greptile P2 — the colour check alone was not enough):
  Two halves, because neither is sufficient on its own and jsdom cannot resolve the paint directly.

  `SecretsView.css:227` declares `stroke: currentColor`, and jsdom does NOT resolve `currentColor` —
  `getComputedStyle().stroke` returns `rgba(0, 0, 0, 0)` for every icon. That is also the icon
  button's transparent background, so the ORIGINAL assertion (`stroke !== backgroundColor`) was two
  unresolved values matching each other rather than a visibility check.

  Comparing the resolved `color` fixes that, but on its own it would still pass if the rule regressed
  to `stroke: transparent`: the paint would be invisible while `color` stayed fine and
  `stroke !== "none"` also held (transparent is not none). So the paint SOURCE is asserted from the
  stylesheet — the rule must still take its stroke from `currentColor` — and the resolved `color`
  must differ from the button background. Together: the icon is painted in `color`, and `color` is
  not the button's own background.

  True pixel visibility remains the e2e screenshot suite's job.
  */
  expect(secretsActionIconStrokeDeclaration()).toBe("currentColor");
  expect(svgStyle.color).not.toBe(buttonStyle.backgroundColor);
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

  it("binds list and sync status requests to the selected project", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets: [] } }))
      .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SecretsView addToast={vi.fn()} projectId="proj A" />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/secrets?projectId=proj%20A", expect.anything());
      expect(fetchMock).toHaveBeenCalledWith("/api/secrets/sync-passphrase?projectId=proj%20A", expect.anything());
    });
  });

  it("drops stale project rows when project selection changes before a prior response resolves", async () => {
    let resolveA!: (response: Response) => void;
    let resolveB!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/secrets?projectId=proj_A") return new Promise<Response>((resolve) => { resolveA = resolve; });
      if (url === "/api/secrets?projectId=proj_B") return new Promise<Response>((resolve) => { resolveB = resolve; });
      if (url.includes("/sync-passphrase")) return Promise.resolve(mockJsonResponse({ ok: true, body: { configured: false } }));
      return Promise.resolve(mockJsonResponse({ ok: true, body: { secrets: [] } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<SecretsView addToast={vi.fn()} projectId="proj_A" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets?projectId=proj_A", expect.anything()));

    rerender(<SecretsView addToast={vi.fn()} projectId="proj_B" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets?projectId=proj_B", expect.anything()));
    expect(screen.queryByText("A_ONLY")).not.toBeInTheDocument();

    resolveB(mockJsonResponse({ ok: true, body: { secrets: [
      { id: "b", key: "B_ONLY", scope: "project", description: null, accessPolicy: "prompt", envExportable: false, envExportKey: null, lastReadAt: null },
      { id: "global", key: "SHARED", scope: "global", description: null, accessPolicy: "prompt", envExportable: false, envExportKey: null, lastReadAt: null },
    ] } }));
    expect(await screen.findByText("B_ONLY")).toBeInTheDocument();
    expect(screen.getByText("SHARED")).toBeInTheDocument();

    resolveA(mockJsonResponse({ ok: true, body: { secrets: [{ id: "a", key: "A_ONLY", scope: "project", description: null, accessPolicy: "prompt", envExportable: false, envExportKey: null, lastReadAt: null }] } }));
    await waitFor(() => expect(screen.getByText("B_ONLY")).toBeInTheDocument());
    expect(screen.queryByText("A_ONLY")).not.toBeInTheDocument();
  });

  it("does not let an A mutation completion close or clear B's secret draft", async () => {
    let resolveCreateA!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/secrets?projectId=proj_A" && method === "POST") return new Promise<Response>((resolve) => { resolveCreateA = resolve; });
      if (url.startsWith("/api/secrets?") && method === "GET") return Promise.resolve(mockJsonResponse({ ok: true, body: { secrets: [] } }));
      if (url.includes("/sync-passphrase") && method === "GET") return Promise.resolve(mockJsonResponse({ ok: true, body: { configured: false } }));
      return Promise.resolve(mockJsonResponse({ ok: true, body: { success: true } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(<SecretsView addToast={vi.fn()} projectId="proj_A" />);
    await screen.findByText("No secrets found.");
    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));
    let dialog = screen.getByRole("dialog", { name: "Add secret" });
    let inputs = within(dialog).getAllByRole("textbox");
    await userEvent.type(inputs[0]!, "A_PENDING");
    await userEvent.type(inputs[1]!, "a-value");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets?projectId=proj_A", expect.objectContaining({ method: "POST" })));

    rerender(<SecretsView addToast={vi.fn()} projectId="proj_B" />);
    await screen.findByText("No secrets found.");
    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));
    dialog = screen.getByRole("dialog", { name: "Add secret" });
    inputs = within(dialog).getAllByRole("textbox");
    await userEvent.type(inputs[0]!, "B_DRAFT");

    resolveCreateA(mockJsonResponse({ ok: true, status: 201, body: { id: "a", key: "A_PENDING" } }));
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "Add secret" })).getAllByRole("textbox")[0]).toHaveValue("B_DRAFT"));
  });

  it("binds create, update, reveal, delete, and sync mutations to the selected project", async () => {
    const projectId = "proj_actions";
    const baseUrl = `/api/secrets?projectId=${projectId}`;
    const row = { id: "secret-1", key: "VISIBLE", scope: "project" as const, description: null, accessPolicy: "prompt" as const, envExportable: false, envExportKey: null, lastReadAt: null };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === baseUrl && method === "GET") return Promise.resolve(mockJsonResponse({ ok: true, body: { secrets: [row] } }));
      if (url === baseUrl && method === "POST") return Promise.resolve(mockJsonResponse({ ok: true, status: 201, body: { ...row, id: "created", key: "CREATED" } }));
      if (url === "/api/secrets/sync-passphrase?projectId=proj_actions" && method === "GET") return Promise.resolve(mockJsonResponse({ ok: true, body: { configured: true } }));
      if (url === "/api/secrets/sync-passphrase?projectId=proj_actions" && method === "PUT") return Promise.resolve(mockJsonResponse({ ok: true, body: { success: true } }));
      if (url === "/api/secrets/sync-passphrase?projectId=proj_actions" && method === "DELETE") return Promise.resolve(mockJsonResponse({ ok: true, body: { success: true } }));
      if (url === "/api/secrets/project/secret-1?projectId=proj_actions" && method === "PATCH") return Promise.resolve(mockJsonResponse({ ok: true, body: row }));
      if (url === "/api/secrets/project/secret-1/reveal?projectId=proj_actions" && method === "POST") return Promise.resolve(mockJsonResponse({ ok: true, body: { key: row.key, value: "revealed-value" } }));
      if (url === "/api/secrets/project/secret-1?projectId=proj_actions" && method === "DELETE") return Promise.resolve(mockJsonResponse({ ok: true, status: 204, body: undefined }));
      return Promise.resolve(mockJsonResponse({ ok: false, body: { error: `Unhandled ${method} ${url}` } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<SecretsView addToast={vi.fn()} projectId={projectId} />);
    await screen.findByText("VISIBLE");

    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));
    let dialog = screen.getByRole("dialog", { name: "Add secret" });
    const createInputs = within(dialog).getAllByRole("textbox");
    await userEvent.type(createInputs[0]!, "CREATED");
    await userEvent.type(createInputs[1]!, "created-value");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(baseUrl, expect.objectContaining({ method: "POST" })));

    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    dialog = screen.getByRole("dialog", { name: "Edit secret" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets/project/secret-1?projectId=proj_actions", expect.objectContaining({ method: "PATCH" })));

    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    expect(await screen.findByText("revealed-value")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/secrets/project/secret-1/reveal?projectId=proj_actions", expect.objectContaining({ method: "POST" }));

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets/project/secret-1?projectId=proj_actions", expect.objectContaining({ method: "DELETE" })));

    await expandPassphraseDisclosure();
    await screen.findByText("Configured");
    await userEvent.click(screen.getByRole("button", { name: "Rotate" }));
    dialog = screen.getByRole("dialog", { name: "Rotate sync passphrase" });
    const passphraseInputs = dialog.querySelectorAll("input");
    await userEvent.type(passphraseInputs[0]!, "new-passphrase");
    await userEvent.type(passphraseInputs[1]!, "new-passphrase");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets/sync-passphrase?projectId=proj_actions", expect.objectContaining({ method: "PUT" })));

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/secrets/sync-passphrase?projectId=proj_actions", expect.objectContaining({ method: "DELETE" })));
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
