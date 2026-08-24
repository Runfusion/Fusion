import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ThinkingTrace, parseThinkingSections } from "../ThinkingTrace";
import { FileBrowserProvider } from "../../context/FileBrowserContext";

const trace = [
  "Preamble before the first title.",
  "",
  "**Ensuring Docker build includes dev dependencies for tests**",
  "",
  "The Docker image needs development dependencies for test execution.",
  "A second paragraph remains with this title.",
  "",
  "**Planning deployment commit structure**",
  "",
  "Deployment commits should be split by independently reviewable behavior.",
  "A second deployment paragraph remains visible.",
  "",
  "**Editing README content**",
  "",
  "The README change belongs in its own reviewed update.",
  "A second README paragraph remains visible.",
].join("\n");

function sections() {
  return screen.getAllByTestId("thinking-trace-section");
}

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

  it("recognizes ATX headings and titles without bodies", () => {
    expect(parseThinkingSections("# One\n\n## Two").map(({ title, body }) => ({ title, body }))).toEqual([
      { title: "One", body: "" },
      { title: "Two", body: "" },
    ]);
  });
});

describe("ThinkingTrace", () => {
  it("renders no shell for empty reasoning and leaves untitled text unsectioned", () => {
    const { container, unmount } = render(<ThinkingTrace text={" \n\t"} />);
    expect(container).toBeEmptyDOMElement();

    unmount();
    render(<ThinkingTrace text={"Untitled reasoning\n\nkeeps its source layout."} />);
    expect(screen.getByText(/Untitled reasoning/)).toBeInTheDocument();
    expect(screen.queryByTestId("thinking-trace-section")).toBeNull();
    expect(screen.queryByRole("button", { name: /collapse all|expand all/i })).toBeNull();
  });

  it("keeps every populated title expanded and isolated until its own section is collapsed", () => {
    render(<ThinkingTrace text={trace} />);
    expect(sections()).toHaveLength(4);
    const deployment = sections().find((section) => section.textContent?.includes("Planning deployment commit structure"))!;
    expect(deployment.textContent).toContain("Deployment commits should be split by independently reviewable behavior.");
    expect(sections().filter((section) => section !== deployment).some((section) => section.textContent?.includes("Deployment commits should be split by independently reviewable behavior."))).toBe(false);

    fireEvent.click(within(deployment).getByText("Planning deployment commit structure"));
    expect(deployment).not.toHaveAttribute("open");
    expect(deployment).not.toHaveAttribute("open");
    const readme = sections().find((section) => section.textContent?.includes("Editing README content"))!;
    expect(readme).toHaveAttribute("open");
    expect(readme.textContent).toContain("The README change belongs in its own reviewed update.");
  });

  it("labels every titles-only section and toggles all sections", () => {
    render(<ThinkingTrace text={"**One**\n\n**Two**\n\n**Three**"} />);
    expect(sections()).toHaveLength(3);
    expect(screen.getAllByText("No reasoning captured for this step")).toHaveLength(6);

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
    expect(initialSections[0]).not.toHaveAttribute("open");
    expect(initialSections[1]).toHaveAttribute("open");

    rerender(<ThinkingTrace text={`${initial}\n\n**New**\n\nNew body`} />);
    const updatedSections = sections();
    expect(updatedSections[0]).toBe(initialSections[0]);
    expect(updatedSections[0]).not.toHaveAttribute("open");
    expect(updatedSections[1]).toBe(initialSections[1]);
    expect(updatedSections[1]).toHaveAttribute("open");
    expect(updatedSections[2]).toHaveAttribute("open");
  });

  it("uses markdown rendering and linkifies plain file paths", () => {
    const { rerender } = render(<ThinkingTrace text={"**Title**\n\nBody is **bold**."} format="markdown" />);
    expect(screen.getByText("bold").tagName).toBe("STRONG");

    rerender(<FileBrowserProvider openFile={() => undefined}><ThinkingTrace text={"packages/dashboard/app/App.tsx"} format="plain" /></FileBrowserProvider>);
    expect(screen.getByRole("button", { name: "packages/dashboard/app/App.tsx" })).toBeInTheDocument();
  });
});
