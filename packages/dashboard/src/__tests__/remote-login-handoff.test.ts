// @vitest-environment node

import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_GLOBAL_SETTINGS, GlobalSettingsStore, type Settings, type TaskStore } from "@fusion/core";
import { createServer } from "../server.js";
import { request } from "../test-request.js";

const daemonToken = "fn_test_daemon_token";

function remoteAccess(token: string) {
  return {
    ...DEFAULT_GLOBAL_SETTINGS.remoteAccess,
    activeProvider: "cloudflare" as const,
    providers: {
      ...DEFAULT_GLOBAL_SETTINGS.remoteAccess.providers,
      cloudflare: {
        ...DEFAULT_GLOBAL_SETTINGS.remoteAccess.providers.cloudflare,
        enabled: true,
        ingressUrl: "https://remote.example.test",
      },
    },
    tokenStrategy: {
      ...DEFAULT_GLOBAL_SETTINGS.remoteAccess.tokenStrategy,
      persistent: {
        ...DEFAULT_GLOBAL_SETTINGS.remoteAccess.tokenStrategy.persistent,
        enabled: true,
        token,
      },
    },
  };
}

class RemoteLoginStore extends EventEmitter {
  constructor(private readonly globalSettings: GlobalSettingsStore) { super(); }
  getRootDir() { return process.cwd(); }
  getFusionDir() { return `${process.cwd()}/.fusion`; }
  getSettings = vi.fn(async (): Promise<Settings> => this.globalSettings.getSettings() as Promise<Settings>);
  getSettingsFast = this.getSettings;
  updateGlobalSettings = vi.fn(async (patch: Record<string, unknown>) => this.globalSettings.updateSettings(patch));
  getGlobalSettingsStore = () => this.globalSettings;
  getAsyncLayer = vi.fn(() => ({ db: { update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn(async () => []) })) })) })) } }));
  getProjectScopedPluginMcpServers = vi.fn().mockResolvedValue([]);
  getTaskWorkflowSelection = vi.fn();
  getWorkflowDefinition = vi.fn(async () => undefined);
  getWorkflowSettingValues = vi.fn(() => ({}));
  getWorkflowSettingsProjectId = vi.fn(() => "remote-login-handoff");
}

