// @vitest-environment node

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, expect, it } from "vitest";
import type { TaskStore } from "@fusion/core";
import { createTaskStoreForTest, pgDescribe } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { buildViewPreloadInjection, createServer } from "../server.js";
import { createLoopbackIntegrationTest } from "./loopback-integration-test.js";

const serverViewPreloadIntegrationTest = await createLoopbackIntegrationTest("server-view-preload integration");

let tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

type AppendedLink = {
  rel?: string;
  href?: string;
  crossOrigin?: string;
};

function runPreloadBootstrap(injection: string, taskView: string, projectId?: string): AppendedLink[] {
  const script = injection.match(/^<script>([\s\S]*)<\/script>$/)?.[1];
  if (!script) throw new Error("Missing preload bootstrap script");

  const appendedLinks: AppendedLink[] = [];
  const storage = new Map<string, string>([["kb-dashboard-task-view", taskView]]);
  if (projectId) {
    storage.set("kb-dashboard-current-project", projectId);
    storage.set(`kb:${projectId}:kb-dashboard-task-view`, taskView);
  }

  const context = {
    window: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
    },
    document: {
      head: {
        appendChild: (link: AppendedLink) => appendedLinks.push(link),
      },
      createElement: () => ({}),
    },
  };
  vm.runInNewContext(script, context);
  return appendedLinks;
}

async function startServerWithFixture(clientDir: string) {
  // FNXC:PostgresCutover 2026-07-16-06:50: preload integration starts the
  // real server against an isolated async TaskStore, never a retired SQLite store.
  const harness = await createTaskStoreForTest();
  const store = harness.store;

  const previousClientDir = process.env.FUSION_CLIENT_DIR;
  process.env.FUSION_CLIENT_DIR = clientDir;

  // FNXC:PostgresCutover 2026-07-16-07:30: preload tests exercise static HTML
  // injection, not AI-session recovery. Supply the async satellite contract so
  // its fire-and-forget recovery cannot outlive this fixture's isolated database.
  const aiSessionStore = {
    on: () => undefined,
    off: () => undefined,
    recoverStaleSessions: async () => 0,
    listRecoverable: async () => [],
    cleanupStaleSessions: async () => ({ terminalDeleted: 0, orphanedDeleted: 0 }),
    stopScheduledCleanup: () => undefined,
  };
  const app = createServer(store, { aiSessionStore: aiSessionStore as never });
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    server,
    restoreEnv: () => {
      process.env.FUSION_CLIENT_DIR = previousClientDir;
    },
    teardown: () => harness.teardown(),
  };
}

afterEach(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempRoots = [];
});

