import { EventEmitter } from "node:events";
import os from "node:os";
import { Bonjour, type Browser, type Service } from "bonjour-service";
import type {
  DiscoveredNode,
  DiscoveryConfig,
  NodeDiscoveryEvent,
} from "./types.js";

const DEFAULT_DISCOVERY_CONFIG: DiscoveryConfig = {
  broadcast: true,
  listen: true,
  serviceType: "_fusion._tcp",
  port: 4040,
  staleTimeoutMs: 300_000,
};

const STALE_CLEANUP_INTERVAL_MS = 60_000;
const FUSION_VERSION = "0.1.0";

function normalizeMdnsHost(host: string): string {
  return host.trim().replace(/\.local\.?$/i, "").toLowerCase();
}

/**
 * Returns a bounded, DNS-label-safe hostname owned by Fusion rather than the OS.
 */
function deriveFusionMdnsHost(nodeId: string): string {
  const suffix = nodeId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(-8)
    .replace(/^-+|-+$/g, "") || "node";
  const host = `fusion-${suffix}`;

  // An unusually named host can equal the naïve Fusion label; retain ownership
  // while guaranteeing that Fusion never claims the OS hostname.
  return normalizeMdnsHost(host) === normalizeMdnsHost(os.hostname())
    ? `${host}-service`
    : host;
}

interface NodeDiscoveryEvents {
  "node:discovered": [node: DiscoveredNode];
  "node:updated": [node: DiscoveredNode];
  "node:lost": [name: string];
  "discovery:started": [];
  "discovery:stopped": [];
  error: [error: Error];
}

interface ParsedServiceType {
  type: string;
  protocol: "tcp" | "udp";
}

/**
 * mDNS/DNS-SD discovery service for local-network Fusion nodes.
 */
export class NodeDiscovery extends EventEmitter<NodeDiscoveryEvents> {
  private readonly config: DiscoveryConfig;
  private bonjour: Bonjour | null = null;
  private broadcastService: Service | null = null;
  private browser: Browser | null = null;
  private staleCleanupInterval: NodeJS.Timeout | null = null;
  private readonly discoveredNodes = new Map<string, DiscoveredNode>();
  private localNodeId: string | null = null;
  private started = false;

  constructor(config: DiscoveryConfig) {
    super();
    this.config = {
      ...DEFAULT_DISCOVERY_CONFIG,
      ...config,
      staleTimeoutMs: Math.max(1_000, config.staleTimeoutMs),
    };
  }

  start(nodeId: string, nodeName: string): void {
    this.localNodeId = nodeId;

    if (this.config.broadcast) {
      this.startBroadcast(nodeId, nodeName);
    }

    if (this.config.listen) {
      this.startListening();
      this.startStaleCleanup();
    }

    this.started = true;
    this.emit("discovery:started");
  }

  stop(): void {
    if (this.config.listen) {
      this.stopListening();
    }

    if (this.config.broadcast) {
      this.stopBroadcast();
    }

    if (this.staleCleanupInterval) {
      clearInterval(this.staleCleanupInterval);
      this.staleCleanupInterval = null;
    }

    for (const name of this.discoveredNodes.keys()) {
      this.emit("node:lost", name);
    }
    this.discoveredNodes.clear();

    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }

    this.localNodeId = null;

