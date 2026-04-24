import { CentralCore, type NodeConfig } from "@fusion/core";
import { createInterface } from "node:readline/promises";

// ── Options Interfaces ───────────────────────────────────────────────────────

/** Options for node list command. */
export interface NodeListOptions {
  /** Output as JSON instead of table */
  json?: boolean;
}

/** Options for node connect command. */
export interface NodeConnectOptions {
  /** Remote node URL */
  url: string;
  /** Optional API key for remote node authentication */
  apiKey?: string;
  /** Max concurrent tasks for the node */
  maxConcurrent?: number;
}

/** Options for node disconnect command. */
export interface NodeDisconnectOptions {
  /** Skip confirmation prompt */
  force?: boolean;
}

/** Options for node show command. */
export interface NodeShowOptions {
  /** Output as JSON instead of table */
  json?: boolean;
}

/** Options for mesh status command. */
export interface MeshStatusOptions {
  /** Output as JSON instead of table */
  json?: boolean;
}

// ── Helper Functions ─────────────────────────────────────────────────────────

/**
 * Mask an API key for display, showing last 4 characters.
 * @param key - The API key to mask
 * @returns Masked key like "****abcd" or "none" for undefined
 */
export function maskApiKey(key?: string): string {
  if (!key) return "none";
  if (key.length < 4) return "****";
  return `****${key.slice(-4)}`;
}

/**
 * Format bytes into human-readable format.
 * @param bytes - Number of bytes
 * @returns Human-readable string like "1.2 GB", "512 MB", "64 KB"
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  
  const units = ["B", "KB", "MB", "GB", "TB"];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  
  if (i === 0) return `${bytes} B`;
  if (value >= 100) return `${Math.round(value)} ${units[i]}`;
  if (value >= 10) return `${value.toFixed(1)} ${units[i]}`;
  return `${value.toFixed(2)} ${units[i]}`;
}

/**
 * Format milliseconds into human-readable uptime.
 * @param ms - Milliseconds
 * @returns String like "2d 4h 32m" or "5m 30s"
 */
export function formatUptime(ms: number): string {
  if (ms < 0) return "0s";
  
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours % 24 > 0) parts.push(`${hours % 24}h`);
  if (minutes % 60 > 0) parts.push(`${minutes % 60}m`);
  if (seconds % 60 > 0 && days === 0) parts.push(`${seconds % 60}s`);
  
  if (parts.length === 0) return "0s";
  return parts.join(" ");
}

/**
 * Format a percentage as an ASCII progress bar.
 * @param percent - Percentage value (0-100)
 * @param width - Width of the bar in characters (default: 8)
 * @returns String like "[████░░░░] 48%"
 */
export function formatStatusBar(percent: number, width: number = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `[${bar}] ${Math.round(clamped)}%`;
}

/**
 * Format a timestamp for display (relative time).
 * @param timestamp - ISO timestamp or null
 * @returns Relative time string like "5m ago", "2h ago", "3d ago", "just now"
 */
