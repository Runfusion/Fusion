/**
 * Test utility for populating a CentralCore instance with sample nodes.
 *
 * Used exclusively in tests — creates 1 local + 5 remote nodes
 * for testing the multi-node dashboard. Must only be called with
 * test-scoped CentralCore instances (temp directories).
 *
 * Usage (tests only):
 *   import { seedSampleNodes } from "./seed-sample-nodes";
 *   await seedSampleNodes(central); // central backed by temp directory
 */

import { CentralCore } from "../central-core.js";
import type { NodeConfig, NodeStatus } from "../types.js";

/** Sample remote nodes to create for visual testing */
const SAMPLE_REMOTE_NODES = [
  {
    name: "Staging Server",
    url: "https://staging.runfusion.ai",
    status: "online" as NodeStatus,
    maxConcurrent: 4,
  },
  {
    name: "Build Machine",
    url: "https://build.runfusion.ai",
    status: "online" as NodeStatus,
    maxConcurrent: 8,
  },
  {
    name: "GPU Cluster",
    url: "https://gpu.runfusion.ai",
    status: "offline" as NodeStatus,
    maxConcurrent: 16,
  },
  {
    name: "Dev Box (John)",
    url: "http://192.168.1.100:4040",
    status: "error" as NodeStatus,
    maxConcurrent: 2,
  },
  {
    name: "QA Environment",
    url: "https://qa.runfusion.ai",
    status: "connecting" as NodeStatus,
    maxConcurrent: 4,
  },
] as const;

/**
 * Seed the central database with sample nodes for visual testing.
 *
 * @param central - An initialized CentralCore instance
 * @returns Array of registered nodes (1 local + up to 5 remote)
 */
export async function seedSampleNodes(central: CentralCore): Promise<NodeConfig[]> {
  const nodes: NodeConfig[] = [];

  // Ensure central is initialized
  if (!central.isInitialized()) {
    await central.init();
  }

  // 1. Get or create the local node (auto-created on init)
  const existingNodes = await central.listNodes();
  const existingLocal = existingNodes.find((n) => n.type === "local");
  let localNode: NodeConfig;

  if (existingLocal) {
    // Update local node status to online
    localNode = await central.updateNode(existingLocal.id, { status: "online" });
  } else {
    // Create local node
    localNode = await central.registerNode({
      name: "local",
      type: "local",
      maxConcurrent: 4,
    });
    localNode = await central.updateNode(localNode.id, { status: "online" });
  }
  nodes.push(localNode);

  // 2. Register remote nodes (idempotently)
  for (const sampleNode of SAMPLE_REMOTE_NODES) {
    const existingByName = await central.getNodeByName(sampleNode.name);

    if (existingByName) {
      // Update existing node status
      const updated = await central.updateNode(existingByName.id, { status: sampleNode.status });
      nodes.push(updated);
      console.log(`  Updated existing node: ${sampleNode.name} (${sampleNode.status})`);
    } else {
      // Create new node
      const remoteNode = await central.registerNode({
        name: sampleNode.name,
        type: "remote",
        url: sampleNode.url,
        maxConcurrent: sampleNode.maxConcurrent,
      });

      // Update status to the desired state
      const updated = await central.updateNode(remoteNode.id, { status: sampleNode.status });
      nodes.push(updated);
      console.log(`  Registered new node: ${sampleNode.name} (${sampleNode.status})`);
    }
  }

  return nodes;
}