    if (this.started) {
      this.started = false;
      this.emit("discovery:stopped");
    }
  }

  startBroadcast(nodeId: string, nodeName: string): void {
    this.localNodeId = nodeId;

    if (this.broadcastService) {
      return;
    }

    const bonjour = this.getBonjour();
    const serviceType = this.parseServiceType(this.config.serviceType);
    const host = deriveFusionMdnsHost(nodeId);

    try {
      /*
       * FNXC:NodeDiscovery 2026-07-17-12:00:
       * bonjour-service probes the DNS-SD instance FQDN but not its advertised
       * A/SRV host. FN-8202 found that re-announcing the OS hostname made macOS
       * mDNSResponder self-conflict and rename the host, so publish a
       * Fusion-owned target instead of os.hostname().
       */
      this.broadcastService = bonjour.publish({
        /*
         * FNXC:NodeDiscovery 2026-07-15-18:05:
         * Multiple local Fusion dashboards may share a friendly node name.
         * DNS-SD requires each advertised service name to be unique, so retain
         * the readable name while suffixing stable node identity to prevent an
         * optional mDNS collision from disrupting the dashboard process.
         */
        name: `${nodeName.trim() || os.hostname()}-${nodeId.slice(-8)}`,
        host,
        type: serviceType.type,
        protocol: serviceType.protocol,
        port: this.config.port,
        txt: {
          nodeType: "local",
          nodeId,
          version: FUSION_VERSION,
        },
      });
      this.broadcastService.on("error", this.onBroadcastError);
    } catch (error) {
      this.reportError("Failed to start mDNS broadcast", error);
    }
  }

  stopBroadcast(): void {
    if (!this.broadcastService) {
      return;
    }

    try {
      this.broadcastService.off("error", this.onBroadcastError);
      this.broadcastService.stop?.();
    } catch (error) {
      this.reportError("Failed to stop mDNS broadcast", error);
    } finally {
      this.broadcastService = null;
    }
  }

  startListening(): void {
    if (this.browser) {
      return;
    }

    const bonjour = this.getBonjour();
    const serviceType = this.parseServiceType(this.config.serviceType);

    try {
      this.browser = bonjour.find({
        type: serviceType.type,
        protocol: serviceType.protocol,
      });
      this.browser.on("up", this.onServiceUp);
      this.browser.on("down", this.onServiceDown);
    } catch (error) {
      this.reportError("Failed to start mDNS listening", error);
    }
  }

  stopListening(): void {
    if (!this.browser) {
      return;
    }

    const browser = this.browser;

    try {
      browser.off("up", this.onServiceUp);
      browser.off("down", this.onServiceDown);
      browser.stop();
    } catch (error) {
      this.reportError("Failed to stop mDNS listening", error);
    } finally {
      this.browser = null;
    }
  }

  getDiscoveredNodes(): DiscoveredNode[] {
    return Array.from(this.discoveredNodes.values());
  }

  getDiscoveredNode(name: string): DiscoveredNode | undefined {
    return this.discoveredNodes.get(name);
  }

  private startStaleCleanup(): void {
    if (this.staleCleanupInterval) {
      return;
    }

    this.staleCleanupInterval = setInterval(() => {
      const now = Date.now();
      const lostNodes: string[] = [];

      for (const [name, node] of this.discoveredNodes.entries()) {
        const lastSeenMs = Date.parse(node.lastSeenAt);
        if (now - lastSeenMs > this.config.staleTimeoutMs) {
          this.discoveredNodes.delete(name);
          lostNodes.push(name);
        }
      }

      for (const name of lostNodes) {
        this.emit("node:lost", name);
      }
    }, STALE_CLEANUP_INTERVAL_MS);
  }

  private onServiceUp = (service: Service): void => {
    const nodeId = this.getServiceText(service, "nodeId");
    if (nodeId && this.localNodeId && nodeId === this.localNodeId) {
      return;
    }

    const host = this.resolveServiceHost(service);
    if (!host) {
      return;
    }

    const existing = this.discoveredNodes.get(service.name);
    const now = new Date().toISOString();
    const nextNode: DiscoveredNode = {
      name: service.name,
      host,
      port: service.port,
      nodeType: this.getServiceText(service, "nodeType") === "remote" ? "remote" : "local",
      nodeId,
      discoveredAt: existing?.discoveredAt ?? now,
      lastSeenAt: now,
    };

    this.discoveredNodes.set(service.name, nextNode);
    this.emit(existing ? "node:updated" : "node:discovered", nextNode);
  };

  private onServiceDown = (service: Service): void => {
    if (!this.discoveredNodes.has(service.name)) {
      return;
    }

    this.discoveredNodes.delete(service.name);
    this.emit("node:lost", service.name);
  };

  private onBroadcastError = (error: unknown): void => {
    this.reportError("mDNS broadcast failed", error);
  };

  private getBonjour(): Bonjour {
    if (!this.bonjour) {
      this.bonjour = new Bonjour();
    }

    return this.bonjour;
  }

  private parseServiceType(serviceType: string): ParsedServiceType {
    const normalized = serviceType.trim();
    const mdnsPattern = /^_([^._]+)\._(tcp|udp)$/i;
    const match = normalized.match(mdnsPattern);

    if (match) {
      return {
        type: match[1].toLowerCase(),
        protocol: match[2].toLowerCase() as "tcp" | "udp",
      };
    }

    return {
      type: normalized.replace(/^_/, "").split(".")[0].toLowerCase() || "fusion",
      protocol: "tcp",
    };
  }

  private getServiceText(service: Service, key: string): string | undefined {
    const txt = service.txt;
    if (!txt || typeof txt !== "object" || !(key in txt)) {
      return undefined;
    }

    const value = (txt as Record<string, unknown>)[key];
    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    return undefined;
  }

  private resolveServiceHost(service: Service): string | undefined {
    const addresses = service.addresses ?? [];
    const ipv4 = addresses.find((address) => this.isIpv4(address));
    if (ipv4) {
      return ipv4;
    }

    const nonLinkLocal = addresses.find((address) => !address.startsWith("fe80:"));
    if (nonLinkLocal) {
      return nonLinkLocal;
    }

    const refererAddress = service.referer?.address;
    if (refererAddress) {
      return refererAddress;
    }

    return undefined;
  }

  private isIpv4(value: string): boolean {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(value);
  }

  private warn(message: string, error?: unknown): void {
    if (error) {
      console.warn(`[node-discovery] ${message}`, error);
      return;
    }

    console.warn(`[node-discovery] ${message}`);
  }

  private reportError(message: string, error: unknown): void {
    this.warn(message, error);
    // EventEmitter reserves "error" for fatal exceptions when nobody is
    // listening. Discovery is optional, so preserve observability for callers
    // that subscribe without allowing a network collision to crash the host.
    if (this.listenerCount("error") > 0) {
      this.emit("error", this.asError(error));
    }
  }

  private asError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }

    return new Error(String(error));
  }
}

export type { NodeDiscoveryEvent };
