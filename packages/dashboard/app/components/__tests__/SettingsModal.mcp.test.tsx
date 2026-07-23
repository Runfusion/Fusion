import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, cleanup } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { GlobalSettings, McpServerDefinition, Settings } from "@fusion/core";
import { GlobalMcpSection } from "../settings/sections/GlobalMcpSection";
import { ProjectMcpSection } from "../settings/sections/ProjectMcpSection";
import { McpServersCard, type McpSettingsScope } from "../settings/sections/McpServersCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, values?: Record<string, string | number>) => {
      if (!values) return fallback;
      return Object.entries(values).reduce((text, [key, value]) => text.replace(`{{${key}}}`, String(value)), fallback);
    },
  }),
}));

const secret = {
  id: "secret-token",
  scope: "project" as const,
  key: "TOKEN",
  description: null,
  accessPolicy: "prompt" as const,
  envExportable: false,
  envExportKey: null,
  lastReadAt: null,
};

function discoveredResponse(scope: McpSettingsScope) {
  return {
    sources: [{ id: `${scope}-source`, tool: scope === "global" ? "Claude Desktop" : "VS Code", label: scope === "global" ? "Claude Desktop" : "VS Code project", scope, path: scope === "global" ? "/home/ada/claude.json" : "/repo/.vscode/mcp.json" }],
    servers: [
      { source: { id: `${scope}-source`, tool: scope === "global" ? "Claude Desktop" : "VS Code", label: scope === "global" ? "Claude Desktop" : "VS Code project", scope, path: "config.json" }, definition: { name: `${scope}-plain`, transport: "stdio", command: "plain-mcp" }, alreadyConfigured: false, hasPlaintextSecrets: false, secretDescriptors: [] },
      { source: { id: `${scope}-source`, tool: scope === "global" ? "Claude Desktop" : "VS Code", label: scope === "global" ? "Claude Desktop" : "VS Code project", scope, path: "config.json" }, definition: { name: `${scope}-secure`, transport: "stdio", command: "secure-mcp", env: { TOKEN: { secretRef: `mcp.${scope}-secure.env.TOKEN`, scope } } }, alreadyConfigured: false, hasPlaintextSecrets: true, secretDescriptors: [{ field: "env", key: "TOKEN", suggestedKey: `mcp.${scope}-secure.env.TOKEN`, scope }] },
      { source: { id: `${scope}-source`, tool: scope === "global" ? "Claude Desktop" : "VS Code", label: scope === "global" ? "Claude Desktop" : "VS Code project", scope, path: "config.json" }, definition: { name: `${scope}-configured`, transport: "stdio", command: "configured-mcp" }, alreadyConfigured: true, hasPlaintextSecrets: false, secretDescriptors: [] },
    ],
    errors: [`${scope} source: skipped malformed config`],
  };
}

