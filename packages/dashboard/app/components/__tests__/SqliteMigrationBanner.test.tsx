/*
FNXC:PostgresMigrationBanner 2026-07-12:
The post-auto-migration banner must (a) stay hidden when no notice exists or
it was dismissed, (b) tell the operator their data was migrated and backups
exist, (c) link "Need help?" to the Fusion Discord, and (d) persist dismissal
via updateSettings so it never reappears.
*/
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SqliteMigrationBanner, FUSION_DISCORD_URL } from "../SqliteMigrationBanner";

const { fetchSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
  fetchSettingsMock: vi.fn(),
  updateSettingsMock: vi.fn().mockResolvedValue({}),
}));

vi.mock("../../api", () => ({
  fetchSettings: fetchSettingsMock,
  updateSettings: updateSettingsMock,
}));

const NOTICE = {
  migratedAt: "2026-07-12T00:00:00.000Z",
  migratedRows: 42,
  tables: 7,
  sqliteBackups: ["/proj/.fusion/fusion.db"],
  dismissed: false,
};

describe("SqliteMigrationBanner", () => {
  beforeEach(() => {
    fetchSettingsMock.mockReset();
    updateSettingsMock.mockClear();
  });

  it("renders nothing when settings carry no notice", async () => {
    fetchSettingsMock.mockResolvedValue({});
    const { container } = render(<SqliteMigrationBanner projectId="p1" />);
    await waitFor(() => expect(fetchSettingsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the notice was already dismissed", async () => {
    fetchSettingsMock.mockResolvedValue({ sqliteMigrationNotice: { ...NOTICE, dismissed: true } });
    const { container } = render(<SqliteMigrationBanner projectId="p1" />);
    await waitFor(() => expect(fetchSettingsMock).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the migration summary, backup paths, and a Discord Need-help link", async () => {
    fetchSettingsMock.mockResolvedValue({ sqliteMigrationNotice: NOTICE });
    render(<SqliteMigrationBanner projectId="p1" />);
    const banner = await screen.findByRole("status");
    expect(banner).toHaveTextContent("Your data was migrated to PostgreSQL");
    expect(banner).toHaveTextContent("42 row(s) across 7 table(s)");
    expect(banner).toHaveTextContent("2026-07-12T00:00:00.000Z");
    expect(banner).toHaveTextContent("/proj/.fusion/fusion.db");
    const help = screen.getByRole("link", { name: "Get help on Discord" });
    expect(help).toHaveAttribute("href", FUSION_DISCORD_URL);
    expect(help).toHaveAttribute("target", "_blank");
  });

  it("dismiss hides the banner and persists dismissed: true", async () => {
    fetchSettingsMock.mockResolvedValue({ sqliteMigrationNotice: NOTICE });
    const { container } = render(<SqliteMigrationBanner projectId="p1" />);
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(container).toBeEmptyDOMElement();
    expect(updateSettingsMock).toHaveBeenCalledWith(
      { sqliteMigrationNotice: { ...NOTICE, dismissed: true } },
      "p1",
    );
  });
});
