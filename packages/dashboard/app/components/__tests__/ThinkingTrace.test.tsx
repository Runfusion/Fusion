import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ThinkingTrace, parseThinkingSections, parseThinkingTrace } from "../ThinkingTrace";
import { FileBrowserProvider } from "../../context/FileBrowserContext";
import { loadComponentCss } from "../../test/cssFixture";

const trace = [
  "Preamble before the first title.", "", "**Ensuring Docker build includes dev dependencies for tests**", "", "The Docker image needs development dependencies for test execution.", "A second paragraph remains with this title.", "", "**Planning deployment commit structure**", "", "Deployment commits should be split by independently reviewable behavior.", "A second deployment paragraph remains visible.", "", "**Editing README content**", "", "The README change belongs in its own reviewed update.", "A second README paragraph remains visible.",
].join("\n");

function sections() { return screen.getAllByTestId("thinking-trace-section"); }

afterEach(cleanup);

describe("parseThinkingSections", () => {
  it("keeps titles, bodies, preambles, duplicates, and inline bold content", () => {
    const value = "Preamble\n\n**One**\n\nBody **bold** stays.\n\n**One**\n\nSecond";
    expect(parseThinkingSections(value)).toEqual([
      { id: "0:", title: null, body: "Preamble" },
      { id: "1:One", title: "One", body: "Body **bold** stays." },
      { id: "2:One", title: "One", body: "Second" },
    ]);
  });

  it("keeps untitled input byte-identical", () => {
    expect(parseThinkingSections("  body\n\n")).toEqual([{ id: "s0", title: null, body: "  body\n\n" }]);
  });

  it("folds titles-only bold and ATX traces into visible untitled text", () => {
    const bold = "**One**\n\n**Two**\n\n**Three**";
    expect(parseThinkingTrace(bold)).toEqual({ sections: [{ id: "0:", title: null, body: bold }], inlinedHeadingCount: 3 });
    const atx = "# One\n\n## Two";
    expect(parseThinkingTrace(atx)).toEqual({ sections: [{ id: "0:", title: null, body: atx }], inlinedHeadingCount: 2 });
  });

  it("folds body-less headings into their preceding populated section without reindexing", () => {
    const value = "**A**\n\nBody A\n\n**B**\n\n**C**\n\nBody C";
    expect(parseThinkingTrace(value)).toEqual({
      sections: [
        { id: "1:A", title: "A", body: "Body A\n\n**B**" },
        { id: "3:C", title: "C", body: "Body C" },
      ],
      inlinedHeadingCount: 1,
    });
  });

  it("keeps a trailing partial heading inline until its body arrives", () => {
    const partial = "**A**\n\nBody A\n\n**B**";
    expect(parseThinkingTrace(partial)).toEqual({ sections: [{ id: "1:A", title: "A", body: "Body A\n\n**B**" }], inlinedHeadingCount: 1 });
    expect(parseThinkingTrace(`${partial}\n\nBody B`)).toEqual({
      sections: [{ id: "1:A", title: "A", body: "Body A" }, { id: "2:B", title: "B", body: "Body B" }],
      inlinedHeadingCount: 0,
    });
  });

  it("only returns titled sections with real bodies across trace states", () => {
    for (const input of ["  body\n\n", trace, "**One**\n\n**Two**", "**A**\n\nBody A\n\n**B**", "**A**\n\nBody A\n\n**B**", " \n\t"]) {
      expect(parseThinkingSections(input).every((section) => section.title === null || section.body.trim().length > 0)).toBe(true);
    }
    expect(parseThinkingTrace("  body\n\n").inlinedHeadingCount).toBe(0);
  });
});