pgDescribe("server index preload injection", () => {
  serverViewPreloadIntegrationTest("injects view chunk map and modulepreload bootstrap", async () => {
    const clientDir = makeTempDir("fn-4782-client-");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        "components/AgentsView.tsx": { file: "assets/AgentsView-abc123.js" },
        "components/command-center/CommandCenter.tsx": {
          file: "assets/CommandCenter-abc123.js",
          css: ["assets/CommandCenter-abc123.css"],
        },
      }),
    );

    const { server, restoreEnv, teardown } = await startServerWithFixture(clientDir);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");

      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain("window.__FUSION_VIEW_CHUNKS__");
      expect(html).toContain('"agents":{"file":"/assets/AgentsView-abc123.js","css":[]}');
      expect(html).toContain(
        '"command-center":{"file":"/assets/CommandCenter-abc123.js","css":["/assets/CommandCenter-abc123.css"]}',
      );
      expect(html).toContain("modulepreload");
      expect(html).toContain("stylesheet");
    } finally {
      restoreEnv();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await teardown();
    }
  });

  serverViewPreloadIntegrationTest("injects stylesheet and modulepreload links for persisted lazy views", async () => {
    const injection = buildViewPreloadInjection({
      "command-center": {
        file: "/assets/CommandCenter-abc123.js",
        css: ["/assets/CommandCenter-abc123.css"],
      },
      reliability: {
        file: "/assets/ReliabilityView-def456.js",
        css: ["/assets/ReliabilityView-def456.css"],
      },
    });

    const commandCenterLinks = runPreloadBootstrap(injection, "command-center");
    expect(commandCenterLinks).toEqual([
      { rel: "stylesheet", href: "/assets/CommandCenter-abc123.css" },
      { rel: "modulepreload", href: "/assets/CommandCenter-abc123.js", crossOrigin: "" },
    ]);

    const reliabilityLinks = runPreloadBootstrap(injection, "reliability");
    expect(reliabilityLinks).toEqual([
      { rel: "stylesheet", href: "/assets/ReliabilityView-def456.css" },
      { rel: "modulepreload", href: "/assets/ReliabilityView-def456.js", crossOrigin: "" },
    ]);
  });

  serverViewPreloadIntegrationTest("serves Command Center css asset referenced by the preload bootstrap", async () => {
    const clientDir = makeTempDir("fn-6690-client-css-");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    mkdirSync(join(clientDir, "assets"), { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
    writeFileSync(
      join(clientDir, "assets", "CommandCenter-fixture.css"),
      ".command-center{display:flex}.cc-tabpanel{overflow-y:auto}",
    );
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({
        "components/command-center/CommandCenter.tsx": {
          file: "assets/CommandCenter-fixture.js",
          css: ["assets/CommandCenter-fixture.css"],
        },
      }),
    );

    const { server, restoreEnv, teardown } = await startServerWithFixture(clientDir);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");

      const html = await (await fetch(`http://127.0.0.1:${address.port}/`)).text();
      expect(html).toContain('"command-center":{"file":"/assets/CommandCenter-fixture.js","css":["/assets/CommandCenter-fixture.css"]}');

      const cssRes = await fetch(`http://127.0.0.1:${address.port}/assets/CommandCenter-fixture.css`);
      const css = await cssRes.text();
      expect(cssRes.status).toBe(200);
      expect(css).toContain(".command-center{display:flex}");
      expect(css).toContain(".cc-tabpanel{overflow-y:auto}");
    } finally {
      restoreEnv();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await teardown();
    }
  });

  it("applies representative Command Center computed styles when the emitted css link is loaded", () => {
    const clientDir = makeTempDir("fn-6690-computed-css-");
    mkdirSync(join(clientDir, "assets"), { recursive: true });
    const cssPath = join(clientDir, "assets", "CommandCenter-fixture.css");
    writeFileSync(cssPath, ".command-center{display:flex;flex-direction:column}.cc-tabpanel{overflow-y:auto;min-height:0}");

    const injection = buildViewPreloadInjection({
      "command-center": {
        file: "/assets/CommandCenter-fixture.js",
        css: ["/assets/CommandCenter-fixture.css"],
      },
    });
    const links = runPreloadBootstrap(injection, "command-center");
    const cssLinks = links.filter((link) => link.rel === "stylesheet");
    expect(cssLinks).toHaveLength(1);

    const dom = new JSDOM('<section class="command-center"><div class="cc-tabpanel">Overview</div></section>');
    const root = dom.window.document.querySelector<HTMLElement>(".command-center");
    const panel = dom.window.document.querySelector<HTMLElement>(".cc-tabpanel");
    expect(root).not.toBeNull();
    expect(panel).not.toBeNull();
    expect(dom.window.getComputedStyle(root!).display).not.toBe("flex");

    for (const link of cssLinks) {
      const style = dom.window.document.createElement("style");
      style.textContent = readFileSync(join(clientDir, link.href!.replace(/^\//, "")), "utf8");
      dom.window.document.head.appendChild(style);
    }

    expect(dom.window.getComputedStyle(root!).display).toBe("flex");
    expect(dom.window.getComputedStyle(root!).flexDirection).toBe("column");
    expect(dom.window.getComputedStyle(panel!).overflowY).toBe("auto");
  });

  serverViewPreloadIntegrationTest("injects at marker comment when present", async () => {
    const clientDir = makeTempDir("fn-4782-client-marker-");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    writeFileSync(
      join(clientDir, "index.html"),
      "<!doctype html><html><head><!-- fusion:view-preload --></head><body><div id=\"root\"></div></body></html>",
    );
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({ "components/AgentsView.tsx": { file: "assets/AgentsView-marker.js" } }),
    );

    const { server, restoreEnv, teardown } = await startServerWithFixture(clientDir);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");

      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toMatch(/<!-- fusion:view-preload -->\s*<script>window\.__FUSION_VIEW_CHUNKS__/);
    } finally {
      restoreEnv();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await teardown();
    }
  });

  serverViewPreloadIntegrationTest("serves index with empty chunk map when manifest is missing", async () => {
    const clientDir = makeTempDir("fn-4782-client-no-manifest-");
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");

    const { server, restoreEnv, teardown } = await startServerWithFixture(clientDir);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");

      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain("window.__FUSION_VIEW_CHUNKS__={}");
    } finally {
      restoreEnv();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await teardown();
    }
  });

  serverViewPreloadIntegrationTest("escapes script poison in inlined chunk map", async () => {
    const clientDir = makeTempDir("fn-4782-client-escape-");
    mkdirSync(join(clientDir, ".vite"), { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>");
    writeFileSync(
      join(clientDir, ".vite", "manifest.json"),
      JSON.stringify({ "components/AgentsView.tsx": { file: "assets/AgentsView-</script>-abc.js" } }),
    );

    const { server, restoreEnv, teardown } = await startServerWithFixture(clientDir);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing server address");

      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain("<\\/script>");
      expect(html).not.toContain('assets/AgentsView-</script>-abc.js");(()=>');
    } finally {
      restoreEnv();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      await teardown();
    }
  });
});