export function formatLastActivity(timestamp?: string | null): string {
  if (!timestamp) return "never";

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Get the status indicator character for a node status.
 */
function getStatusIndicator(status: string): string {
  switch (status) {
    case "online": return "●";
    case "offline": return "○";
    case "error": return "✕";
    case "connecting": return "◐";
    default: return "○";
  }
}

/**
 * Get color-coded status string.
 */
function formatStatus(status: string): string {
  return `${getStatusIndicator(status)} ${status}`;
}

// ── Core Command Functions ──────────────────────────────────────────────────

/**
 * List all registered nodes.
 */
export async function runNodeList(options: NodeListOptions = {}): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    const nodes = await central.listNodes();

    if (nodes.length === 0) {
      if (options.json) {
        console.log(JSON.stringify([], null, 2));
      } else {
        console.log("\n  No nodes registered.");
        console.log("  Register one with: fn node connect <name> --url <url>\n");
      }
      return;
    }

    const sorted = [...nodes].sort((a, b) => a.name.localeCompare(b.name));

    // Check if SystemMetrics is available for display
    const hasMetrics = sorted.some(n => n.systemMetrics);

    if (options.json) {
      // Mask API keys in JSON output
      const masked = sorted.map(node => ({
        ...node,
        apiKey: maskApiKey(node.apiKey),
      }));
      console.log(JSON.stringify(masked, null, 2));
      return;
    }

    console.log();
    console.log("  Registered Nodes:");
    console.log();

    // Build header based on whether metrics are available
    if (hasMetrics) {
      console.log("  Name              Type     Status       Max  CPU     Memory  URL");
      console.log(`  ${"─".repeat(85)}`);
    } else {
      console.log("  Name              Type     Status       Max  URL");
      console.log(`  ${"─".repeat(72)}`);
    }

    for (const node of sorted) {
      const name = node.name.padEnd(16);
      const type = node.type.padEnd(8);
      const statusStr = formatStatus(node.status).padEnd(12);
      const max = String(node.maxConcurrent).padStart(3);

      if (hasMetrics && node.systemMetrics) {
        const metrics = node.systemMetrics;
        const cpu = formatStatusBar(metrics.cpuUsage, 4).padEnd(10);
        const memPercent = (metrics.memoryUsed / metrics.memoryTotal) * 100;
        const mem = formatStatusBar(memPercent, 4).padEnd(10);
        const url = node.type === "remote" ? (node.url ?? "-") : "-";
        console.log(`  ${name}  ${type} ${statusStr}  ${max}  ${cpu} ${mem} ${url}`);
      } else {
        const url = node.type === "remote" ? (node.url ?? "-") : "-";
        console.log(`  ${name}  ${type} ${statusStr}  ${max}  ${url}`);
      }
    }

    console.log();
    console.log(`  ${sorted.length} node${sorted.length === 1 ? "" : "s"} registered`);
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Connect to a remote node.
 * This is the preferred way to add remote nodes as it runs a health check.
 */
export async function runNodeConnect(
  name: string,
  options: NodeConnectOptions,
): Promise<void> {
  if (!name) {
    console.error("Usage: fn node connect <name> --url <url> [--api-key <key>] [--max-concurrent <n>]");
    process.exit(1);
  }

  if (!options.url) {
    console.error("\n  ✗ --url is required for remote nodes\n");
    process.exit(1);
  }

  if (!isValidNodeName(name)) {
    console.error(`\n  ✗ Invalid node name '${name}'`);
    console.error("  Name must be 1-64 characters and contain only: a-z, A-Z, 0-9, _, -\n");
    process.exit(1);
  }

  if (
    options.maxConcurrent !== undefined
    && (!Number.isFinite(options.maxConcurrent) || options.maxConcurrent < 1)
  ) {
    console.error("\n  ✗ --max-concurrent must be a number >= 1\n");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    // Register the node
    const node = await central.registerNode({
      name: name.trim(),
      type: "remote",
      url: options.url,
      apiKey: options.apiKey,
      maxConcurrent: options.maxConcurrent,
    });

    console.log();
    console.log(`  ✓ Node '${node.name}' registered`);
    console.log(`    ID: ${node.id}`);
    console.log(`    URL: ${node.url}`);
    console.log(`    Max Concurrent: ${node.maxConcurrent}`);

    // Run health check to verify connectivity
    console.log();
    console.log("  Checking connectivity...");

    const status = await central.checkNodeHealth(node.id);
    console.log(`    Status: ${formatStatus(status)}`);

    if (options.apiKey) {
      console.log(`    API Key: ${maskApiKey(options.apiKey)}`);
    }

    console.log();
    if (options.apiKey && status === "online") {
      console.log(`  ✓ Node '${node.name}' connected (authenticated)`);
    } else if (options.apiKey && (status === "offline" || status === "error")) {
      console.log(`  ⚠ Node is offline — the API key may be incorrect or the node may be unreachable`);
    } else {
      console.log("  ✓ Node connected successfully");
    }
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Disconnect (unregister) a node.
 */
export async function runNodeDisconnect(
  name: string,
  options: NodeDisconnectOptions = {},
): Promise<void> {
  if (!name) {
    console.error("Usage: fn node disconnect <name> [--force]");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const node = await findNodeByNameOrId(central, name);
    if (!node) {
      console.error(`Error: Node '${name}' not found.`);
      process.exit(1);
    }

    if (!options.force) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(`Disconnect node '${node.name}'? [y/N] `);
      rl.close();

      if (answer.trim().toLowerCase() !== "y") {
        console.log("Cancelled.");
        return;
      }
    }

    await central.unregisterNode(node.id);

    console.log();
    console.log(`  ✓ Disconnected node '${node.name}'`);
    if (node.type === "remote" && node.url) {
      console.log(`    URL: ${node.url}`);
    }
    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Show detailed node information.
 */
export async function runNodeShow(
  name?: string,
  options: NodeShowOptions = {},
): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    let node: NodeConfig | undefined;

    if (name) {
      node = await findNodeByNameOrId(central, name);
    } else {
      const nodes = await central.listNodes();
      node = nodes.find((candidate) => candidate.type === "local");
    }

    if (!node) {
      console.error(`Error: Node '${name || "local"}' not found.`);
      process.exit(1);
    }

    // Get assigned projects
    const allProjects = await central.listProjects();
    const assignedProjects = allProjects.filter(p => p.nodeId === node!.id);

    if (options.json) {
      const output = {
        ...node,
        apiKey: maskApiKey(node.apiKey),
        assignedProjects: assignedProjects.map(p => ({
          id: p.id,
          name: p.name,
          path: p.path,
          status: p.status,
        })),
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log();
    console.log(`  Node: ${node.name}`);
    console.log(`  ID: ${node.id}`);
    console.log(`  Type: ${node.type}`);
    console.log(`  Status: ${formatStatus(node.status)}`);
    
    if (node.type === "remote") {
      console.log(`  URL: ${node.url ?? "(missing)"}`);
      console.log(`  API Key: ${maskApiKey(node.apiKey)}`);
    }
    
    console.log(`  Max Concurrent: ${node.maxConcurrent}`);
    console.log(`  Capabilities: ${node.capabilities?.length ? node.capabilities.join(", ") : "(none)"}`);
    console.log(`  Created: ${node.createdAt}`);
    console.log(`  Updated: ${node.updatedAt}`);

    // Display system metrics if available
    if (node.systemMetrics) {
      const metrics = node.systemMetrics;
      console.log();
      console.log("  System Metrics:");
      console.log(`    CPU Usage:    ${formatStatusBar(metrics.cpuUsage)}`);
      console.log(`    Memory:       ${formatBytes(metrics.memoryUsed)} / ${formatBytes(metrics.memoryTotal)}`);
      console.log(`    Storage:      ${formatBytes(metrics.storageUsed)} / ${formatBytes(metrics.storageTotal)}`);
      console.log(`    Uptime:       ${formatUptime(metrics.uptime)}`);
      console.log(`    Reported:     ${formatLastActivity(metrics.reportedAt)}`);
    } else {
      console.log();
      console.log("  System Metrics: not available");
    }

    // Display assigned projects
    if (assignedProjects.length > 0) {
      console.log();
      console.log(`  Assigned Projects (${assignedProjects.length}):`);
      for (const project of assignedProjects) {
        console.log(`    • ${project.name} (${project.status})`);
      }
    }

    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Run a health check for a node.
 */
export async function runNodeHealth(name: string): Promise<void> {
  if (!name) {
    console.error("Usage: fn node health <name>");
    process.exit(1);
  }

  const central = new CentralCore();
  await central.init();

  try {
    const node = await findNodeByNameOrId(central, name);
    if (!node) {
      console.error(`Error: Node '${name}' not found.`);
      process.exit(1);
    }

    const previousStatus = node.status;
    const status = await central.checkNodeHealth(node.id);

    console.log();
    console.log(`  Node '${node.name}' health check:`);
    console.log(`    Previous: ${formatStatus(previousStatus)}`);
    console.log(`    Current:  ${formatStatus(status)}`);

    if (node.type === "remote" && node.url) {
      console.log(`    URL: ${node.url}`);
    }

    console.log();
  } finally {
    await central.close();
  }
}

/**
 * Show mesh status with all nodes and summary.
 */
export async function runMeshStatus(options: MeshStatusOptions = {}): Promise<void> {
  const central = new CentralCore();
  await central.init();

  try {
    const nodes = await central.listNodes();

    // Compute summary counts
    const summary = {
      total: nodes.length,
      online: nodes.filter(n => n.status === "online").length,
      offline: nodes.filter(n => n.status === "offline").length,
      error: nodes.filter(n => n.status === "error").length,
      connecting: nodes.filter(n => n.status === "connecting").length,
    };

    if (options.json) {
      // Mask API keys in JSON output
      const maskedNodes = nodes.map(node => ({
        ...node,
        apiKey: maskApiKey(node.apiKey),
      }));
      console.log(JSON.stringify({ nodes: maskedNodes, summary }, null, 2));
      return;
    }

    if (nodes.length === 0) {
      console.log("\n  No nodes in mesh.");
      console.log("  Register a remote node with: fn node connect <name> --url <url>\n");
      return;
    }

    const sorted = [...nodes].sort((a, b) => {
      // Sort by status: online first, then by name
      if (a.status === "online" && b.status !== "online") return -1;
      if (b.status === "online" && a.status !== "online") return 1;
      return a.name.localeCompare(b.name);
    });

    console.log();
    console.log("  Mesh Status:");
    console.log();
    console.log(`  Total: ${summary.total} | Online: ${summary.online} | Offline: ${summary.offline} | Error: ${summary.error}`);
    console.log();
    console.log("  Name              Type     Status       URL");
    console.log(`  ${"─".repeat(68)}`);

    for (const node of sorted) {
      const name = node.name.padEnd(16);
      const type = node.type.padEnd(8);
      const statusStr = formatStatus(node.status).padEnd(12);
      const url = node.type === "remote" ? (node.url ?? "-") : "(local)";
      console.log(`  ${name}  ${type} ${statusStr} ${url}`);
    }

    console.log();

    // Show mesh topology if there are peers
    const nodesWithPeers = nodes.filter(n => n.knownPeers && n.knownPeers.length > 0);
    if (nodesWithPeers.length > 0) {
      console.log("  Mesh Connections:");
      for (const node of nodesWithPeers) {
        const peers = node.knownPeers?.map(p => {
          const peerNode = nodes.find(n => n.id === p);
          return peerNode ? peerNode.name : p;
        }).join(", ") || "none";
        console.log(`    ${node.name} → ${peers}`);
      }
      console.log();
    }
  } finally {
    await central.close();
  }
}

// ── Exported Helper for Reuse ──────────────────────────────────────────────

/**
 * Find a node by name or ID.
 */
export async function findNodeByNameOrId(
  central: CentralCore,
  nameOrId: string,
): Promise<NodeConfig | undefined> {
  const byId = await central.getNode(nameOrId);
  if (byId) {
    return byId;
  }
  return central.getNodeByName(nameOrId);
}

/**
 * Validate a node name.
 */
export function isValidNodeName(name: string): boolean {
  if (!name || name.length < 1 || name.length > 64) {
    return false;
  }
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

// ── Legacy Aliases (for backward compatibility) ─────────────────────────────

/**
 * @deprecated Use runNodeConnect instead
 */
export const runNodeAdd = runNodeConnect;

/**
 * @deprecated Use runNodeDisconnect instead
 */
export const runNodeRemove = runNodeDisconnect;

/**
 * @deprecated Use runNodeShow instead
 */
export const runNodeInfo = runNodeShow;