async function apiRequest(app: ReturnType<typeof createServer>, method: string, path: string, body?: unknown) {
  return request(
    app,
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
    {
      Authorization: `Bearer ${daemonToken}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
  );
}

function createInertOptions() {
  return {
    chatStore: Object.assign(new EventEmitter(), { deleteSessionsForAgentId: vi.fn().mockResolvedValue(undefined) }) as never,
    aiSessionStore: Object.assign(new EventEmitter(), {
      recoverStaleSessions: vi.fn().mockResolvedValue(undefined), rehydrateFromStore: vi.fn().mockResolvedValue(0),
      stopScheduledCleanup: vi.fn(), cleanupStaleSessions: vi.fn().mockResolvedValue({ terminalDeleted: 0, orphanedDeleted: 0 }),
    }) as never,
  };
}

function tokenFromLoginUrl(value: unknown): string {
  return new URL((value as { url: string }).url).searchParams.get("rt")!;
}

async function bootRemoteServer(input: {
  token?: string;
  daemon?: { token: string };
  useEnvironmentToken?: boolean;
  noAuth?: boolean;
  activeProvider?: "cloudflare" | "tailscale";
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fusion-remote-login-"));
  const settings = new GlobalSettingsStore(dir);
  await settings.init();
  const configured = remoteAccess(input.token ?? "seed-token");
  if (input.activeProvider === "tailscale") {
    configured.activeProvider = "tailscale";
    configured.providers.tailscale = {
      ...configured.providers.tailscale,
      enabled: true,
      hostname: "remote.example.test",
    };
  }
  await settings.updateSettings({ remoteAccess: configured });
  const app = createServer(new RemoteLoginStore(settings) as unknown as TaskStore, {
    ...(input.noAuth ? { noAuth: true } : input.useEnvironmentToken ? {} : { daemon: input.daemon ?? { token: daemonToken } }),
    ...createInertOptions(),
  });
  return { app, dir, settings };
}

/*
FNXC:RemoteAuth 2026-08-23-23:45:
A validated remote login must redirect to bare "/" and deliver an expiring HttpOnly remote-session cookie. It must NEVER put the daemon token in the redirect URL: that handed every recipient of a shared link the dashboard's real non-expiring credential (URL bar, history, any URL log) and made revoking the remote token useless (fix(security) 0e7c353f2b). These assertions previously encoded the pre-fix `/?token=<daemonToken>` handoff.
*/
function expectSessionHandoff(response: { status: number; headers: Record<string, unknown> }): void {
  expect(response.status).toBe(302);
  expect(response.headers.location).toBe("/");
  const setCookie = String(response.headers["set-cookie"] ?? "");
  expect(setCookie).toContain("fusion_remote_session=");
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).not.toContain(daemonToken);
}

describe("remote-login global settings handoff", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  it("accepts remote URLs minted by URL, QR, and login-url routes", async () => {
    const { app, dir } = await bootRemoteServer({ token: "" });
    dirs.push(dir);

    const url = await apiRequest(app, "GET", "/api/remote/url");
    const qr = await apiRequest(app, "GET", "/api/remote/qr");
    const loginUrl = await apiRequest(app, "POST", "/api/remote-access/auth/login-url", { mode: "persistent" });
    for (const payload of [url.body, qr.body, { url: (loginUrl.body as { loginUrl: string }).loginUrl }]) {
      const handoff = await request(app, "GET", `/remote-login?rt=${tokenFromLoginUrl(payload)}`);
      expectSessionHandoff(handoff as never);
    }
  });

  it("accepts a regenerated token and rejects its rotated-away predecessor", async () => {
    const { app, dir } = await bootRemoteServer({ token: "old-token" });
    dirs.push(dir);

    const regenerated = await apiRequest(app, "POST", "/api/remote/token/persistent/regenerate", {});
    const nextToken = (regenerated.body as { token: string }).token;
    expect((await request(app, "GET", `/remote-login?rt=${nextToken}`)).status).toBe(302);
    const old = await request(app, "GET", "/remote-login?rt=old-token");
    expect(old.status).toBe(401);
    expect(old.body).toEqual({ error: "Unauthorized", code: "remote_token_invalid" });
  });

  it("keeps a minted token through remote panel saves and provider activation", async () => {
    const { app, dir, settings } = await bootRemoteServer({ token: "minted-token" });
    dirs.push(dir);
    const initial = await settings.getSettings();
    await settings.updateSettings({
      remoteAccess: {
        ...initial.remoteAccess!,
        providers: { ...initial.remoteAccess!.providers, tailscale: { ...initial.remoteAccess!.providers.tailscale, enabled: true } },
      },
    });

    expect((await apiRequest(app, "PUT", "/api/remote/settings", { remoteShortLivedEnabled: true })).status).toBe(200);
    expect((await apiRequest(app, "POST", "/api/remote/provider/activate", { provider: "tailscale" })).status).toBe(200);
    const handoff = await request(app, "GET", "/remote-login?rt=minted-token");
    expect(handoff.status).toBe(302);
  });

  it("handles short-lived, missing, disabled, no-auth, and environment-daemon handoffs", async () => {
    const { app, dir, settings } = await bootRemoteServer({ token: "persistent-token" });
    dirs.push(dir);
    const initial = await settings.getSettings();
    await settings.updateSettings({ remoteAccess: { ...initial.remoteAccess!, tokenStrategy: { ...initial.remoteAccess!.tokenStrategy, shortLived: { ...initial.remoteAccess!.tokenStrategy.shortLived, enabled: true } } } });
    const shortLived = await apiRequest(app, "POST", "/api/remote/token/short-lived/generate", { ttlMs: 60_000 });
    const token = (shortLived.body as { token: string }).token;
    expect((await request(app, "GET", `/remote-login?rt=${token}`)).status).toBe(302);
    vi.useFakeTimers();
    vi.advanceTimersByTime(60_001);
    const expired = await request(app, "GET", `/remote-login?rt=${token}`);
    vi.useRealTimers();
    expect(expired.body).toEqual({ error: "Unauthorized", code: "remote_token_expired" });
    expect((await request(app, "GET", "/remote-login")).body).toEqual({ error: "Unauthorized", code: "remote_token_missing" });

    const configured = await settings.getSettings();
    await settings.updateSettings({ remoteAccess: { ...configured.remoteAccess!, tokenStrategy: { ...configured.remoteAccess!.tokenStrategy, persistent: { ...configured.remoteAccess!.tokenStrategy.persistent, enabled: false } } } });
    expect((await request(app, "GET", "/remote-login?rt=persistent-token")).body).toEqual({ error: "Unauthorized", code: "remote_token_invalid" });
    const disabled = await settings.getSettings();
    await settings.updateSettings({ remoteAccess: { ...disabled.remoteAccess!, providers: { ...disabled.remoteAccess!.providers, cloudflare: { ...disabled.remoteAccess!.providers.cloudflare, enabled: false } } } });
    expect((await request(app, "GET", "/remote-login?rt=persistent-token")).body).toEqual({ error: "Unauthorized", code: "remote_token_invalid" });

    const noAuth = await bootRemoteServer({ token: "no-auth-token", noAuth: true });
    dirs.push(noAuth.dir);
    expect((await request(noAuth.app, "GET", "/remote-login?rt=no-auth-token")).headers.location).toBe("/");

    const previous = process.env.FUSION_DAEMON_TOKEN;
    process.env.FUSION_DAEMON_TOKEN = "environment-daemon-token";
    try {
      const env = await bootRemoteServer({ token: "env-token", useEnvironmentToken: true });
      dirs.push(env.dir);
      const envHandoff = await request(env.app, "GET", "/remote-login?rt=env-token");
      expect(envHandoff.headers.location).toBe("/");
      expect(String(envHandoff.headers["set-cookie"] ?? "")).toContain("fusion_remote_session=");
      expect(String(envHandoff.headers["set-cookie"] ?? "")).not.toContain("environment-daemon-token");
    } finally {
      if (previous === undefined) delete process.env.FUSION_DAEMON_TOKEN;
      else process.env.FUSION_DAEMON_TOKEN = previous;
    }
  });

  it("accepts a token rotated through a separately cached global settings store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fusion-remote-login-"));
    dirs.push(dir);
    const serverSettings = new GlobalSettingsStore(dir);
    const routeSettings = new GlobalSettingsStore(dir);
    await serverSettings.init();
    await serverSettings.updateSettings({ remoteAccess: remoteAccess("old-token") });
    await serverSettings.getSettings();
    await routeSettings.updateSettings({ remoteAccess: remoteAccess("new-token") });

    /*
    FNXC:RemoteAccessAuth 2026-08-18-06:49:
    A token minted by a remote-access surface must authenticate in this process
    even when the server TaskStore primed its own global-settings cache first.
    */
    const app = createServer(new RemoteLoginStore(serverSettings) as unknown as TaskStore, { daemon: { token: daemonToken }, ...createInertOptions() });
    const response = await request(app, "GET", "/remote-login?rt=new-token");

    expectSessionHandoff(response as never);
  });

  it("rate-limits the 31st cloudTicket request before redeeming", async () => {
    const previous = process.env.FUSION_CLOUD_HTTP_URL;
    process.env.FUSION_CLOUD_HTTP_URL = "https://cloud.example.convex.site";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ engineId: "eng_1", userId: "user_1", localSessionToken: "sess" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { app, dir } = await bootRemoteServer();
      dirs.push(dir);
      for (let i = 0; i < 30; i++) {
        await request(app, "GET", "/remote-login?cloudTicket=jti.secret");
      }
      const blocked = await request(app, "GET", "/remote-login?cloudTicket=jti.secret");
      expect(blocked.status).toBe(429);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(30);
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.FUSION_CLOUD_HTTP_URL;
      else process.env.FUSION_CLOUD_HTTP_URL = previous;
    }
  });

  it("redeems a cloud ticket without putting credentials in Location", async () => {
    const previous = process.env.FUSION_CLOUD_HTTP_URL;
    process.env.FUSION_CLOUD_HTTP_URL = "https://cloud.example.convex.site";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ engineId: "eng_1", userId: "user_1", localSessionToken: "sess" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    try {
      const { app, dir } = await bootRemoteServer();
      dirs.push(dir);
      const handoff = await request(app, "GET", "/remote-login?cloudTicket=jti.secret");
      expect(handoff.status).toBe(302);
      expect(handoff.headers.location).toBe("/");
      expect(handoff.headers.location).not.toMatch(/token=/);
      const cookie = handoff.headers["set-cookie"];
      const cookieValue = Array.isArray(cookie) ? cookie.join(";") : String(cookie ?? "");
      expect(cookieValue).toMatch(/HttpOnly/i);
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.FUSION_CLOUD_HTTP_URL;
      else process.env.FUSION_CLOUD_HTTP_URL = previous;
    }
  });
});
