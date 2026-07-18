/*
FNXC:CommandCenter 2026-06-25-00:00:
FN-7044 extracts the GitHub and Signals Command Center area suites from areas.test.tsx so each focused test file remains under the 2000-line hard cap while preserving every assertion.
*/
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

// Mock the api() helper so the areas fetch deterministic fixtures. Keep these Vitest hoisted mocks inline in each split suite to avoid TDZ failures.
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  backfillGithubSourceIssueClosedAt: vi.fn(),
  backfillCommitAssociationDiffStats: vi.fn(),
  fetchOrgTree: vi.fn(),
  fetchExecutorStats: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  toggleEnginePause: vi.fn(),
  appSettings: { globalPaused: false, enginePaused: false },
}));
const apiMock = mocks.api;
const backfillGithubSourceIssueClosedAtMock = mocks.backfillGithubSourceIssueClosedAt;
const backfillCommitAssociationDiffStatsMock = mocks.backfillCommitAssociationDiffStats;
const fetchOrgTreeMock = mocks.fetchOrgTree;
const fetchExecutorStatsMock = mocks.fetchExecutorStats;
const toggleEnginePauseMock = mocks.toggleEnginePause;
const appSettingsMock = mocks.appSettings;
vi.mock("../../../../api/legacy", () => ({
  fetchCodebaseMetrics: vi.fn().mockResolvedValue({ tokenEstimate: 0, sourceFileCount: 0, sourceByteCount: 0, diskBytes: 0, diskFileCount: 0, method: "local", truncated: false }),
  api: (path: string, opts?: RequestInit) => mocks.api(path, opts),
  withProjectId: (path: string, projectId?: string) =>
    projectId ? `${path}${path.includes("?") ? "&" : "?"}projectId=${encodeURIComponent(projectId)}` : path,
  apiBackfillGithubSourceIssueClosedAt: (options?: { offset?: number; limit?: number }, projectId?: string) =>
    mocks.backfillGithubSourceIssueClosedAt(options, projectId),
  backfillCommitAssociationDiffStats: (options?: { dryRun?: boolean }, projectId?: string) =>
    mocks.backfillCommitAssociationDiffStats(options, projectId),
  fetchOrgTree: mocks.fetchOrgTree,
  fetchExecutorStats: mocks.fetchExecutorStats,
  fetchSettings: mocks.fetchSettings,
  updateSettings: mocks.updateSettings,
}));

vi.mock("../../../../hooks/useAppSettings", () => ({
  useAppSettings: () => ({
    globalPaused: mocks.appSettings.globalPaused,
    enginePaused: mocks.appSettings.enginePaused,
    toggleEnginePause: mocks.toggleEnginePause,
  }),
}));

import { GithubArea } from "../GithubArea";
import { SignalsArea } from "../SignalsArea";
import { customRange, githubFixture, range7d } from "./areas.test-harness";

beforeEach(() => {
  apiMock.mockReset();
  backfillGithubSourceIssueClosedAtMock.mockReset();
  backfillCommitAssociationDiffStatsMock.mockReset();
  fetchOrgTreeMock.mockReset();
  fetchOrgTreeMock.mockResolvedValue([]);
  fetchExecutorStatsMock.mockReset();
  fetchExecutorStatsMock.mockResolvedValue({
    globalPause: false,
    enginePaused: false,
    maxConcurrent: 2,
    lastActivityAt: "2026-06-19T12:00:00.000Z",
  });
  mocks.fetchSettings.mockReset();
  mocks.fetchSettings.mockResolvedValue({ heartbeatMultiplier: 1 });
  mocks.updateSettings.mockReset();
  mocks.updateSettings.mockResolvedValue({});
  toggleEnginePauseMock.mockReset();
  appSettingsMock.globalPaused = false;
  appSettingsMock.enginePaused = false;
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  window.dispatchEvent(new Event("resize"));
});

