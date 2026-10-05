import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RemoteAgentCostPopover } from "../RemoteAgentCostPopover";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

/*
FNXC:RemoteAgents 2026-09-26-23:39: the cost popover is reachable by pointer, keyboard focus and click, and it
never shows an unpriced amount as $0. These cases pin both halves.
*/
const rates = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75, cacheWriteHourPer1M: null, cacheWriteHourSource: null, source: "Fusion" };
const priced = { model: "claude-sonnet-5", input: 1_000_000, cached: 0, cacheWrite: 0, cacheWriteHour: 2000, output: 100_000,
  reasoning: 500, usd: 4.5, rates, reason: null,
  charges: { freshInput: 3, cachedInput: 0, cacheWrite: 0, cacheWriteHour: 0, output: 1.5 } };
const unpriced = { model: "mystery-model", input: 10, cached: 0, cacheWrite: 0, cacheWriteHour: 0, output: 5, reasoning: null,
  usd: null, rates: null, reason: "No rate for mystery-model", charges: null };
const body = { usage: [priced, unpriced], estimatedUsd: null, partialUsd: 4.5, usageComplete: true,
  pricingDate: "2026-09-01", pricingSource: "Fusion", pricedFromIncrements: false };

function setup() {
  vi.mocked(api).mockResolvedValue(body as never);
  render(<RemoteAgentCostPopover sessionId={"a".repeat(64)} projectId="project-a" label="$4.50 priced so far" />);
  return screen.getByRole("button", { name: "$4.50 priced so far" });
}

describe("remote agent cost popover", () => {
  it("opens on click with categories, rates and charges, and pins until clicked again", async () => {
    const trigger = setup();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(api).not.toHaveBeenCalled(); // closed cards fetch nothing
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const sonnet = await screen.findByRole("table", { name: /claude-sonnet-5/ });
    const input = within(sonnet).getByRole("row", { name: /Fresh input/ });
    // Cells are tokens, rate, charge; checked separately so the rate text cannot satisfy the charge.
    expect(within(input).getAllByRole("cell").map(c => c.textContent)).toEqual(["1,000,000", "$3.00 / 1M", "$3.00"]);
    expect(within(within(sonnet).getByRole("row", { name: /^Output/ })).getAllByRole("cell")[2]).toHaveTextContent("$1.50");
    expect(api).toHaveBeenCalledWith(expect.stringContaining("/external-sessions/" + "a".repeat(64) + "/cost"), expect.anything());
    fireEvent.mouseLeave(trigger.parentElement!);
    expect(trigger).toHaveAttribute("aria-expanded", "true"); // pinned by the click
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("never shows an unpriced amount as a $0 charge", async () => {
    fireEvent.click(setup());
    // Tokens with no rate: the one-hour cache writes here have no rate, so they are unpriced, not free.
    const sonnet = await screen.findByRole("table", { name: /claude-sonnet-5/ });
    expect(within(sonnet).getByRole("row", { name: /Cache writes \(1 hour\)/ })).toHaveTextContent("Not priced");
    const mystery = screen.getByRole("table", { name: /mystery-model · Unpriced/ });
    expect(within(mystery).getAllByText("Not priced")).toHaveLength(5);
    expect(mystery).toHaveTextContent("No rate for mystery-model");
    expect(screen.getByText(/Priced so far \$4\.50 \(incomplete\)/)).toBeInTheDocument();
  });

  it("opens on keyboard focus and hover, and Escape closes it and returns focus", async () => {
    const user = userEvent.setup();
    const trigger = setup();
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("region", { name: "Cost breakdown" });
    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    fireEvent.mouseEnter(trigger.parentElement!);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.mouseLeave(trigger.parentElement!);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
