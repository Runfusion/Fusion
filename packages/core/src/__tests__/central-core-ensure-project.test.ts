import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CentralCore } from "../central-core.js";
import { ProjectIdentityConflictError } from "../project-identity.js";

describe("CentralCore.ensureProjectForPath", () => {
  const cleanup: string[] = [];
  afterEach(() => cleanup.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));

  it("covers existing, reattach, fresh, and conflict", async () => {
    const globalDir = mkdtempSync(join(tmpdir(), "central-"));
    const p1 = mkdtempSync(join(tmpdir(), "proj-a-"));
    const p2 = mkdtempSync(join(tmpdir(), "proj-b-"));
    mkdirSync(join(p1, ".fusion"));
    mkdirSync(join(p2, ".fusion"));
    cleanup.push(globalDir, p1, p2);

    const central = new CentralCore(globalDir);
    await central.init();

    const first = await central.ensureProjectForPath({ path: p1, name: "A" });
    expect(first.reattached).toBe(false);

    const existing = await central.ensureProjectForPath({ path: p1, name: "A" });
    expect(existing.outcome).toBe("existing");

    await central.unregisterProject(first.project.id);
    const events: Array<[string, string]> = [];
    central.on("project:reattached", (project, reason) => events.push([project.id, reason]));
    const reattached = await central.ensureProjectForPath({
      path: p1,
      name: "A",
      identity: { id: first.project.id, createdAt: first.project.createdAt },
    });
    expect(reattached.reattached).toBe(true);
    expect(events).toEqual([[first.project.id, "identity-recovered"]]);

    await expect(
      central.ensureProjectForPath({
        path: p2,
        name: "B",
        identity: { id: first.project.id, createdAt: first.project.createdAt },
      }),
    ).rejects.toBeInstanceOf(ProjectIdentityConflictError);

    await central.close();
  });
});
