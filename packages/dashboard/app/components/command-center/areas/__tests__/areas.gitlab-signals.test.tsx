import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  api: (path: string, opts?: RequestInit) => mocks.api(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
}));

import { GitlabArea } from "../GitlabArea";
import { range7d } from "./areas.test-harness";

function gitlabFixture() {
  return {
    from: "2026-06-08",
    to: null,
    filed: 4,
    fixed: 2,
    net: 2,
    daily: [
      { date: "2026-06-08", filed: 1, fixed: 0 },
      { date: "2026-06-09", filed: 3, fixed: 2 },
    ],
    byProject: [
      { project: "group/project", filed: 3, fixed: 1 },
      { project: "platform/api", filed: 1, fixed: 1 },
    ],
    resolved: [
      {
        taskId: "FN-200",
        taskTitle: "Fix GitLab issue",
        project: "group/project",
        issueNumber: 42,
        url: "https://gitlab.example.test/group/project/-/issues/42",
        resolvedAt: "2026-06-09T12:00:00.000Z",
        resolvedAtExact: true,
      },
      {
        taskId: "FN-201",
        taskTitle: "Review GitLab MR",
        project: "platform/api",
        issueNumber: 7,
        url: "https://gitlab.example.test/platform/api/-/merge_requests/7",
        resolvedAt: "2026-06-09T13:00:00.000Z",
        resolvedAtExact: false,
      },
    ],
  };
}

beforeEach(() => {
  mocks.api.mockReset();
});

describe("GitlabArea", () => {
  it("appends projectId to its gitlab request when supplied, and omits it when not", async () => {
    mocks.api.mockResolvedValue(gitlabFixture());
    const { unmount } = render(<GitlabArea range={range7d} projectId="proj-gl" />);
    await screen.findByTestId("cc-area-gitlab");
    expect(mocks.api.mock.calls.at(-1)?.[0]).toBe("/command-center/gitlab?from=2026-06-08&projectId=proj-gl");
    unmount();

    mocks.api.mockClear();
    mocks.api.mockResolvedValue(gitlabFixture());
    render(<GitlabArea range={range7d} />);
    await screen.findByTestId("cc-area-gitlab");
    expect(mocks.api.mock.calls.at(-1)?.[0]).toBe("/command-center/gitlab?from=2026-06-08");
  });

  it("renders GitLab analytics from local dashboard API data only", async () => {
    mocks.api.mockResolvedValue(gitlabFixture());

    render(<GitlabArea range={range7d} />);

    await screen.findByTestId("cc-area-gitlab");
    expect(mocks.api).toHaveBeenCalledWith(expect.stringContaining("/command-center/gitlab"), undefined);
    expect(screen.getByTestId("cc-gitlab-filed").textContent).toContain("4");
    expect(screen.getByTestId("cc-gitlab-fixed").textContent).toContain("2");
    expect(screen.getByTestId("cc-gitlab-net").textContent).toContain("2");
    expect(screen.getByText("group/project")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "group/project: 3 filed / 1 fixed" })).toBeInTheDocument();

    const resolved = screen.getByTestId("cc-gitlab-resolved-list");
    expect(resolved.textContent).toContain("group/project#42");
    expect(resolved.textContent).toContain("platform/api#7");
    expect(resolved.textContent).toContain("approx");
    expect(within(resolved).getByRole("link", { name: /group\/project#42/ })).toHaveAttribute("href", "https://gitlab.example.test/group/project/-/issues/42");
  });

  it("renders empty state without provider network calls", async () => {
    mocks.api.mockResolvedValueOnce({ ...gitlabFixture(), filed: 0, fixed: 0, net: 0, daily: [], byProject: [], resolved: [] });
    render(<GitlabArea range={range7d} />);

    await screen.findByText("No GitLab issue or merge request activity in the selected range.");
    expect(screen.queryByTestId("cc-gitlab-resolved-list")).toBeNull();
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});