describe("ThinkingTrace", () => {
  it("renders no shell for empty reasoning and leaves heading-free text unsectioned", () => {
    const { container, unmount } = render(<ThinkingTrace text={" \n\t"} />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    render(<ThinkingTrace text={"Untitled reasoning\n\nkeeps its source layout."} />);
    expect(screen.getByText(/Untitled reasoning/)).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-trace-section")).toBeNull();
    expect(screen.queryByTestId("thinking-trace-raw-toggle")).toBeNull();
    expect(screen.queryByRole("button", { name: /collapse all|expand all/i })).toBeNull();
  });

  it("keeps every populated title expanded and isolated until its own section is collapsed", () => {
    render(<ThinkingTrace text={trace} />);
    expect(sections()).toHaveLength(4);
    const renderedBodies = sections().map((section) => section.textContent).join("\n");
    expect(renderedBodies).toContain("The Docker image needs development dependencies for test execution.");
    expect(renderedBodies).toContain("Deployment commits should be split by independently reviewable behavior.");
    expect(renderedBodies).toContain("The README change belongs in its own reviewed update.");
    const deployment = sections().find((section) => section.textContent?.includes("Planning deployment commit structure"))!;
    expect(deployment.textContent).toContain("Deployment commits should be split by independently reviewable behavior.");
    fireEvent.click(within(deployment).getByText("Planning deployment commit structure"));
    expect(deployment).not.toHaveAttribute("open");
    expect(sections().find((section) => section.textContent?.includes("Editing README content"))).toHaveAttribute("open");
  });

  it("keeps titles-only headings visible without empty rows or empty-state labels", () => {
    render(<ThinkingTrace text={"**One**\n\n**Two**\n\n**Three**"} />);
    expect(screen.queryAllByTestId("thinking-trace-section")).toHaveLength(0);
    expect(screen.queryAllByText("No reasoning captured for this step")).toHaveLength(0);
    const removedEmptyMessageClass = ["thinking", "trace", "empty", "message"].join("-");
    expect(document.querySelectorAll(`.${removedEmptyMessageClass}`)).toHaveLength(0);
    expect(screen.getByText(/\*\*One\*\*/)).toBeInTheDocument();
  });

  it("renders only populated mixed headings as sections and keeps folded headings in the preceding body", () => {
    render(<ThinkingTrace text={"**A**\n\nBody A\n\n**B**\n\n**C**\n\nBody C"} />);
    expect(sections()).toHaveLength(2);
    expect(sections()[0].textContent).toContain("**B**");
  });

  it("toggles all populated sections", () => {
    render(<ThinkingTrace text={"**One**\n\nBody one\n\n**Two**\n\nBody two"} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(sections().every((section) => !section.hasAttribute("open"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(sections().every((section) => section.hasAttribute("open"))).toBe(true);
  });

  it("keeps duplicate titles independent and preserves explicit state across streaming appends", () => {
    const initial = "**Same**\n\nFirst body\n\n**Same**\n\nSecond body";
    const { rerender } = render(<ThinkingTrace text={initial} />);
    const initialSections = sections();
    fireEvent.click(within(initialSections[0]).getByText("Same"));
    rerender(<ThinkingTrace text={`${initial}\n\n**New**\n\nNew body`} />);
    expect(sections()[0]).toBe(initialSections[0]);
    expect(sections()[0]).not.toHaveAttribute("open");
  });

  it("shows a raw original trace and restores section state", () => {
    const text = "**One**\n\nBody one\n\n**Two**\n\nBody two";
    render(<ThinkingTrace text={text} format="markdown" />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    fireEvent.click(screen.getByTestId("thinking-trace-raw-toggle"));
    expect(screen.getByTestId("thinking-trace-raw")).toHaveTextContent("**One**");
    expect(screen.queryAllByTestId("thinking-trace-section")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /collapse all|expand all/i })).toBeNull();
    fireEvent.click(screen.getByTestId("thinking-trace-raw-toggle"));
    expect(sections().every((section) => !section.hasAttribute("open"))).toBe(true);
  });

  it("keeps the raw toggle reachable for folded markdown titles-only traces", () => {
    const text = "**One**\n\n**Two**\n\n**Three**";
    render(<ThinkingTrace text={text} format="markdown" />);
    expect(screen.queryAllByTestId("thinking-trace-section")).toHaveLength(0);
    expect(screen.getByText("One").tagName).toBe("STRONG");
    expect(screen.queryByRole("button", { name: /collapse all|expand all/i })).toBeNull();
    fireEvent.click(screen.getByTestId("thinking-trace-raw-toggle"));
    expect(screen.getByTestId("thinking-trace-raw")).toHaveTextContent("**One**");
  });

  it("uses markdown rendering and linkifies plain file paths", () => {
    const { rerender } = render(<ThinkingTrace text={"**Title**\n\nBody is **bold**."} format="markdown" />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    rerender(<FileBrowserProvider openFile={() => undefined}><ThinkingTrace text={"packages/dashboard/app/App.tsx"} format="plain" /></FileBrowserProvider>);
    expect(screen.getByRole("button", { name: "packages/dashboard/app/App.tsx" })).toBeInTheDocument();
  });

  /*
   * FNXC:ThinkingTrace 2026-08-23-13:54:
   * FN-177 has no JavaScript breakpoint branch in ThinkingTrace, so this CSS assertion covers its responsive path. TaskChatTab separately exercises its matchMedia-controlled disclosure on desktop and mobile.
   */
  it("keeps the single defensive empty-state style and responsive summary rule", () => {
    const css = loadComponentCss("ThinkingTrace.css");
    expect(css).toContain(".thinking-trace-section-empty");
    expect(css).not.toContain(["thinking", "trace", "empty", "message"].join("-"));
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain(".thinking-trace-section-summary");
  });
});