function mockFetch(statusByName: Record<string, { status: "valid" | "unreachable" | "error"; message: string }> = {}, discoveryByScope?: Partial<Record<McpSettingsScope, unknown>>, pluginServers: unknown[] = []) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/mcp/plugin-servers")) {
      return new Response(JSON.stringify({ servers: pluginServers }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith("/api/mcp/discovered")) {
      const scope = (new URL(url, "https://fusion.test").searchParams.get("scope") === "global" ? "global" : "project") as McpSettingsScope;
      return new Response(JSON.stringify(discoveryByScope?.[scope] ?? { sources: [], servers: [], errors: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/secrets" && (!init?.method || init.method === "GET")) {
      return new Response(JSON.stringify({ secrets: [secret] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/secrets" && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { key?: string; scope?: "project" | "global" };
      return new Response(JSON.stringify({ ...secret, id: `created-${body.key ?? "secret"}`, key: body.key ?? "TOKEN", scope: body.scope ?? "project" }), { status: 201, headers: { "Content-Type": "application/json" } });
    }
    if (url === "/api/mcp/validate") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { server?: { name?: string } };
      const name = body.server?.name ?? "default";
      const result = statusByName[name] ?? { status: "valid" as const, message: "ok" };
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: `Unhandled ${url}` }), { status: 500, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function expectButtonIconSize(button: HTMLElement, size: "14" | "16") {
  const icon = button.querySelector("svg");
  expect(icon).toBeInTheDocument();
  expect(icon).toHaveAttribute("width", size);
  expect(icon).toHaveAttribute("height", size);
}

function renderCard(options: { scope: McpSettingsScope; form?: Settings; globalSettings?: Pick<GlobalSettings, "mcpServers"> | null; pluginServers?: Array<{ pluginId: string; server: { name: string; transport: "stdio"; command: string; enabledByDefault?: boolean } }> }) {
  let currentForm: Settings = options.form ?? ({} as Settings);
  const addToast = vi.fn();
  function Harness() {
    const [form, setFormState] = useState<Settings>(currentForm);
    currentForm = form;
    return (
      <McpServersCard
        scope={options.scope}
        form={form}
        globalSettings={options.globalSettings}
        pluginServers={options.pluginServers}
        addToast={addToast}
        setForm={(next) => {
          setFormState((previous) => {
            const resolved = typeof next === "function" ? next(previous) : next;
            currentForm = resolved;
            return resolved;
          });
        }}
      />
    );
  }
  const result = render(<Harness />);
  return { ...result, addToast, getForm: () => currentForm };
}

async function addServer(name: string, transport: "stdio" | "sse" | "streamable-http") {
  fireEvent.click(screen.getByRole("button", { name: /Add server/i }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Transport"), { target: { value: transport } });
  if (transport === "stdio") {
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "node" } });
    fireEvent.click(screen.getByRole("button", { name: /Add secret reference/i }));
    fireEvent.change(screen.getByLabelText("Sensitive field name"), { target: { value: "API_TOKEN" } });
    fireEvent.change(screen.getByLabelText("Secret reference"), { target: { value: "project:secret-token" } });
  } else {
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: `https://${name}.example.test/mcp` } });
    fireEvent.click(screen.getByRole("button", { name: /Add secret reference/i }));
    fireEvent.change(screen.getByLabelText("Sensitive field name"), { target: { value: "Authorization" } });
    fireEvent.change(screen.getByLabelText("Secret reference"), { target: { value: "project:secret-token" } });
  }
  fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
  await screen.findByTestId(`mcp-server-row-${name}`);
}

beforeEach(() => {
  mockFetch();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("768px"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MCP Settings UI", () => {
  it("renders global and project MCP section affordances without a new lazy view", async () => {
    render(<GlobalMcpSection form={{} as Settings} setForm={vi.fn()} addToast={vi.fn()} />);
    expect(await screen.findByTestId("mcp-servers-card-global")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add server/i })).toBeInTheDocument();
    cleanup();

    render(<ProjectMcpSection form={{} as Settings} setForm={vi.fn()} globalSettings={{ mcpServers: { enabled: true, servers: [] } }} addToast={vi.fn()} />);
    expect(await screen.findByTestId("mcp-servers-card-project")).toBeInTheDocument();
    expect(screen.getByText("No MCP servers configured.")).toBeInTheDocument();
  });

  it("loads active-project plugin servers into the project MCP card", async () => {
    mockFetch({}, undefined, [{ pluginId: "roslyn", server: { name: "navigator", transport: "stdio", command: "plugin-command" } }]);
    render(<ProjectMcpSection form={{ mcpServers: { enabled: true, servers: [] } } as Settings} setForm={vi.fn()} globalSettings={{ mcpServers: { enabled: true, servers: [] } }} projectId="project-a" addToast={vi.fn()} />);

    const row = await screen.findByTestId("mcp-server-row-navigator");
    expect(row).toHaveTextContent("plugin-command");
    expect(screen.getByTestId("mcp-plugin-provenance-navigator")).toHaveTextContent("plugin:roslyn");
  });

  it.each(["global", "project"] as const)("sizes MCP card inline button icons in %s scope", async (scope) => {
    mockFetch({}, { [scope]: discoveredResponse(scope) });
    renderCard({
      scope,
      form: { mcpServers: { enabled: true, servers: [{ name: `${scope}-local`, transport: "stdio", command: "node" }] } } as Settings,
      globalSettings: scope === "project" ? { mcpServers: { enabled: true, servers: [{ name: "shared", transport: "stdio", command: "node" }] } } : undefined,
    });

    expectButtonIconSize(screen.getByRole("button", { name: /Add server/i }), "16");
    const discovery = await screen.findByTestId(`mcp-discovery-${scope}`);
    expectButtonIconSize(within(discovery).getByRole("button", { name: /Scan again/i }), "14");
    expectButtonIconSize(screen.getByRole("button", { name: /Upload JSON/i }), "14");
    expectButtonIconSize(screen.getByRole("button", { name: /Copy Fusion MCP JSON/i }), "14");

    const localRow = await screen.findByTestId(`mcp-server-row-${scope}-local`);
    expectButtonIconSize(within(localRow).getByRole("button", { name: /Test/i }), "14");
    expectButtonIconSize(within(localRow).getByRole("button", { name: /^Edit$/i }), "14");
    if (scope === "project") {
      const inheritedRow = await screen.findByTestId("mcp-server-row-shared");
      expectButtonIconSize(within(inheritedRow).getByRole("button", { name: /Override/i }), "14");
    }

    fireEvent.click(screen.getByRole("button", { name: /Add server/i }));
    const editor = await screen.findByTestId("mcp-server-editor");
    expectButtonIconSize(within(editor).getByRole("button", { name: /Add secret reference/i }), "14");
  });

  it.each(["stdio", "sse", "streamable-http"] as const)("adds, edits, and removes a %s server without plaintext secrets", async (transport) => {
    const { getForm } = renderCard({ scope: "project", form: {} as Settings });
    await screen.findByText("No MCP servers configured.");

    await addServer(`${transport}-server`, transport);
    const added = getForm().mcpServers?.servers?.[0];
    expect(added?.transport).toBe(transport);
    expect(JSON.stringify(added)).toContain("secret-token");
    expect(JSON.stringify(added)).not.toContain("super-secret");

    fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: `${transport}-renamed` } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await screen.findByTestId(`mcp-server-row-${transport}-renamed`);

    fireEvent.click(screen.getByRole("button", { name: `Remove ${transport}-renamed` }));
    await waitFor(() => expect(screen.queryByTestId(`mcp-server-row-${transport}-renamed`)).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: `Remove ${transport}-renamed` })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Add server/i }));
    expect(screen.getByTestId("mcp-server-editor")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/i }));
    expect(screen.queryByTestId("mcp-server-editor")).not.toBeInTheDocument();
  });

  it("marks inherited, overridden, project-local, and disabled-global states", async () => {
    const globalServers: McpServerDefinition[] = [
      { name: "shared", transport: "stdio", command: "node" },
      { name: "blocked", transport: "streamable-http", url: "https://blocked.example.test/mcp" },
    ];
    const { getForm } = renderCard({ scope: "project", form: {} as Settings, globalSettings: { mcpServers: { enabled: true, servers: globalServers } } });

    expect(await screen.findByTestId("mcp-server-row-shared")).toHaveTextContent("inherited");
    fireEvent.click(within(screen.getByTestId("mcp-server-row-shared")).getByRole("button", { name: /Override/i }));
    fireEvent.change(screen.getByLabelText("Command"), { target: { value: "python" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await waitFor(() => expect(screen.getByTestId("mcp-server-row-shared")).toHaveTextContent("overridden"));

    fireEvent.click(within(screen.getByTestId("mcp-server-row-blocked")).getByRole("button", { name: /Disable/i }));
    await waitFor(() => expect(screen.getByTestId("mcp-server-row-blocked")).toHaveTextContent("disabled global"));
    expect(getForm().mcpServers?.servers?.find((server) => server.name === "blocked")?.enabled).toBe(false);

    await addServer("local-only", "stdio");
    expect(screen.getByTestId("mcp-server-row-local-only")).toHaveTextContent("project local");
  });

  it("displays the plugin winner when plugin and global servers share a name", async () => {
    const { getForm } = renderCard({
      scope: "project",
      form: {} as Settings,
      globalSettings: { mcpServers: { enabled: true, servers: [{ name: "navigator", transport: "stdio", command: "global-command" }] } },
      pluginServers: [{ pluginId: "roslyn", server: { name: "navigator", transport: "stdio", command: "plugin-command" } }],
    });

    const row = await screen.findByTestId("mcp-server-row-navigator");
    expect(row).toHaveTextContent("plugin-command");
    expect(row).not.toHaveTextContent("global-command");
    expect(row).toHaveTextContent("plugin");
    expect(screen.getByTestId("mcp-plugin-provenance-navigator")).toHaveTextContent("plugin:roslyn");
    fireEvent.click(within(row).getByRole("button", { name: /Disable/i }));
    expect(getForm().mcpServers?.servers).toEqual([{ name: "navigator", enabled: false, transport: "stdio", command: "plugin-command" }]);
  });

  it("validates servers and renders valid, unreachable, and error status surfaces", async () => {
    mockFetch({
      ok: { status: "valid", message: "probe ok" },
      slow: { status: "unreachable", message: "timed out" },
      bad: { status: "error", message: "HTTP 503" },
    });
    renderCard({
      scope: "global",
      form: { mcpServers: { enabled: true, servers: [
        { name: "ok", transport: "stdio", command: "node" },
        { name: "slow", transport: "sse", url: "https://slow.example.test/sse" },
        { name: "bad", transport: "streamable-http", url: "https://bad.example.test/mcp" },
      ] } } as Settings,
    });

    for (const name of ["ok", "slow", "bad"]) {
      fireEvent.click(within(await screen.findByTestId(`mcp-server-row-${name}`)).getByRole("button", { name: /Test/i }));
    }
    await waitFor(() => expect(screen.getByTestId("mcp-validation-ok")).toHaveTextContent("probe ok"));
    expect(screen.getByTestId("mcp-validation-ok")).toHaveClass("mcp-validation-status--valid");
    expect(screen.getByTestId("mcp-validation-slow")).toHaveClass("mcp-validation-status--unreachable");
    expect(screen.getByTestId("mcp-validation-slow")).toHaveTextContent("timed out");
    expect(screen.getByTestId("mcp-validation-bad")).toHaveClass("mcp-validation-status--error");
    expect(screen.getByTestId("mcp-validation-bad")).toHaveTextContent("HTTP 503");
  });

  it("renders discovered MCP regions in both global and project cards", async () => {
    mockFetch({}, { global: discoveredResponse("global"), project: discoveredResponse("project") });
    render(<GlobalMcpSection form={{} as Settings} setForm={vi.fn()} addToast={vi.fn()} />);
    const globalDiscovery = await screen.findByTestId("mcp-discovery-global");
    expect(within(globalDiscovery).getByText("Discovered on this machine")).toBeInTheDocument();
    expect(within(globalDiscovery).getByText("global-plain")).toBeInTheDocument();
    cleanup();

    render(<ProjectMcpSection form={{} as Settings} setForm={vi.fn()} globalSettings={{ mcpServers: { enabled: true, servers: [] } }} addToast={vi.fn()} />);
    const projectDiscovery = await screen.findByTestId("mcp-discovery-project");
    expect(within(projectDiscovery).getByText("VS Code project")).toBeInTheDocument();
    expect(within(projectDiscovery).getByText("project source: skipped malformed config")).toBeInTheDocument();
  });

  it("adds discovered servers, opens secret binding for sensitive entries, and disables configured entries", async () => {
    mockFetch({}, { project: discoveredResponse("project") });
    const { getForm } = renderCard({
      scope: "project",
      form: { mcpServers: { enabled: false, servers: [{ name: "project-configured", transport: "stdio", command: "configured-mcp" }] } } as Settings,
    });

    const plainRow = await screen.findByTestId("mcp-discovery-row-project-project-source-project-plain");
    fireEvent.click(within(plainRow).getByRole("button", { name: /^Add$/i }));
    await waitFor(() => expect(screen.getByTestId("mcp-server-row-project-plain")).toBeInTheDocument());
    expect(getForm().mcpServers?.enabled).toBe(true);
    expect(getForm().mcpServers?.servers?.find((server) => server.name === "project-plain")).toMatchObject({ command: "plain-mcp" });

    const secureRow = screen.getByTestId("mcp-discovery-row-project-project-source-project-secure");
    fireEvent.click(within(secureRow).getByRole("button", { name: /^Add$/i }));
    expect(await screen.findByTestId("mcp-server-editor")).toBeInTheDocument();
    expect(screen.getByText(/Bind or create Fusion secret references/i)).toBeInTheDocument();
    expect(screen.getByText("Required")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove secret reference/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    expect(screen.getByText(/Bind or create Fusion secret references/i)).toBeInTheDocument();
    expect(getForm().mcpServers?.servers?.find((server) => server.name === "project-secure")).toBeUndefined();
    fireEvent.change(screen.getByLabelText("Secret reference"), { target: { value: "project:secret-token" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/i }));
    await screen.findByTestId("mcp-server-row-project-secure");
    const saved = JSON.stringify(getForm().mcpServers);
    expect(saved).toContain("secret-token");
    expect(saved).not.toContain("typed-secret");

    const configuredRow = screen.getByTestId("mcp-discovery-row-project-project-source-project-configured");
    expect(configuredRow).toHaveTextContent("Configured");
    expect(within(configuredRow).getByRole("button", { name: /^Configured$/i })).toBeDisabled();
  });

  it("renders empty discovery and mobile controls without empty button shells", async () => {
    mockFetch({}, { project: { sources: [], servers: [], errors: [] } });
    renderCard({ scope: "project", form: {} as Settings });
    const discovery = await screen.findByTestId("mcp-discovery-project");
    expect(within(discovery).getByText("No MCP servers found in supported tool configs yet.")).toBeInTheDocument();
    for (const button of within(discovery).getAllByRole("button")) {
      expect(button.textContent?.trim() || button.getAttribute("aria-label") || "").not.toBe("");
    }
  });

  it("imports Claude JSON through secret creation and exports Fusion JSON", async () => {
    const { getForm } = renderCard({ scope: "project", form: {} as Settings });
    const importPayload = JSON.stringify({
      mcpServers: {
        claude: { command: "node", args: ["server.js"], env: { API_TOKEN: "super-secret" } },
      },
    });
    fireEvent.change(screen.getByPlaceholderText("Paste Claude Desktop mcpServers JSON"), { target: { value: importPayload } });
    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }));

    await screen.findByTestId("mcp-server-row-claude");
    const saved = JSON.stringify(getForm().mcpServers);
    expect(saved).toContain("created-mcp.claude.env.API_TOKEN");
    expect(saved).not.toContain("super-secret");

    fireEvent.click(screen.getByRole("button", { name: /Copy Fusion MCP JSON/i }));
    const exported = await screen.findByLabelText("Exported MCP JSON");
    expect((exported as HTMLTextAreaElement).value).toContain("created-mcp.claude.env.API_TOKEN");
    expect((exported as HTMLTextAreaElement).value).not.toContain("super-secret");
    expect(screen.getByRole("link", { name: /Download JSON/i })).toHaveAttribute("download", "fusion-mcp-servers.json");

    fireEvent.change(screen.getByPlaceholderText("Paste Claude Desktop mcpServers JSON"), { target: { value: importPayload } });
    fireEvent.click(screen.getByRole("button", { name: /^Import$/i }));
    expect(await screen.findByText(/Duplicate MCP server name: claude/i)).toBeInTheDocument();
  });
});
