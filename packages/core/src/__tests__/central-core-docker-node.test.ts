import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralCore } from "../central-core.js";

describe("CentralCore managed Docker nodes", () => {
  let tempDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    tempDir = mkdtempSync(join(tmpdir(), "kb-central-docker-node-test-"));
    central = new CentralCore(tempDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const buildInput = (name: string) => ({
    nodeId: null,
    name,
    imageName: "runfusion/fusion",
    imageTag: "latest",
    hostConfig: { context: "default", tlsVerify: false },
    envVars: { FUSION_NODE_NAME: name, FUSION_MODE: "managed" },
    volumeMounts: [{ hostPath: "/var/lib/fusion", containerPath: "/data", mode: "rw" as const }],
    resourceSizing: { memoryMB: 4096, cpus: 2, memorySwapMB: 0 },
    extraClis: ["droid-cli" as const],
    persistentStorage: true,
    reachableUrl: "http://127.0.0.1:4041",
    apiKey: "secret-key",
  });

  it("createManagedDockerNode creates full record with dn_ id and creating status", async () => {
    const created = await central.createManagedDockerNode(buildInput("docker-a"));

    expect(created.id.startsWith("dn_")).toBe(true);
    expect(created.name).toBe("docker-a");
    expect(created.status).toBe("creating");
    expect(created.containerId).toBeNull();
    expect(created.errorMessage).toBeNull();
  });

  it("createManagedDockerNode enforces unique names", async () => {
    await central.createManagedDockerNode(buildInput("docker-unique"));

    await expect(central.createManagedDockerNode(buildInput("docker-unique"))).rejects.toThrow(
      "already exists with name",
    );
  });

  it("createManagedDockerNode validates required name", async () => {
    await expect(central.createManagedDockerNode(buildInput("   "))).rejects.toThrow(
      "between 1 and 64 characters",
    );
  });

  it("getManagedDockerNode returns found and undefined for missing", async () => {
    const created = await central.createManagedDockerNode(buildInput("docker-get"));

    await expect(central.getManagedDockerNode(created.id)).resolves.toBeDefined();
    await expect(central.getManagedDockerNode("dn_missing")).resolves.toBeUndefined();
  });

  it("getManagedDockerNodeByName returns found and undefined for missing", async () => {
    const created = await central.createManagedDockerNode(buildInput("docker-by-name"));

    const found = await central.getManagedDockerNodeByName("docker-by-name");
    expect(found?.id).toBe(created.id);
    await expect(central.getManagedDockerNodeByName("missing-name")).resolves.toBeUndefined();
  });

  it("listManagedDockerNodes returns all ordered by name", async () => {
    await central.createManagedDockerNode(buildInput("zeta"));
    await central.createManagedDockerNode(buildInput("alpha"));

    const list = await central.listManagedDockerNodes();
    expect(list.map((item) => item.name)).toEqual(["alpha", "zeta"]);
  });

  it("updateManagedDockerNode applies partial changes and updates updatedAt", async () => {
    const created = await central.createManagedDockerNode(buildInput("docker-update"));

    vi.setSystemTime(new Date("2026-05-01T10:05:00.000Z"));

    const updated = await central.updateManagedDockerNode(created.id, {
      status: "running",
      envVars: { ...created.envVars, EXTRA: "1" },
      volumeMounts: [
        ...created.volumeMounts,
        { hostPath: "/var/log/fusion", containerPath: "/logs", mode: "ro" },
      ],
    });

    expect(updated.status).toBe("running");
    expect(updated.envVars.EXTRA).toBe("1");
    expect(updated.volumeMounts).toHaveLength(2);
    expect(updated.updatedAt).not.toBe(created.updatedAt);
  });

  it("updateManagedDockerNode throws for unknown id", async () => {
    await expect(central.updateManagedDockerNode("dn_missing", { status: "error" })).rejects.toThrow(
      "not found",
    );
  });

  it("deleteManagedDockerNode removes record", async () => {
    const created = await central.createManagedDockerNode(buildInput("docker-delete"));

    await central.deleteManagedDockerNode(created.id);

    await expect(central.getManagedDockerNode(created.id)).resolves.toBeUndefined();
  });

  it("linkManagedDockerNodeToNode sets nodeId", async () => {
    const managed = await central.createManagedDockerNode(buildInput("docker-link"));
    const node = await central.registerNode({
      name: "remote-link-target",
      type: "remote",
      url: "http://127.0.0.1:5050",
      apiKey: "remote-key",
    });

    const linked = await central.linkManagedDockerNodeToNode(managed.id, node.id);
    expect(linked.nodeId).toBe(node.id);
  });

  it("JSON fields round-trip through storage", async () => {
    const created = await central.createManagedDockerNode({
      ...buildInput("docker-json"),
      hostConfig: {
        host: "tcp://192.168.1.50:2376",
        context: "prod",
        tlsVerify: true,
        tlsCaPath: "/certs/ca.pem",
        tlsCertPath: "/certs/cert.pem",
        tlsKeyPath: "/certs/key.pem",
      },
      extraClis: ["claude-cli", "droid-cli"],
    });

    const fetched = await central.getManagedDockerNode(created.id);
    expect(fetched?.hostConfig).toEqual(created.hostConfig);
    expect(fetched?.envVars).toEqual(created.envVars);
    expect(fetched?.volumeMounts).toEqual(created.volumeMounts);
    expect(fetched?.resourceSizing).toEqual(created.resourceSizing);
    expect(fetched?.extraClis).toEqual(created.extraClis);
  });
});
