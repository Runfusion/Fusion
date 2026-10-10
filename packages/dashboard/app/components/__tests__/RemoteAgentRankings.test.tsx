import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RemoteAgentRankings } from "../RemoteAgentRankings";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));
const entry = (over: Record<string, unknown> = {}) => ({ sessionId: "a".repeat(64), hostId: "j", provider: "claude",
  title: "Expensive session", at: "2026-09-20T10:00:00.000Z", usd: 1.5, nativeTurnId: "t1", ordinal: 0,
  recordedRates: true, recalculated: false, dominant: "output", dominantUsd: 1.2, requests: 3, ...over });
const page = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, scope: "turns", entries: [entry()],
  coverage: { scanned: 10, priced: 8, unpriced: 1, withoutUsage: 1, truncated: false, pricedTotalUsd: 12.25 }, ...over });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("expensive work rankings", () => {
  it("ranks work and always states coverage beside it", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Most expensive work" });
    expect(within(list).getByText("$1.50")).toBeInTheDocument();
    const coverage = screen.getByRole("status", { name: "Ranking coverage" });
    // Without coverage the list silently answers "the priciest work we had rates for".
    expect(coverage).toHaveTextContent("Ranked 8 priced of 10 turns examined");
    expect(coverage).toHaveTextContent("$12.25 total across all priced turns");
    expect(coverage).toHaveTextContent("1 reported usage with no applicable rate");
    expect(coverage).toHaveTextContent("1 reported no usage at all");
  });

  it("explains cost with the measured dominant category and request volume", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Most expensive work" });
    expect(list).toHaveTextContent("Mostly output ($1.20 of $1.50) · 3 priced requests");
  });

  it("says drivers are unavailable rather than inventing a cause", async () => {
    vi.mocked(api).mockResolvedValue(page({ entries: [entry({ dominant: null, dominantUsd: 0, requests: 0 })] }) as never);
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Most expensive work" });
    expect(list).toHaveTextContent("Cost drivers unavailable · 0 priced requests");
    expect(list).not.toHaveTextContent("Mostly");
  });

  it("says when the scan was cut instead of implying the ranking is complete", async () => {
    vi.mocked(api).mockResolvedValue(page({ coverage: { scanned: 2000, priced: 2000, unpriced: 0, withoutUsage: 0, truncated: true, pricedTotalUsd: 99 } }) as never);
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("status", { name: "Ranking coverage" })).toHaveTextContent("scan limit was reached"));
  });

  it("distinguishes recorded rates from a recalculation on each row", async () => {
    vi.mocked(api).mockResolvedValue(page({ entries: [
      entry({ nativeTurnId: "recorded" }),
      entry({ nativeTurnId: "old", recordedRates: false, recalculated: true, usd: 0.5 }),
    ] }) as never);
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Most expensive work" });
    expect(list).toHaveTextContent("At recorded rates");
    expect(list).toHaveTextContent("Recalculated at today’s rates");
  });

  it("passes date, model and scope filters to the server", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentRankings projectId="project-a" hostId="m3" onOpenSession={vi.fn()} />);
    await waitFor(() => expect(vi.mocked(api).mock.calls.length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-sonnet-5" } });
    fireEvent.change(screen.getByLabelText("Rank"), { target: { value: "sessions" } });
    await waitFor(() => {
      const last = String(vi.mocked(api).mock.calls.at(-1)![0]);
      expect(last).toContain("scope=sessions");
      expect(last).toContain("hostId=m3");
      expect(last).toContain("model=claude-sonnet-5");
      // A calendar day must cover the whole day, or a single-day filter matches nothing.
      expect(last).toContain("from=2026-09-01T00%3A00%3A00.000Z");
    });
  });

  it("opens the owning session from a ranked row", async () => {
    const onOpenSession = vi.fn();
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByText("$1.50"));
    expect(onOpenSession).toHaveBeenCalledWith("a".repeat(64));
  });

  it("surfaces a failure instead of reporting no expensive work", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Rankings unavailable"));
    render(<RemoteAgentRankings projectId="project-a" onOpenSession={vi.fn()} />);
    expect(await screen.findByRole("alert", { name: "Rankings error" })).toHaveTextContent("Rankings unavailable");
    expect(screen.queryByText("No priced work matched these filters.")).toBeNull();
  });
});
