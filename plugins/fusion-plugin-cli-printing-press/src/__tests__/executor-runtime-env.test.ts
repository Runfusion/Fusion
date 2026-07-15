import { expect, it, vi } from "vitest";
import { buildExecutorRuntimeEnv } from "../runtime/executor-runtime-env.js";
import type { CliPressStore } from "../store/cli-press-store.js";

it("builds every service environment with a constant four-query catalog load", async () => {
  const now = new Date().toISOString();
  const services = ["one", "two"].map((id) => ({
    id,
    slug: id,
    displayName: id,
    description: undefined,
    baseUrl: "https://example.test",
    sourceKind: "manual" as const,
    sourceRef: undefined,
    createdAt: now,
    updatedAt: now,
  }));
  const listServices = vi.fn().mockResolvedValue(services);
  const listAllSpecs = vi.fn().mockResolvedValue(services.map((service) => ({
    id: `spec-${service.id}`,
    serviceId: service.id,
    name: service.id,
    version: "1",
    generatorVersion: "1",
    specJson: "{}",
    generatedAt: now,
    status: "generated",
    lastGenerationError: undefined,
    createdAt: now,
    updatedAt: now,
  })));
  const listAllArtifacts = vi.fn().mockResolvedValue([]);
  const listAllCredentials = vi.fn().mockResolvedValue(services.map((service) => ({
    id: `credential-${service.id}`,
    serviceId: service.id,
    name: service.id,
    kind: "env_var",
    value: { encoding: "base64", value: Buffer.from(service.id).toString("base64") },
    placement: { kind: "env_var", envVar: `SERVICE_${service.id.toUpperCase()}` },
    createdAt: now,
    updatedAt: now,
  })));
  const store = {
    listServices,
    listAllSpecs,
    listAllArtifacts,
    listAllCredentials,
    listSpecs: vi.fn(() => { throw new Error("per-service query must not run"); }),
    listArtifacts: vi.fn(() => { throw new Error("per-spec query must not run"); }),
    listCredentials: vi.fn(() => { throw new Error("per-service query must not run"); }),
  } as unknown as CliPressStore;

  const result = await buildExecutorRuntimeEnv(
    store,
    { taskId: "FN-1", rootDir: "/tmp/fusion-printing-press-test", worktreePath: "/tmp/fusion-printing-press-test" },
    { logger: { warn: vi.fn() } } as never,
  );

  expect(result.env).toEqual({ SERVICE_ONE: "one", SERVICE_TWO: "two" });
  expect([listServices, listAllSpecs, listAllArtifacts, listAllCredentials].every((fn) => fn.mock.calls.length === 1)).toBe(true);
});
