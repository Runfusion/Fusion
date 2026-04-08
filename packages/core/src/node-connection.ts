import { performance } from "node:perf_hooks";
import type { NodeConfig } from "./types.js";
import type { CentralCore } from "./central-core.js";

export type ConnectionErrorType =
  | "timeout"
  | "dns-failure"
  | "connection-refused"
  | "ssl-error"
  | "auth-failure"
  | "not-fusion-node"
  | "unexpected-status"
  | "network-error";

export interface ConnectionResult {
  /** Whether the connection test succeeded */
  success: boolean;
  /** Normalized URL (e.g., "http://192.168.1.100:3000") */
  url: string;
  /** Latency in milliseconds for the successful health check */
  latencyMs?: number;
  /** Remote node metadata (only present when success is true) */
  nodeInfo?: {
    /** Node name reported by the remote Fusion instance */
    name: string;
    /** Fusion version reported by the remote */
    version: string;
    /** Uptime of the remote instance in seconds */
    uptime: number;
    /** Capabilities supported by the remote node */
    capabilities?: string[];
  };
  /** Error details (only present when success is false) */
  error?: {
    type: ConnectionErrorType;
    message: string;
    /** HTTP status code if applicable */
    statusCode?: number;
  };
}

export interface ConnectionOptions {
  /** IP address or hostname (e.g., "192.168.1.100" or "my-server.local") */
  host: string;
  /** Port number (1-65535) */
  port: number;
  /** Whether to use HTTPS (default: false) */
  secure?: boolean;
  /** API key for authentication (optional) */
  apiKey?: string;
  /** Connection timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Base path if the Fusion API is behind a reverse proxy prefix (default: "") */
  basePath?: string;
}

export interface TestAndRegisterOptions extends ConnectionOptions {
  name: string;
  maxConcurrent?: number;
}

export interface TestAndRegisterResult extends ConnectionResult {
  node?: NodeConfig;
  registrationError?: string;
}

interface HealthPayload {
  status?: unknown;
  version?: unknown;
  name?: unknown;
  uptime?: unknown;
  capabilities?: unknown;
}

export class NodeConnection {
  async test(options: ConnectionOptions): Promise<ConnectionResult> {
    this.validateInput(options);

    const timeoutMs = options.timeoutMs ?? 10_000;
    const url = this.buildBaseUrl(options);
    const healthUrl = `${url}/api/health`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const startTime = performance.now();

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        headers: options.apiKey
          ? {
              Authorization: `Bearer ${options.apiKey}`,
            }
          : undefined,
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          url,
          error: {
            type: "auth-failure",
            message: `Authentication failed (${response.status}) while testing ${url}`,
            statusCode: response.status,
          },
        };
      }

      if (!response.ok) {
        return {
          success: false,
          url,
          error: {
            type: "unexpected-status",
            message: `Unexpected response status ${response.status} while testing ${url}`,
            statusCode: response.status,
          },
        };
      }

      let payload: HealthPayload;
      try {
        payload = (await response.json()) as HealthPayload;
      } catch {
        return {
          success: false,
          url,
          error: {
            type: "not-fusion-node",
            message: `Endpoint ${url} did not return a valid Fusion health response`,
          },
        };
      }

      if (!("status" in payload)) {
        return {
          success: false,
          url,
          error: {
            type: "not-fusion-node",
            message: `Endpoint ${url} is reachable but does not appear to be a Fusion node`,
          },
        };
      }

      const latencyMs = Math.max(0, performance.now() - startTime);
      const capabilities = Array.isArray(payload.capabilities)
        ? payload.capabilities.filter((capability): capability is string => typeof capability === "string")
        : undefined;

      return {
        success: true,
        url,
        latencyMs,
        nodeInfo: {
          name: typeof payload.name === "string" && payload.name.trim().length > 0 ? payload.name : options.host,
          version: typeof payload.version === "string" && payload.version.trim().length > 0 ? payload.version : "unknown",
          uptime: typeof payload.uptime === "number" && Number.isFinite(payload.uptime) ? payload.uptime : 0,
          capabilities,
        },
      };
    } catch (error) {
      return {
        success: false,
        url,
        error: this.classifyError(error, timeoutMs),
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async testAndRegister(
    central: CentralCore,
    options: TestAndRegisterOptions
  ): Promise<TestAndRegisterResult> {
    const { name, maxConcurrent, ...connectionOptions } = options;
    const result = await this.test(connectionOptions);

    if (!result.success) {
      return result;
    }

    try {
      const node = await central.registerNode({
        name,
        type: "remote",
        url: result.url,
        apiKey: connectionOptions.apiKey,
        maxConcurrent,
      });
      await central.checkNodeHealth(node.id);
      return {
        ...result,
        node,
      };
    } catch (error) {
      return {
        ...result,
        registrationError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private validateInput(options: ConnectionOptions): void {
    if (typeof options.host !== "string" || options.host.trim().length === 0) {
      throw new TypeError("Connection host must be a non-empty string");
    }

    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new TypeError(`Connection port must be an integer between 1 and 65535: ${String(options.port)}`);
    }

    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      throw new TypeError(`Connection timeoutMs must be greater than 0: ${String(options.timeoutMs)}`);
    }
  }

  private buildBaseUrl(options: ConnectionOptions): string {
    const protocol = options.secure ? "https" : "http";
    const basePath = this.normalizeBasePath(options.basePath);
    return `${protocol}://${options.host}:${options.port}${basePath}`;
  }

  private normalizeBasePath(basePath?: string): string {
    if (basePath === undefined) {
      return "";
    }

    const trimmed = basePath.trim();
    if (!trimmed || trimmed === "/") {
      return "";
    }

    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeadingSlash.endsWith("/") ? withLeadingSlash.slice(0, -1) : withLeadingSlash;
  }

  private classifyError(
    error: unknown,
    timeoutMs: number
  ): { type: ConnectionErrorType; message: string; statusCode?: number } {
    if (error instanceof Error && error.name === "AbortError") {
      return {
        type: "timeout",
        message: `Connection timed out after ${timeoutMs}ms`,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    const lowered = message.toLowerCase();

    if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
      return {
        type: "dns-failure",
        message,
      };
    }

    if (lowered.includes("econnrefused")) {
      return {
        type: "connection-refused",
        message,
      };
    }

    if (
      message.includes("CERT") ||
      message.includes("UNABLE_TO_VERIFY_LEAF_SIGNATURE") ||
      lowered.includes("self signed")
    ) {
      return {
        type: "ssl-error",
        message,
      };
    }

    return {
      type: "network-error",
      message,
    };
  }
}
