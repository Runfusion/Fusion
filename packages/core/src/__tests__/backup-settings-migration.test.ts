import { describe, expect, it } from "vitest";
import { planBackupSettingsMigration } from "../backup/backup-settings-migration.js";

describe("backup settings project-to-global migration plan", () => {
  it("leaves unset values at global defaults", () => {
    expect(planBackupSettingsMigration([], {})).toEqual({ values: {}, conflicts: [] });
  });

  it("adopts one configured project value", () => {
    const result = planBackupSettingsMigration([{ projectId: "one", settings: { autoBackupRetention: 30 } }], {});
    expect(result.values.autoBackupRetention).toBe(30);
    expect(result.conflicts).toEqual([]);
  });

  it("adopts duplicate project values", () => {
    const result = planBackupSettingsMigration([
      { projectId: "one", settings: { autoBackupEnabled: true } },
      { projectId: "two", settings: { autoBackupEnabled: true } },
    ], {});
    expect(result.values.autoBackupEnabled).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it("retains discriminated candidates when projects conflict", () => {
    const result = planBackupSettingsMigration([
      { projectId: "one", settings: { autoBackupRetention: 7 } },
      { projectId: "two", settings: { autoBackupRetention: 30 } },
    ], {}, "2026-07-16T16:00:00.000Z");
    expect(result.values).toEqual({});
    expect(result.conflicts[0]).toMatchObject({
      key: "autoBackupRetention",
      candidates: [
        { source: "project", projectId: "one", value: 7 },
        { source: "project", projectId: "two", value: 30 },
      ],
    });
  });

  it("never overwrites an existing global value", () => {
    const result = planBackupSettingsMigration(
      [{ projectId: "one", settings: { autoBackupRetention: 30 } }],
      { autoBackupRetention: 7 },
    );
    expect(result.values.autoBackupRetention).toBe(7);
    expect(result.conflicts[0]?.candidates).toEqual([
      { source: "global", value: 7 },
      { source: "project", projectId: "one", value: 30 },
    ]);
  });
});
