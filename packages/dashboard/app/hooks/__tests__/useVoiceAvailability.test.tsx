import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { __resetVoiceAvailabilityCache, useVoiceAvailability } from "../useVoiceAvailability";

function Harness({ projectId, label }: { projectId?: string; label: string }) {
  const availability = useVoiceAvailability(projectId);
  return <output data-testid={label}>{JSON.stringify(availability)}</output>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("useVoiceAvailability", () => {
  beforeEach(() => {
    __resetVoiceAvailabilityCache();
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("deduplicates concurrent project requests and evicts settled entries", async () => {
    const first = deferred<Response>();
    vi.mocked(fetch).mockResolvedValueOnce(first.promise).mockResolvedValue(new Response(JSON.stringify({ enabled: false })));
    const view = render(<><Harness projectId="alpha" label="first" /><Harness projectId="alpha" label="second" /></>);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/voice/status?projectId=alpha");
    first.resolve(new Response(JSON.stringify({ enabled: true })));
    await waitFor(() => expect(screen.getByTestId("first").textContent).toContain('"enabled":true'));
    await waitFor(() => expect(screen.getByTestId("second").textContent).toContain('"enabled":true'));
    view.unmount();
    render(<Harness projectId="alpha" label="later" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("keeps projects isolated by their scoped status URLs and results", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify({ enabled: String(url).includes("alpha") })));
    render(<><Harness projectId="alpha" label="alpha" /><Harness projectId="beta value" label="beta" /><Harness label="default" /></>);
    await waitFor(() => expect(screen.getByTestId("alpha").textContent).toContain('"enabled":true'));
    await waitFor(() => expect(screen.getByTestId("beta").textContent).toContain('"enabled":false'));
    expect(fetch).toHaveBeenCalledWith("/api/voice/status?projectId=alpha");
    expect(fetch).toHaveBeenCalledWith("/api/voice/status?projectId=beta%20value");
    expect(fetch).toHaveBeenCalledWith("/api/voice/status");
  });

  it("fails closed on rejected, non-OK, and malformed status responses", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(new Response("not-json"));
    const { rerender } = render(<Harness projectId="rejected" label="voice" />);
    await waitFor(() => expect(screen.getByTestId("voice").textContent).toBe('{"enabled":false,"supported":false}'));
    rerender(<Harness projectId="not-ok" label="voice" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    rerender(<Harness projectId="malformed" label="voice" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("voice").textContent).toBe('{"enabled":false,"supported":false}');
  });

  it("does not abort a shared request when one consumer departs or changes projects", async () => {
    const alpha = deferred<Response>();
    const beta = deferred<Response>();
    vi.mocked(fetch).mockImplementation((url) => String(url).includes("alpha") ? alpha.promise : beta.promise);
    const { rerender } = render(<><Harness projectId="alpha" label="departing" /><Harness projectId="alpha" label="remaining" /></>);
    rerender(<><Harness projectId="beta" label="departing" /><Harness projectId="alpha" label="remaining" /></>);
    expect(fetch).toHaveBeenCalledTimes(2);
    alpha.resolve(new Response(JSON.stringify({ enabled: true })));
    await waitFor(() => expect(screen.getByTestId("remaining").textContent).toContain('"enabled":true'));
    beta.resolve(new Response(JSON.stringify({ enabled: false })));
    await waitFor(() => expect(screen.getByTestId("departing").textContent).toContain('"enabled":false'));
  });
});
