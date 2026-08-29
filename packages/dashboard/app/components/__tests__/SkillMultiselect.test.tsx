import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const { fetchDiscoveredSkills } = vi.hoisted(() => ({ fetchDiscoveredSkills: vi.fn() }));
vi.mock("../../api", () => ({ fetchDiscoveredSkills }));
import { SkillMultiselect } from "../SkillMultiselect";

const skills = [
  { id: "skill-1", name: "Skill One", relativePath: "skills/one/SKILL.md", enabled: true },
  { id: "skill-2", name: "Skill Two", relativePath: "skills/two/SKILL.md", enabled: false },
  { id: "skill-3", name: "Skill Three", relativePath: "skills/three/SKILL.md", enabled: true },
] as any[];

describe("SkillMultiselect", () => {
  beforeEach(() => fetchDiscoveredSkills.mockReset());

  it("renders loading then empty state", async () => {
    let resolveSkills!: (value: any[]) => void;
    fetchDiscoveredSkills.mockReturnValue(new Promise((resolve) => { resolveSkills = resolve; }));
    render(<SkillMultiselect value={[]} onChange={vi.fn()} id="skills" />);
    expect(screen.getByTestId("skills-loading")).toBeInTheDocument();
    resolveSkills([]);
    expect(await screen.findByTestId("skills-empty")).toHaveTextContent("No skills discovered");
  });

  it("selects three visible checkbox rows without a dropdown", async () => {
    fetchDiscoveredSkills.mockResolvedValue(skills);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SkillMultiselect value={[]} onChange={onChange} id="skills" />);
    await screen.findByTestId("skill-option-skill-1");
    await user.click(screen.getByTestId("skill-option-skill-1").querySelector("input")!);
    await user.click(screen.getByTestId("skill-option-skill-2").querySelector("input")!);
    await user.click(screen.getByTestId("skill-option-skill-3").querySelector("input")!);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(screen.getAllByText("Auto-available").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Disabled").length).toBeGreaterThan(0);
  });

  it("filters with retained focus and supports unknown chips", async () => {
    fetchDiscoveredSkills.mockResolvedValue(skills);
    const user = userEvent.setup();
    render(<SkillMultiselect value={["missing", "missing"]} onChange={vi.fn()} id="skills" />);
    const filter = await screen.findByTestId("skill-filter");
    await user.type(filter, "Three");
    expect(filter).toHaveFocus();
    expect(filter).toHaveValue("Three");
    expect(screen.getByTestId("skill-option-skill-3")).toBeInTheDocument();
    expect(screen.queryByTestId("skill-option-skill-1")).toBeNull();
    expect(screen.getByTestId("skill-chip-missing")).toHaveTextContent("Not discovered");
  });

  it("renders error retry, no matches, and disabled populated controls", async () => {
    fetchDiscoveredSkills.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(skills);
    const user = userEvent.setup();
    render(<SkillMultiselect value={["skill-1"]} onChange={vi.fn()} id="skills" disabled />);
    expect(await screen.findByTestId("skills-error")).toBeInTheDocument();
    expect(screen.getByTestId("skill-chip-skill-1")).toHaveTextContent("Checking availability");
    expect(screen.getByTestId("skill-chip-skill-1")).not.toHaveTextContent("Not discovered");
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
    // A separate enabled render proves retry and no-match states without hiding controls.
    const { unmount } = render(<SkillMultiselect value={[]} onChange={vi.fn()} id="enabled" />);
    await user.click(await screen.findAllByRole("button", { name: "Retry" }).then((items) => items[1]!));
    const filter = await screen.findByTestId("skill-filter");
    await user.type(filter, "absent");
    expect(screen.getByTestId("skills-no-matches")).toBeInTheDocument();
    unmount();
  });
});
