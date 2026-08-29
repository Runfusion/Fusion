import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DatabaseBackupsSection } from "../DatabaseBackupsSection";
import type { SettingsFormState } from "../context";

function renderSection(overrides: Record<string, unknown> = {}) {
  render(<DatabaseBackupsSection
    form={{ autoBackupEnabled: false } as SettingsFormState}
    setForm={vi.fn()}
    backupLoading={false}
    onBackupNow={vi.fn()}
    backupInfo={{
      backups: [
        { filename: "older.sql", createdAt: "2026-01-01T00:00:00.000Z", size: 1024, path: "/older" },
        { filename: "newer.sql", createdAt: "2026-02-01T00:00:00.000Z", size: 2 * 1024, path: "/newer" },
      ],
      count: 2,
      totalSize: 3 * 1024,
      schedule: { enabled: true, cronExpression: "0 2 * * *", routineRegistered: true },
      ...overrides,
    }}
  />);
}

describe("DatabaseBackupsSection", () => {
  it("shows schedule evidence and newest backups first", () => {
    renderSection();
    expect(screen.getByText("Automatic backup schedule")).toBeInTheDocument();
    expect(screen.getByText("On")).toBeInTheDocument();
    expect(screen.getByText("newer.sql").compareDocumentPosition(screen.getByText("older.sql"))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });

  it("explains empty inventories, listing failures, and unregistered schedules", () => {
    renderSection({
      backups: [],
      count: 0,
      listError: "PostgreSQL unavailable",
      schedule: { enabled: true, cronExpression: "0 2 * * *", routineRegistered: false },
    });
    expect(screen.getByText(/No backups yet/)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("PostgreSQL unavailable");
    expect(screen.getByRole("status")).toHaveTextContent(/No backup schedule is registered/);
  });
});