describe("GithubArea", () => {
  it("appends projectId to its github request when supplied, and omits it when not", async () => {
    apiMock.mockResolvedValue(githubFixture());
    const { unmount } = render(<GithubArea range={range7d} projectId="proj-gh" />);
    await screen.findByTestId("cc-area-github");
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe("/command-center/github?from=2026-06-08&projectId=proj-gh");
    unmount();

    apiMock.mockClear();
    apiMock.mockResolvedValue(githubFixture());
    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    expect(apiMock.mock.calls.at(-1)?.[0]).toBe("/command-center/github?from=2026-06-08");
  });

  it("renders filed/fixed/net stats, daily trend, and by-repo bars", async () => {
    apiMock.mockResolvedValue(githubFixture());
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-filed").textContent).toContain("5");
    expect(screen.getByTestId("cc-github-fixed").textContent).toContain("3");
    expect(screen.getByTestId("cc-github-net").textContent).toContain("2");
    expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-github-line")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed vs fixed share" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed vs fixed line" })).toBeTruthy();
    expect(screen.getByTestId("cc-github-daily-trend")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Filed" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Fixed" })).toBeTruthy();
    const repoChart = screen.getByRole("list", { name: "By repository" });
    expect(within(repoChart).getByText("acme/alpha")).toBeTruthy();
    expect(within(repoChart).getByLabelText("acme/alpha: 4 filed / 1 fixed")).toBeTruthy();
  });

  it("renders resolved issues with safe outbound links and approximation labels", async () => {
    apiMock.mockResolvedValue({
      ...githubFixture(),
      resolved: [
        {
          taskId: "FN-100",
          taskTitle: "Fix alpha crash",
          repo: "acme/alpha",
          issueNumber: 123,
          url: "https://github.com/acme/alpha/issues/123",
          resolvedAt: "2026-06-10T12:34:56.000Z",
          resolvedAtExact: true,
        },
        {
          taskId: "FN-101",
          taskTitle: "Patch unknown import",
          repo: "(unknown)",
          issueNumber: null,
          url: null,
          resolvedAt: "2026-06-09T08:00:00.000Z",
          resolvedAtExact: false,
        },
      ],
    });

    render(<GithubArea range={range7d} />);

    const section = await screen.findByTestId("cc-github-resolved");
    expect(section.textContent).toContain("Resolved issues");
    expect(section.textContent).toContain("acme/alpha#123");
    expect(section.textContent).toContain("Fix alpha crash");
    expect(section.textContent).toContain("FN-100");
    expect(section.textContent).toContain("(unknown)");
    expect(section.textContent).toContain("Patch unknown import");
    expect(section.textContent).toContain("approx");
    expect(section.textContent).toContain("2026");

    const linkedIssue = within(section).getByRole("link", { name: "Open GitHub issue acme/alpha#123" });
    expect(linkedIssue.getAttribute("href")).toBe("https://github.com/acme/alpha/issues/123");
    expect(linkedIssue.getAttribute("target")).toBe("_blank");
    expect(linkedIssue.getAttribute("rel")).toBe("noopener noreferrer");
    expect(within(section).queryByRole("link", { name: /unknown/i })).toBeNull();
  });

  it("omits the resolved issues section for an empty resolved list", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), resolved: [] });

    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.queryByTestId("cc-github-resolved")).toBeNull();
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("NaN");
  });

  it("renders the empty state without empty chart shells", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), filed: 0, fixed: 0, net: 0, daily: [], byRepo: [] });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-area-github").textContent).toContain("No GitHub issue activity");
    expect(screen.getByTestId("cc-github-backfill-button")).toBeTruthy();
    expect(screen.queryByTestId("cc-github-pie")).toBeNull();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
    expect(screen.queryByTestId("cc-github-daily-trend")).toBeNull();
    expect(screen.queryByTestId("cc-github-by-repo")).toBeNull();
  });

  it("renders loading and error states", async () => {
    apiMock.mockImplementationOnce(() => new Promise(() => undefined));
    const { unmount } = render(<GithubArea range={range7d} />);
    expect(screen.getByTestId("cc-area-github-loading")).toBeTruthy();
    expect(screen.queryByTestId("cc-github-pie")).toBeNull();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
    unmount();

    apiMock.mockRejectedValueOnce(new Error("github failed"));
    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github-error");
    expect(screen.getByTestId("cc-area-github-error").textContent).toContain("github failed");
    expect(screen.queryByTestId("cc-github-pie")).toBeNull();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
  });

  it("handles undefined chart arrays and zero values without NaN output", async () => {
    apiMock.mockResolvedValue({ ...githubFixture(), filed: 1, fixed: 0, net: 1, daily: undefined, byRepo: undefined });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
    expect(screen.queryByTestId("cc-github-line")).toBeNull();
    expect(screen.queryByTestId("cc-github-daily-trend")).toBeNull();
    expect(screen.queryByTestId("cc-github-by-repo")).toBeNull();
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("NaN");
  });

  it("keeps GitHub recharts safe for single-item and non-finite daily data", async () => {
    apiMock.mockResolvedValue({
      ...githubFixture(),
      filed: 1,
      fixed: 1,
      net: 0,
      daily: [{ date: "2026-06-08", filed: Number.NaN, fixed: Number.POSITIVE_INFINITY }],
      byRepo: [{ repo: "acme/broken", filed: Number.NaN, fixed: -1 }],
    });
    render(<GithubArea range={range7d} />);

    await screen.findByTestId("cc-area-github");
    expect(screen.getByTestId("cc-github-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-github-line")).toBeTruthy();
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-area-github").textContent).not.toContain("Infinity");
  });

  it("rejects an inverted custom range client-side without fetching", async () => {
    render(<GithubArea range={customRange("2026-06-10", "2026-06-01")} />);
    await waitFor(() => expect(apiMock).not.toHaveBeenCalled());
  });

  it("runs a single backfill batch and renders accumulated result counts", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValueOnce({
      scanned: 4,
      filled: 2,
      skipped: 1,
      errors: 0,
      hasMore: false,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");

    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    await screen.findByText(/Backfill complete/i);
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledWith({ offset: 0, limit: 100 }, undefined);
    const result = screen.getByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("Scanned 4, filled 2, skipped 1, errors 0");
  });

  it("paginates multi-batch backfills with advancing offsets and summed counts", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock
      .mockResolvedValueOnce({ scanned: 100, filled: 4, skipped: 90, errors: 1, hasMore: true })
      .mockResolvedValueOnce({ scanned: 25, filled: 3, skipped: 22, errors: 0, hasMore: false });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    await waitFor(() => expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledTimes(2));
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenNthCalledWith(1, { offset: 0, limit: 100 }, undefined);
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenNthCalledWith(2, { offset: 100, limit: 100 }, undefined);
    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("Scanned 125, filled 7, skipped 112, errors 1");
    expect(result.className).toContain("cc-github-backfill-status--error");
  });

  it("shows the all-zero backfill as nothing to backfill instead of an error", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValueOnce({
      scanned: 0,
      filled: 0,
      skipped: 0,
      errors: 0,
      hasMore: false,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("Nothing to backfill");
    expect(result.className).not.toContain("cc-github-backfill-status--error");
  });

  it("surfaces nonzero backfill error counts without throwing", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValueOnce({
      scanned: 8,
      filled: 1,
      skipped: 5,
      errors: 2,
      hasMore: false,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("errors 2");
    expect(result.className).toContain("cc-github-backfill-status--error");
  });

  it("captures endpoint failures in local error UI", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockRejectedValueOnce(new Error("endpoint failed"));

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByTestId("cc-github-backfill-result");
    expect(result.textContent).toContain("endpoint failed");
    expect(result.className).toContain("cc-github-backfill-status--error");
  });

  it("disables and guards the button while a backfill is in flight", async () => {
    apiMock.mockResolvedValue(githubFixture());
    let resolveBackfill: ((value: { scanned: number; filled: number; skipped: number; errors: number; hasMore: boolean }) => void) | null = null;
    backfillGithubSourceIssueClosedAtMock.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveBackfill = resolve;
      }),
    );

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    const button = screen.getByTestId("cc-github-backfill-button") as HTMLButtonElement;
    fireEvent.click(button);

    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledTimes(1);

    resolveBackfill?.({ scanned: 1, filled: 1, skipped: 0, errors: 0, hasMore: false });
    await screen.findByText(/Backfill complete/i);
  });

  it("stops a pathological always-has-more response at the max iteration guard", async () => {
    apiMock.mockResolvedValue(githubFixture());
    backfillGithubSourceIssueClosedAtMock.mockResolvedValue({
      scanned: 1,
      filled: 0,
      skipped: 1,
      errors: 0,
      hasMore: true,
    });

    render(<GithubArea range={range7d} />);
    await screen.findByTestId("cc-area-github");
    fireEvent.click(screen.getByTestId("cc-github-backfill-button"));

    const result = await screen.findByText(/safety limit/i);
    expect(result.textContent).toContain("safety limit");
    expect(backfillGithubSourceIssueClosedAtMock).toHaveBeenCalledTimes(1000);
    expect(screen.getByTestId("cc-github-backfill-result").textContent).toContain("Scanned 1000");
  });
});

