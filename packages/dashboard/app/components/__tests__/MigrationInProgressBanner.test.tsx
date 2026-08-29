/*
FNXC:MigrationHoldingPage 2026-07-17-12:50:
Pins the open-tab migration banner contract: hidden unless health reports
status "migrating", and shows the structured progress label when present.
*/
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MigrationInProgressBanner } from "../MigrationInProgressBanner";

describe("MigrationInProgressBanner", () => {
  it("renders nothing when inactive", () => {
    const { container } = render(<MigrationInProgressBanner isActive={false} progressLabel="ignored" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders status copy when active", () => {
    render(<MigrationInProgressBanner isActive />);
    expect(screen.getByRole("status")).toHaveTextContent("Database migration in progress");
  });

  it("shows the structured progress label when provided", () => {
    render(<MigrationInProgressBanner isActive progressLabel="[3/12] project.tasks — 500/2000 rows" />);
    expect(screen.getByRole("status")).toHaveTextContent("[3/12] project.tasks — 500/2000 rows");
  });
});
