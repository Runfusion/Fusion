import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TaskStore } from "@fusion/core";
import { createServer } from "@fusion/dashboard";

export type RuntimeSource = "embedded-local" | "external-cli" | "none";
export type RuntimeState = "stopped" | "starting" | "running" | "error";

export interface DesktopRuntimeStatus {
  source: RuntimeSource;
  state: RuntimeState;
  port?: number;
  baseUrl?: string;
  error?: string;
}

type TaskStoreLike = {
  init(): Promise<void>;
  watch(): Promise<void>;
  close(): void;
};

type RuntimeInstance = {
  store: TaskStoreLike;
  server: Server;
  port: number;
  baseUrl: string;
};

export interface LocalRuntimeManagerOptions {
  rootDir: string;
  getExternalPort?: () => number | undefined;
  createStore?: (rootDir: string) => Promise<TaskStoreLike>;
  createDashboardServer?: (store: TaskStoreLike) => Promise<Server>;
}

async function createStoreDefault(rootDir: string): Promise<TaskStoreLike> {
  return new TaskStore(rootDir) as TaskStoreLike;
}

async function createDashboardServerDefault(store: TaskStoreLike): Promise<Server> {
  return createServer(store).listen(0);
}

function parsePort(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return undefined;
  }

  return value;
}

function getAddressPort(server: Server): number {
  const address = server.address() as AddressInfo | null;
  const port = address?.port;
  if (!port) {
    throw new Error("Failed to resolve local server port");
  }
  return port;
}

export class LocalRuntimeManager {
  private runtime: RuntimeInstance | null = null;
  private startupPromise: Promise<DesktopRuntimeStatus> | null = null;
  private stopPromise: Promise<DesktopRuntimeStatus> | null = null;
  private status: DesktopRuntimeStatus = { source: "none", state: "stopped" };

  private readonly getExternalPort: () => number | undefined;
  private readonly createStore: (rootDir: string) => Promise<TaskStoreLike>;
  private readonly createDashboardServer: (store: TaskStoreLike) => Promise<Server>;

  constructor(private readonly options: LocalRuntimeManagerOptions) {
    this.getExternalPort = options.getExternalPort ?? (() => parsePort(process.env.FUSION_SERVER_PORT));
    this.createStore = options.createStore ?? createStoreDefault;
    this.createDashboardServer = options.createDashboardServer ?? createDashboardServerDefault;
  }

  getStatus(): DesktopRuntimeStatus {
    if (this.runtime) {
      return {
        source: "embedded-local",
        state: "running",
        port: this.runtime.port,
        baseUrl: this.runtime.baseUrl,
      };
    }

    const externalPort = this.getExternalPort();
    if (externalPort) {
      this.status = {
        source: "external-cli",
        state: "running",
        port: externalPort,
        baseUrl: `http://127.0.0.1:${externalPort}`,
      };
    }

    return this.status;
  }

  getServerPort(): number | undefined {
    return this.getStatus().port;
  }

  async startLocal(): Promise<DesktopRuntimeStatus> {
    const externalPort = this.getExternalPort();
    if (externalPort) {
      this.status = {
        source: "external-cli",
        state: "running",
        port: externalPort,
        baseUrl: `http://127.0.0.1:${externalPort}`,
      };
      return this.status;
    }

    if (this.runtime) {
      return this.getStatus();
    }

    if (this.startupPromise) {
      return this.startupPromise;
    }

    this.status = { source: "embedded-local", state: "starting" };
    this.startupPromise = this.startEmbedded();

    try {
      return await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  private async startEmbedded(): Promise<DesktopRuntimeStatus> {
    let store: TaskStoreLike | null = null;
    let server: Server | null = null;

    try {
      store = await this.createStore(this.options.rootDir);
      await store.init();
      await store.watch();

      server = await this.createDashboardServer(store);
      await Promise.race([
        once(server, "listening"),
        once(server, "error").then(([error]) => {
          throw error;
        }),
      ]);

      const port = getAddressPort(server);
      const baseUrl = `http://127.0.0.1:${port}`;
      this.runtime = { store, server, port, baseUrl };
      this.status = { source: "embedded-local", state: "running", port, baseUrl };
      return this.status;
    } catch (error) {
      if (server) {
        await new Promise<void>((resolve) => {
          server!.close(() => resolve());
        });
      }
      if (store) {
        store.close();
      }
      this.runtime = null;
      this.status = {
        source: "embedded-local",
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stopLocal(): Promise<DesktopRuntimeStatus> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = this.stopInternal();
    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async stopInternal(): Promise<DesktopRuntimeStatus> {
    if (this.runtime) {
      const runtime = this.runtime;
      this.runtime = null;
      await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
      runtime.store.close();
      this.status = { source: "none", state: "stopped" };
      return this.status;
    }

    if (this.getStatus().source === "external-cli") {
      return this.status;
    }

    this.status = { source: "none", state: "stopped" };
    return this.status;
  }
}