// FN-6684 Mission Control decision: no extra pie/line test here because MissionControlPanel already renders the live SDLC Funnel for its only quantitative distribution; adding a pie would duplicate that affordance.
function mockSignalsResponses(signals: unknown, connectors: unknown): void {
  apiMock.mockImplementation((path: string) => {
    if (path.startsWith("/command-center/signals/connectors")) return Promise.resolve(connectors);
    return Promise.resolve(signals);
  });
}

describe("SignalsArea", () => {
  it("appends projectId to both its signals requests when supplied", async () => {
    apiMock.mockResolvedValue({
      open: 0,
      totalSignals: 0,
      resolved: 0,
      bySource: [],
      byType: [],
      mttr: { value: null, unavailable: true },
    });
    render(<SignalsArea range={range7d} projectId="proj-sig" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2));
    expect(apiMock.mock.calls.every(([path]) => typeof path === "string" && path.includes("projectId=proj-sig"))).toBe(true);
  });

  it("renders the empty state (not an error) when the signals endpoint is missing", async () => {
    apiMock.mockRejectedValue(new Error("API returned HTML instead of JSON (404)"));
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals-empty");
    // Must not surface the error UI.
    expect(screen.queryByTestId("cc-area-signals-error")).toBeNull();
    expect(screen.queryByTestId("cc-signals-pie")).toBeNull();
  });

  it("renders signal metrics and status pie when data is present", async () => {
    mockSignalsResponses(
      {
        totalSignals: 8,
        open: 3,
        resolved: 5,
        mttr: { value: 42, unavailable: false },
        bySource: [
          { source: "gitlab", count: 3 },
          { source: "sentry", count: 5 },
        ],
        bySeverity: [{ severity: "error", count: 8 }],
      },
      { connectors: [] },
    );
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals");
    expect(screen.getByTestId("cc-signals-total").textContent).toContain("8");
    expect(screen.getByTestId("cc-signals-mttr").textContent).toContain("42");
    expect(screen.getByTestId("cc-signals-pie")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Signal status share" })).toBeTruthy();
    expect(screen.getByTestId("cc-area-signals").textContent).toContain("gitlab");
  });

  it("keeps signals pie safe for single-item and non-finite source/severity data", async () => {
    mockSignalsResponses(
      {
        totalSignals: 1,
        open: 1,
        resolved: 0,
        mttr: { value: null, unavailable: true },
        bySource: [{ source: "broken", count: Number.NaN }],
        bySeverity: [{ severity: "broken", count: Number.POSITIVE_INFINITY }],
      },
      { connectors: [] },
    );
    render(<SignalsArea range={range7d} />);
    await screen.findByTestId("cc-area-signals");
    expect(screen.getByTestId("cc-signals-pie")).toBeTruthy();
    expect(screen.getByTestId("cc-area-signals").textContent).not.toContain("NaN");
    expect(screen.getByTestId("cc-area-signals").textContent).not.toContain("Infinity");
  });

  it("renders the not-configured zero state without a pie shell", async () => {
    mockSignalsResponses(
      {
        totalSignals: 0,
        open: 0,
        resolved: 0,
        mttr: { value: null, unavailable: true },
        bySource: [],
        bySeverity: [],
        connectors: { configured: [], anyConfigured: false },
      },
      { connectors: [] },
    );
    render(<SignalsArea range={range7d} />);
    const empty = await screen.findByTestId("cc-area-signals-empty");
    expect(empty.textContent).toContain("No signal connector configured");
    expect(empty.textContent).toContain("GitLab");
    expect(screen.queryByTestId("cc-signals-pie")).toBeNull();
  });

  it("keeps legacy zero responses without connectors on the setup CTA", async () => {
    mockSignalsResponses(
      {
        totalSignals: 0,
        open: 0,
        resolved: 0,
        mttr: { value: null, unavailable: true },
        bySource: [],
        bySeverity: [],
      },
      { connectors: [] },
    );
    render(<SignalsArea range={range7d} />);
    const empty = await screen.findByTestId("cc-area-signals-empty");
    expect(empty.textContent).toContain("No signal connector configured");
    expect(screen.queryByTestId("cc-signals-pie")).toBeNull();
  });

  it("renders configured-but-quiet zero signals distinctly on desktop and mobile", async () => {
    for (const width of [1024, 390]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      window.dispatchEvent(new Event("resize"));
      mockSignalsResponses(
        {
          totalSignals: 0,
          open: 0,
          resolved: 0,
          mttr: { value: null, unavailable: true },
          bySource: [],
          bySeverity: [],
          connectors: { configured: ["gitlab", "sentry", "pagerduty"], anyConfigured: true },
        },
        {
          connectors: [
            { provider: "gitlab", configured: true },
            { provider: "sentry", configured: true },
            { provider: "pagerduty", configured: true },
          ],
        },
      );
      const rendered = render(<SignalsArea range={range7d} />);
      const empty = await screen.findByTestId("cc-area-signals-empty");
      expect(empty.textContent).toContain("Connector configured, awaiting signals in this range");
      expect(empty.textContent).toContain("gitlab, sentry, pagerduty");
      expect(screen.queryByTestId("cc-signals-pie")).toBeNull();
      rendered.unmount();
    }
  });
});
