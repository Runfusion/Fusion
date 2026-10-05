import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RemoteAgentSearch, highlightSegments } from "../RemoteAgentSearch";
import { api } from "../../api/client/client";

vi.mock("../../api/client/client", () => ({ api: vi.fn() }));
const hit = (over: Record<string, unknown> = {}) => ({
  sessionId: "a".repeat(64), hostId: "j", provider: "codex", title: "Fixture agent",
  nativeTurnId: "turn-a", ordinal: 0, snippet: "applied the <mark>migration</mark> cleanly", rank: 0.5, ...over,
});
const page = (over: Record<string, unknown> = {}) => ({ schemaVersion: 1, hits: [hit()], more: false, query: "migration", ...over });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("remote agent output search", () => {
  it("searches and shows a highlighted excerpt with its session and turn", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentSearch projectId="project-a" onOpenSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "migration" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const results = await screen.findByRole("list", { name: "Search results" });
    expect(within(results).getByText("migration").tagName).toBe("MARK");
    expect(results).toHaveTextContent("j · codex · turn 1");
    expect(screen.getByRole("status", { name: "Search status" })).toHaveTextContent("1 match for migration");
  });

  it("renders a snippet as text and never as markup", async () => {
    // ts_headline returns transcript text. If this were injected as HTML, collected output could inject script.
    const snippet = 'see <mark>needle</mark> in <img src=x onerror="alert(1)"> and <script>alert(2)</script>';
    vi.mocked(api).mockResolvedValue(page({ hits: [hit({ snippet })] }) as never);
    const { container } = render(<RemoteAgentSearch projectId="project-a" onOpenSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByRole("list", { name: "Search results" });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText(/onerror/)).toBeInTheDocument();
    expect(screen.getByText("needle").tagName).toBe("MARK");
  });

  it("opens the owning session when a result is chosen", async () => {
    const onOpenSession = vi.fn();
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentSearch projectId="project-a" onOpenSession={onOpenSession} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "migration" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByText("Fixture agent"));
    expect(onOpenSession).toHaveBeenCalledWith("a".repeat(64));
  });

  it("explains a stopword-only search instead of showing an empty result list", async () => {
    vi.mocked(api).mockResolvedValue(page({ hits: [], query: null }) as never);
    render(<RemoteAgentSearch projectId="project-a" onOpenSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "the and" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Search status" })).toHaveTextContent("no searchable words"));
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("says the result list was cut rather than implying it is complete", async () => {
    vi.mocked(api).mockResolvedValue(page({ more: true }) as never);
    render(<RemoteAgentSearch projectId="project-a" onOpenSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "migration" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/More turns matched than are shown/)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Search status" })).toHaveTextContent("1+ matches");
  });

  it("scopes the search to the active server filter", async () => {
    vi.mocked(api).mockResolvedValue(page() as never);
    render(<RemoteAgentSearch projectId="project-a" hostId="m3" onOpenSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "migration" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(vi.mocked(api).mock.calls[0]![0]).toContain("hostId=m3"));
  });

  it("surfaces a failed search instead of reporting zero matches", async () => {
    vi.mocked(api).mockRejectedValue(new Error("Search unavailable"));
    render(<RemoteAgentSearch projectId="project-a" onOpenSession={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search prompts and responses"), { target: { value: "migration" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("alert", { name: "Search error" })).toHaveTextContent("Search unavailable");
    expect(screen.getByRole("status", { name: "Search status" })).toHaveTextContent("");
  });

  it("splits highlight delimiters without losing surrounding text", () => {
    expect(highlightSegments("a <mark>b</mark> c")).toEqual([
      { text: "a ", match: false }, { text: "b", match: true }, { text: " c", match: false },
    ]);
    expect(highlightSegments("plain")).toEqual([{ text: "plain", match: false }]);
  });
});
