import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sanitizeDockerNodeConfigForResponse,
  validateDockerNodeConfig,
  type DockerNodeConfig,
} from "../types.js";
import { CentralCore } from "../central-core.js";

function createValidConfig(): DockerNodeConfig {
  return {
    image: "runfusion/fusion:latest",
    containerName: "fusion-test",
    volumeMounts: [{ hostPath: "fusion-data", containerPath: "/data", mode: "rw", type: "volume" }],
    environment: { PLAIN: "value", API_KEY: "secret" },
    resources: { memoryBytes: 2147483648, cpuCount: 2, pidsLimit: 256 },
    host: {
      contextName: "default",
      dockerHost: "tcp://127.0.0.1:2376",
      tlsCaCert: "/certs/ca.pem",
      tlsCert: "/certs/cert.pem",
      tlsKey: "/certs/key.pem",
      tlsVerify: true,
    },
    extraClis: ["claude-cli"],
    persistence: { volumeName: "fusion-data", retainOnDelete: true },
    configVersion: 1,
    lastUpdated: "2026-05-01T00:00:00.000Z",
  };
}

describe("docker node config validation", () => {
  it("passes validation for valid config", () => {
    expect(validateDockerNodeConfig(createValidConfig()).valid).toBe(true);
  });

  it("returns errors for missing required fields", () => {
    const result = validateDockerNodeConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "image must be a non-empty string",
        "volumeMounts must be an array",
        "environment must be an object",
        "configVersion must be a number >= 1",
      ]),
    );
  });

  it("returns errors for invalid field types", () => {
    const result = validateDockerNodeConfig({
      image: "ok",
      volumeMounts: [{ hostPath: 123, containerPath: false }],
      environment: { OK: "1", BAD: 2 },
      configVersion: 1,
      resources: { memoryBytes: "bad" },
      host: { tlsVerify: "nope" },
      persistence: { retainOnDelete: "nope" },
      extraClis: ["ok", 1],
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "volumeMounts[0].hostPath must be a string",
        "volumeMounts[0].containerPath must be a string",
        "environment.BAD must be a string value",
        "resources.memoryBytes must be a number",
      ]),
    );
  });

  it("requires configVersion >= 1", () => {
    const base = createValidConfig();
    expect(validateDockerNodeConfig({ ...base, configVersion: 0 }).valid).toBe(false);
    expect(validateDockerNodeConfig({ ...base, configVersion: -1 }).valid).toBe(false);
  });
});

describe("docker node config sanitization", () => {
  it("masks sensitive env vars and tls key path without mutating input", () => {
    const config = createValidConfig();
    const sanitized = sanitizeDockerNodeConfigForResponse(config);
    expect(sanitized.environment.API_KEY).toBe("***");
    expect(sanitized.host?.tlsKey).toBe("***");
    expect(config.environment.API_KEY).toBe("secret");
  });

  it("masks sensitive env vars case-insensitively and preserves non-sensitive values", () => {
    const config = createValidConfig();
    config.environment = { plain: "value", service_token: "token", DB_PASSWORD: "password" };
    const sanitized = sanitizeDockerNodeConfigForResponse(config);
    expect(sanitized.environment.plain).toBe("value");
    expect(sanitized.environment.service_token).toBe("***");
    expect(sanitized.environment.DB_PASSWORD).toBe("***");
  });
});

describe("docker node config persistence", () => {
  let tempDir: string;
  let central: CentralCore;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T10:00:00.000Z"));
    tempDir = mkdtempSync(join(tmpdir(), "kb-docker-node-config-test-"));
    central = new CentralCore(tempDir);
    await central.init();
  });

  afterEach(async () => {
    await central.close();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  const baseConfig = (): DockerNodeConfig => ({
    image: "runfusion/fusion:latest",
    volumeMounts: [{ hostPath: "fusion-data", containerPath: "/data" }],
    environment: { MODE: "docker" },
    configVersion: 0,
  });

  it("register/get/update/list roundtrip with versioning semantics", async () => {
    const created = await central.registerNode({
      name: "docker-node",
      type: "remote",
      url: "http://127.0.0.1:4041",
      apiKey: "key",
      dockerConfig: baseConfig(),
    });
    expect(created.dockerConfig?.configVersion).toBe(1);

    const sameOnPartial = await central.updateNode(created.id, { name: "docker-node-2" });
    expect(sameOnPartial.dockerConfig?.configVersion).toBe(1);

    vi.setSystemTime(new Date("2026-05-01T11:00:00.000Z"));
    const updated = await central.updateNode(created.id, {
      dockerConfig: { ...baseConfig(), image: "runfusion/fusion:v2", configVersion: 99 },
    });
    expect(updated.dockerConfig?.configVersion).toBe(2);
    expect(updated.dockerConfig?.lastUpdated).toBe("2026-05-01T11:00:00.000Z");

    const cleared = await central.updateNode(created.id, { dockerConfig: null });
    expect(cleared.dockerConfig).toBeUndefined();

    const reset = await central.updateNode(created.id, { dockerConfig: { ...baseConfig(), configVersion: 50 } });
    expect(reset.dockerConfig?.configVersion).toBe(1);

    const list = await central.listNodes();
    expect(list.find((n) => n.id === created.id)?.dockerConfig?.image).toBe("runfusion/fusion:latest");
  });

  it("registering without docker config keeps field undefined", async () => {
    const created = await central.registerNode({
      name: "plain-node",
      type: "remote",
      url: "http://127.0.0.1:4042",
      apiKey: "key",
    });
    expect((await central.getNode(created.id))?.dockerConfig).toBeUndefined();
  });

  it("throws on invalid docker config update", async () => {
    const created = await central.registerNode({
      name: "docker-invalid",
      type: "remote",
      url: "http://127.0.0.1:4043",
      apiKey: "key",
      dockerConfig: baseConfig(),
    });
    await expect(
      central.updateNode(created.id, {
        dockerConfig: { ...baseConfig(), image: "", configVersion: 1 },
      }),
    ).rejects.toThrow("Invalid Docker config");
  });
});
