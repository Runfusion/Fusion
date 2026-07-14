/**
 * FNXC:MonitorWriteIsolation 2026-07-14-01:13:
 * PostgreSQL monitor writes are project-owned. An unbound layer must reject before touching the legacy empty partition, while the same connection with an explicit project binding must persist and resolve rows visible to that project.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
  type SharedPgTaskStoreHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import * as schema from "../../../core/src/postgres/schema/index.js";
import {
  ingestIncidentSignal,
  recordDeployment,
  resolveIncident,
} from "../monitor-store.js";

pgDescribe("monitor-store PostgreSQL project binding", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_monitor_write_scope",
  });

  beforeAll(h.beforeAll);
  beforeEach(h.beforeEach);
  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("rejects unbound writes without rows and persists bound writes", async () => {
    const layer = h.layer();
    const deployment = { deploymentId: "bound-deployment", deployedAt: "2026-07-14T01:00:00.000Z" };
    const signal = { groupingKey: "bound-incident", title: "Bound incident", at: "2026-07-14T01:00:00.000Z" };

    await expect(recordDeployment(layer, deployment)).rejects.toThrow(
      "PostgreSQL monitor writes require asyncLayer.projectId",
    );
    await expect(ingestIncidentSignal(layer, signal)).rejects.toThrow(
      "PostgreSQL monitor writes require asyncLayer.projectId",
    );
    await expect(resolveIncident(layer, signal.groupingKey)).rejects.toThrow(
      "PostgreSQL monitor writes require asyncLayer.projectId",
    );
    expect(await layer.db.select().from(schema.project.deployments)).toEqual([]);
    expect(await layer.db.select().from(schema.project.incidents)).toEqual([]);

    const boundLayer = { ...layer, projectId: "monitor-project" };
    await recordDeployment(boundLayer, deployment);
    const created = await ingestIncidentSignal(boundLayer, signal);
    expect(created.incident.status).toBe("open");
    const resolved = await resolveIncident(boundLayer, signal.groupingKey, "2026-07-14T02:00:00.000Z");
    expect(resolved?.status).toBe("resolved");

    const deployments = await layer.db.select().from(schema.project.deployments);
    const incidents = await layer.db.select().from(schema.project.incidents);
    expect(deployments).toEqual([expect.objectContaining({ projectId: "monitor-project", deploymentId: "bound-deployment" })]);
    expect(incidents).toEqual([expect.objectContaining({ projectId: "monitor-project", groupingKey: "bound-incident", status: "resolved" })]);
  });
});
