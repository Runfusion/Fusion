import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { GitLabBadge, formatGitLabBadgeKind, formatGitLabBadgeMarker } from "../GitLabBadge";
import type { TaskGitLabTrackedItem } from "@fusion/core";

const baseItem: TaskGitLabTrackedItem = {
  kind: "project_issue",
  url: "https://gitlab.example.test/group/project/-/issues/42",
  instanceUrl: "https://gitlab.example.test",
  host: "gitlab.example.test",
  iid: 42,
  projectPath: "group/project",
  title: "Fix GitLab bug",
  state: "opened",
};

describe("GitLab tracking UI helpers", () => {
  it("formats provider-specific issue, group issue, and merge request badges", () => {
    expect(formatGitLabBadgeKind(baseItem)).toBe("Issue");
    expect(formatGitLabBadgeMarker(baseItem)).toBe("#42");
    expect(formatGitLabBadgeKind({ kind: "group_issue" })).toBe("Group issue");
    expect(formatGitLabBadgeMarker({ kind: "group_issue", iid: 7 })).toBe("#7");
    expect(formatGitLabBadgeKind({ kind: "merge_request" })).toBe("MR");
    expect(formatGitLabBadgeMarker({ kind: "merge_request", iid: 5 })).toBe("!5");
  });

  it("renders linked and stale GitLab badges without GitHub copy", () => {
    const { rerender } = render(<GitLabBadge item={baseItem} />);
    const badge = screen.getByTestId("card-gitlab-badge");
    expect(badge).toHaveAttribute("href", baseItem.url);
    expect(badge).toHaveAttribute("aria-label", "GitLab Issue #42: Fix GitLab bug");
    expect(badge).toHaveTextContent("#42");
    expect(badge).not.toHaveTextContent("GitHub");

    rerender(<GitLabBadge item={{ ...baseItem, staleAt: "2026-07-02T00:00:00.000Z", staleReason: "GitLab sync failed" }} />);
    expect(screen.getByTestId("card-gitlab-badge")).toHaveAttribute("aria-label", "GitLab Issue #42: Fix GitLab bug — stale: GitLab sync failed");
  });

  it("renders no empty shell when no GitLab metadata exists", () => {
    const { container } = render(<GitLabBadge item={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});
