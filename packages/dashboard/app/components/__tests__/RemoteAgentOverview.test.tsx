import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { RemoteAgentOverview } from "../RemoteAgentOverview";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));

/*
FNXC:ExternalSessionOverview 2026-09-24-08:12:
What the overview must never do: state a total without saying what it could not price, or present the
Fusion-run figure as something to add to task telemetry.
*/
const page = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, totalUsd: 12.5,
  coverage: { scanned: 10, priced: 8, unpriced: 1, withoutUsage: 1, truncated: false, pricedTotalUsd: 12.5 },
  byDay: [{ key: "2026-09-20", usd: 7.5, sessions: 2 }, { key: "2026-09-21", usd: 5, sessions: 1 }],
  byModel: [{ key: "gpt-5.6-sol", usd: 12.5, sessions: 3 }],
  byHost: [{ key: "m3", usd: 12.5, sessions: 3 }],
  fusionAttributed: { sessions: 0, usd: 0, ambiguous: 0 }, ...over });

afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("remote agent cost overview", () => {
  it("states the range total with the breakdown that explains it", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentOverview projectId="project-a" />);
    const coverage = await screen.findByLabelText("Cost overview coverage");
    expect(coverage).toHaveTextContent("$12.5");
    expect(within(await screen.findByLabelText("By day")).getByText("2026-09-20")).toBeInTheDocument();
    expect(screen.getByLabelText("By model")).toHaveTextContent("gpt-5.6-sol");
    expect(screen.getByLabelText("By server")).toHaveTextContent("m3");
  });

  it("never states a total without saying what it could not price", async () => {
    vi.mocked(api).mockResolvedValue(page({ coverage: { scanned: 10, priced: 8, unpriced: 1, withoutUsage: 1, truncated: true, pricedTotalUsd: 12.5 } }) as never);
    render(<RemoteAgentOverview projectId="project-a" />);
    const coverage = await screen.findByLabelText("Cost overview coverage");
    expect(coverage).toHaveTextContent("8 of 10 sessions examined could be priced");
    expect(coverage).toHaveTextContent("1 reported usage with no applicable rate");
    expect(coverage).toHaveTextContent("1 reported no usage at all");
    expect(coverage).toHaveTextContent("scan limit was reached");
  });

  it("presents Fusion-run cost as part of this total, not as a figure to add to task telemetry", async () => {
    vi.mocked(api).mockResolvedValue(page({ fusionAttributed: { sessions: 2, usd: 4, ambiguous: 1 } }) as never);
    render(<RemoteAgentOverview projectId="project-a" />);
    const coverage = await screen.findByLabelText("Cost overview coverage");
    expect(coverage).toHaveTextContent("of this total");
    expect(coverage).toHaveTextContent("already counted in task telemetry");
    expect(coverage).toHaveTextContent("1 session matches more than one Fusion run");
  });

  it("says nothing about attribution when nothing was proven, rather than claiming separation", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentOverview projectId="project-a" />);
    const coverage = await screen.findByLabelText("Cost overview coverage");
    expect(coverage).not.toHaveTextContent("task telemetry");
    // The absence of proof must not be rendered as "none of these overlap".
    expect(coverage).not.toHaveTextContent("no overlap");
  });

  it("surfaces a malformed response as an error instead of a confident zero", async () => {
    vi.mocked(api).mockResolvedValue({ schemaVersion: 1 } as never);
    render(<RemoteAgentOverview projectId="project-a" />);
    expect(await screen.findByRole("alert", { name: "Cost overview error" })).toHaveTextContent("malformed");
    expect(screen.queryByLabelText("By day")).not.toBeInTheDocument();
  });
});
