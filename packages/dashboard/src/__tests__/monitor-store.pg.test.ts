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

  it("resolves only one newest incident and makes concurrent recovery idempotent", async () => {
    const layer = { ...h.layer(), projectId: "monitor-atomic-project" };
    const key = "atomic-incident";
    const firstRecoveryAt = "2026-08-09T11:00:00.000Z";
    const secondRecoveryAt = "2026-08-09T12:00:00.000Z";
    await ingestIncidentSignal(layer, { groupingKey: key, title: "first", at: "2026-08-09T10:00:00.000Z" });
    const [one, two] = await Promise.all([
      resolveIncident(layer, key, firstRecoveryAt),
      resolveIncident(layer, key, secondRecoveryAt),
    ]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const row = (await layer.db.select().from(schema.project.incidents)).find((incident) => incident.groupingKey === key);
    expect(row).toMatchObject({ status: "resolved" });
    expect(row?.resolvedAt).toBe(one ? firstRecoveryAt : secondRecoveryAt);

    await layer.db.insert(schema.project.incidents).values([
      { projectId: layer.projectId, incidentId: "older", groupingKey: "multi", title: "older", status: "open", openedAt: "2026-08-09T10:00:00.000Z", createdAt: "2026-08-09T10:00:00.000Z", updatedAt: "2026-08-09T10:00:00.000Z" },
      { projectId: layer.projectId, incidentId: "newer", groupingKey: "multi", title: "newer", status: "open", openedAt: "2026-08-09T11:00:00.000Z", createdAt: "2026-08-09T11:00:00.000Z", updatedAt: "2026-08-09T11:00:00.000Z" },
    ]);
    expect((await resolveIncident(layer, "multi", "2026-08-09T12:00:00.000Z"))?.incidentId).toBe("newer");
    let rows = (await layer.db.select().from(schema.project.incidents)).filter((row) => row.groupingKey === "multi");
    expect(rows.find((row) => row.incidentId === "newer")).toMatchObject({ status: "resolved", resolvedAt: "2026-08-09T12:00:00.000Z" });
    expect(rows.find((row) => row.incidentId === "older")).toMatchObject({ status: "open", resolvedAt: null });
    expect((await resolveIncident(layer, "multi", "2026-08-09T13:00:00.000Z"))?.incidentId).toBe("older");
    rows = (await layer.db.select().from(schema.project.incidents)).filter((row) => row.groupingKey === "multi");
    const resolvedAts = rows.map((entry) => entry.resolvedAt);
    expect(await resolveIncident(layer, "multi", "2026-08-09T14:00:00.000Z")).toBeNull();
    expect((await layer.db.select().from(schema.project.incidents)).filter((entry) => entry.groupingKey === "multi").map((entry) => entry.resolvedAt)).toEqual(resolvedAts);

    const reopened = await ingestIncidentSignal(layer, { groupingKey: "multi", title: "reopened", at: "2026-08-09T15:00:00.000Z" });
    expect(reopened.created).toBe(true);
    expect((await resolveIncident(layer, "multi", "2026-08-09T16:00:00.000Z"))?.incidentId).toBe(reopened.incident.incidentId);
    expect((await layer.db.select().from(schema.project.incidents)).filter((entry) => entry.groupingKey === "multi" && entry.status === "resolved")).toHaveLength(3);
  });

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
