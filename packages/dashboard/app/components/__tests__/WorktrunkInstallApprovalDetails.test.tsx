import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorktrunkInstallApprovalDetails } from "../WorktrunkInstallApprovalDetails";
import type { ApprovalRequestDetail } from "../../api";

describe("WorktrunkInstallApprovalDetails", () => {
  it("renders version, URL, sha, and install path", () => {
    const targetAction: ApprovalRequestDetail["targetAction"] = {
      category: "network_api",
      action: "worktrunk_install",
      summary: "Install worktrunk",
      resourceType: "binary",
      resourceId: "~/.fusion/bin/worktrunk",
      context: {
        version: "v1.2.3",
        installPath: "~/.fusion/bin/worktrunk",
        assets: {
          darwin_arm64: {
            url: "https://example.com/worktrunk.tar.gz",
            sha256: "abc123",
          },
        },
      },
    };

    render(<WorktrunkInstallApprovalDetails targetAction={targetAction} />);

    expect(screen.getByText("Worktrunk install request")).toBeInTheDocument();
    expect(screen.getByText("v1.2.3")).toBeInTheDocument();
    expect(screen.getByText("https://example.com/worktrunk.tar.gz")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getAllByText("~/.fusion/bin/worktrunk").length).toBeGreaterThan(0);
  });

  it("gracefully handles missing context fields", () => {
    const targetAction: ApprovalRequestDetail["targetAction"] = {
      category: "network_api",
      action: "worktrunk_install",
      summary: "Install worktrunk",
      resourceType: "binary",
      resourceId: "~/.fusion/bin/worktrunk",
    };

    render(<WorktrunkInstallApprovalDetails targetAction={targetAction} />);

    expect(screen.getByTestId("worktrunk-install-approval-details")).toBeInTheDocument();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0);
  });
});
