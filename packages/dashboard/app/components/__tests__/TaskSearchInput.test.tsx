import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "@fusion/core";
import { TaskSearchInput } from "../TaskSearchInput";

type SearchableTask = Pick<Task, "id" | "title">;

const tasks: SearchableTask[] = [
  { id: "FN-331", title: "Remove branch filters" },
  { id: "ERR-331", title: "Repair matching task" },
  { id: "FN-332", title: "Different number" },
];

function ControlledSearch({ source = tasks, onChange }: { source?: SearchableTask[]; onChange?: (value: string) => void }) {
  const [query, setQuery] = useState("");
  return (
    <TaskSearchInput
      query={query}
      tasks={source}
      onSearchChange={(value) => {
        setQuery(value);
        onChange?.(value);
      }}
    />
  );
}

describe("TaskSearchInput", () => {
  it("proposes matching numeric ID segments across prefixes with titles", () => {
    render(<ControlledSearch />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "331" } });

    expect(screen.getByRole("option", { name: "FN-331: Remove branch filters" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ERR-331: Repair matching task" })).toBeInTheDocument();
    expect(screen.queryByText("FN-332")).toBeNull();
  });

  it("matches ID suffixes and titles with literal punctuation case-insensitively", () => {
    render(<ControlledSearch source={[
      { id: "FN-352", title: "Dans la barre de recherche" },
      { id: "FN-901", title: "retire de fichier txt" },
      { id: "FN-902", title: "Add the bonjour.txt file" },
    ]} />);
    const input = screen.getByRole("combobox");

    fireEvent.change(input, { target: { value: "52" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "FN-352: Dans la barre de recherche" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: ".TXT" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "FN-902: Add the bonjour.txt file" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "FN-901: retire de fichier txt" })).toBeNull();
  });

  it("matches prefixed IDs case-insensitively", () => {
    render(<ControlledSearch />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "err-3" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText("ERR-331")).toBeInTheDocument();
  });

  it("ranks exact, prefix, internal ID, then title-only matches", () => {
    render(<ControlledSearch source={[
      { id: "TITLE-1", title: "Mentions fn-331" },
      { id: "PRE-FN-331-SUFFIX", title: "Internal" },
      { id: "FN-3310", title: "Longer" },
      { id: "FN-331", title: "Exact" },
    ]} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "fn-331" } });
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "FN-331Exact",
      "FN-3310Longer",
      "PRE-FN-331-SUFFIXInternal",
      "TITLE-1Mentions fn-331",
    ]);
  });

  it.each([
    { name: "undefined", source: undefined },
    { name: "empty", source: [] },
  ])("hides suggestions for a $name task source", ({ source }) => {
    render(<TaskSearchInput query="331" tasks={source} onSearchChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it.each(["", "   "])("hides suggestions for blank query %j", (query) => {
    render(<TaskSearchInput query={query} tasks={tasks} onSearchChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("does not leave listbox ARIA behind when no task matches", () => {
    render(<TaskSearchInput query="missing" tasks={tasks} onSearchChange={vi.fn()} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-controls");
    expect(input).not.toHaveAttribute("aria-activedescendant");
  });

  it("deduplicates IDs case-insensitively and limits results to eight", () => {
    const source = [
      { id: "FN-10", title: "First" },
      { id: "fn-10", title: "Duplicate" },
      ...Array.from({ length: 7 }, (_, index) => ({ id: `FN-1${index + 1}`, title: `Task ${index}` })),
      { id: "FN-18", title: "Ninth unique task" },
    ];
    render(<TaskSearchInput query="1" tasks={source} onSearchChange={vi.fn()} />);
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getAllByText(/FN-10/i)).toHaveLength(1);
  });

  it("navigates with arrows and selects the active suggestion once with Enter", () => {
    const onSearchChange = vi.fn();
    render(<TaskSearchInput query="331" tasks={tasks} onSearchChange={onSearchChange} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const active = screen.getAllByRole("option")[0];
    expect(active).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearchChange).toHaveBeenCalledTimes(1);
    expect(onSearchChange).toHaveBeenCalledWith(active.textContent?.startsWith("ERR") ? "ERR-331" : "FN-331");
  });

  it("wraps ArrowUp to the last suggestion", () => {
    render(<TaskSearchInput query="331" tasks={tasks} onSearchChange={vi.fn()} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option").at(-1)).toHaveAttribute("aria-selected", "true");
  });

  it("routes a navigation selection without rewriting the filter query", () => {
    const onSearchChange = vi.fn();
    const onSelectTask = vi.fn();
    render(<TaskSearchInput query="331" tasks={tasks} onSearchChange={onSearchChange} onSelectTask={onSelectTask} />);
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "FN-331: Remove branch filters" }));
    expect(onSelectTask).toHaveBeenCalledWith(tasks[0]);
    expect(onSearchChange).not.toHaveBeenCalled();
  });

  it("selects a suggestion by mouse interaction", () => {
    const onSearchChange = vi.fn();
    render(<TaskSearchInput query="331" tasks={tasks} onSearchChange={onSearchChange} />);
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.mouseDown(screen.getByRole("option", { name: "FN-331: Remove branch filters" }));
    fireEvent.click(screen.getByRole("option", { name: "FN-331: Remove branch filters" }));
    expect(onSearchChange).toHaveBeenCalledOnce();
    expect(onSearchChange).toHaveBeenCalledWith("FN-331");
  });

  it("selects a suggestion by touch interaction", () => {
    const onSearchChange = vi.fn();
    render(<TaskSearchInput query="331" tasks={tasks} onSearchChange={onSearchChange} />);
    fireEvent.focus(screen.getByRole("combobox"));
    const option = screen.getByRole("option", { name: "ERR-331: Repair matching task" });
    fireEvent.touchStart(option);
    fireEvent.touchEnd(option);
    fireEvent.click(option);
    expect(onSearchChange).toHaveBeenCalledOnce();
    expect(onSearchChange).toHaveBeenCalledWith("ERR-331");
  });

  it("closes on Escape without clearing the query or bubbling to a parent", () => {
    const onSearchChange = vi.fn();
    const parentKeyDown = vi.fn();
    render(<div onKeyDown={parentKeyDown}><TaskSearchInput query="331" tasks={tasks} onSearchChange={onSearchChange} /></div>);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onSearchChange).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it("closes on an outside press and reopens on focus", () => {
    render(<><TaskSearchInput query="331" tasks={tasks} onSearchChange={vi.fn()} /><button>Outside</button></>);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.focus(input);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("clears keyboard activation when the result set changes", () => {
    const onSearchChange = vi.fn();
    const { rerender } = render(<TaskSearchInput query="331" tasks={tasks} onSearchChange={onSearchChange} />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    rerender(<TaskSearchInput query="331" tasks={[{ id: "NEW-331", title: "New result" }]} onSearchChange={onSearchChange} />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearchChange).not.toHaveBeenCalled();
  });
});
