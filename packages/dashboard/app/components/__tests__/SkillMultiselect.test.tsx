import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const { fetchDiscoveredSkills } = vi.hoisted(() => ({ fetchDiscoveredSkills: vi.fn() }));
vi.mock("../../api", () => ({ fetchDiscoveredSkills }));

import { SkillMultiselect } from "../SkillMultiselect";

/*
FNXC:AgentSettingsTheming 2026-07-23-13:01:
The Settings theme contract covers real skill control states, not only CSS text. Keep loading, empty, populated, removal, duplicate prevention, and disabled controls rendered so their stable classes and accessibility semantics cannot regress while themes evolve.
*/
describe("SkillMultiselect", () => {
  const skills = [
    { id: "skill-1", name: "Skill One" },
    { id: "skill-2", name: "Skill Two" },
  ];

  beforeEach(() => {
    fetchDiscoveredSkills.mockReset();
  });

  it("renders loading then empty state", async () => {
    let resolveSkills!: (value: typeof skills) => void;
    fetchDiscoveredSkills.mockReturnValue(new Promise((resolve) => { resolveSkills = resolve; }));
    render(<SkillMultiselect value={[]} onChange={vi.fn()} id="skills" />);

    expect(screen.getByTestId("skills-loading")).toHaveClass("skill-multiselect-loading");
    resolveSkills([]);
    expect(await screen.findByTestId("skills-empty")).toHaveTextContent("No skills discovered");
  });

  it("adds available skills once and renders removable populated chips", async () => {
    fetchDiscoveredSkills.mockResolvedValue(skills);
    const onChange = vi.fn();
    render(<SkillMultiselect value={["skill-1"]} onChange={onChange} id="skills" />);

    expect(await screen.findByTestId("skill-chip-skill-1")).toHaveTextContent("Skill One");
    const dropdown = screen.getByTestId("skill-dropdown") as HTMLSelectElement;
    expect(Array.from(dropdown.options).map((option) => option.value)).not.toContain("skill-1");
    fireEvent.change(dropdown, { target: { value: "skill-2" } });
    expect(onChange).toHaveBeenCalledWith(["skill-1", "skill-2"]);

    fireEvent.click(screen.getByTestId("remove-skill-skill-1"));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("disables dropdown and removal controls without hiding populated state", async () => {
    fetchDiscoveredSkills.mockResolvedValue(skills);
    render(<SkillMultiselect value={["skill-1"]} onChange={vi.fn()} id="skills" disabled />);

    await waitFor(() => expect(screen.getByTestId("skill-dropdown")).toBeDisabled());
    expect(screen.getByTestId("remove-skill-skill-1")).toBeDisabled();
    expect(screen.getByTestId("skill-chip-skill-1")).toBeInTheDocument();
  });
});
