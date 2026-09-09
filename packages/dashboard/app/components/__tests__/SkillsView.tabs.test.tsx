import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { CatalogEntry, DiscoveredSkill } from "@fusion/dashboard";
import type { ChatSnippet, GlobalSettings, Settings } from "@fusion/core";
import * as apiModule from "../../api";
import { __test_resetChatSnippetsCache } from "../../hooks/useChatSnippetsCache";
import { SkillsView } from "../SkillsView";

vi.mock("../../api", () => ({
  fetchDiscoveredSkills: vi.fn(),
  toggleExecutionSkill: vi.fn(),
  installSkill: vi.fn(),
  fetchSkillsCatalog: vi.fn(),
  fetchSkillContent: vi.fn(),
  fetchSkillFileContent: vi.fn(),
  fetchGlobalSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
}));

const mockFetchDiscoveredSkills = vi.mocked(apiModule.fetchDiscoveredSkills);
const mockFetchSkillsCatalog = vi.mocked(apiModule.fetchSkillsCatalog);
const mockFetchSkillContent = vi.mocked(apiModule.fetchSkillContent);
const mockFetchSkillFileContent = vi.mocked(apiModule.fetchSkillFileContent);
const mockFetchGlobalSettings = vi.mocked(apiModule.fetchGlobalSettings);
const mockUpdateGlobalSettings = vi.mocked(apiModule.updateGlobalSettings);

const discoveredSkills: DiscoveredSkill[] = [
  {
    id: "npm::skills/test-skill",
    name: "test-skill",
    path: "/project/.fusion/skills/test-skill",
    relativePath: "skills/test-skill",
    enabled: true,
    metadata: { source: "npm", scope: "project", origin: "top-level" },
  },
  {
    id: "github::skills/second-skill",
    name: "second-skill",
    path: "/project/.fusion/skills/second-skill",
    relativePath: "skills/second-skill",
    enabled: false,
    metadata: { source: "github", scope: "project", origin: "package" },
  },
];

const catalogEntries: CatalogEntry[] = [
  {
    id: "catalog-test-skill",
    slug: "test-skill",
    name: "Test Skill",
    repo: "owner/test-skill",
    installation: { installed: false, matchingSkillIds: [], matchingPaths: [] },
  },
];

function assertAriaRelationships(): void {
  const tabs = screen.getAllByRole("tab");
  const panels = screen.getAllByRole("tabpanel", { hidden: true });

  for (const tab of tabs) {
    const controlledId = tab.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId!)).not.toBeNull();
  }
  for (const panel of panels) {
    const labelledById = panel.getAttribute("aria-labelledby");
    expect(labelledById).toBeTruthy();
    expect(document.getElementById(labelledById!)).not.toBeNull();
  }
}

async function renderView(snippets: ChatSnippet[] = []): Promise<void> {
  mockFetchGlobalSettings.mockResolvedValue({ chatSnippets: snippets });
  render(<SkillsView addToast={vi.fn()} onClose={vi.fn()} />);
  await screen.findByRole("button", { name: "View details for test-skill" });
  await waitFor(() => expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(1));
}

describe("SkillsView tabs", () => {
  beforeEach(() => {
    __test_resetChatSnippetsCache();
    vi.clearAllMocks();
    mockFetchDiscoveredSkills.mockResolvedValue(discoveredSkills);
    mockFetchSkillsCatalog.mockResolvedValue({
      entries: catalogEntries,
      auth: { mode: "unauthenticated", tokenPresent: false, fallbackUsed: false },
    });
    mockFetchSkillContent.mockResolvedValue({
      name: "test-skill",
      skillMd: "# Test skill",
      files: [],
    });
    mockFetchSkillFileContent.mockResolvedValue({
      name: "notes.md",
      relativePath: "notes.md",
      content: "notes",
      isText: true,
    });
    mockUpdateGlobalSettings.mockImplementation(async (patch: Partial<GlobalSettings>) => ({
      chatSnippets: patch.chatSnippets ?? [],
    }) as Settings);
  });

  it("moves snippet management outside the narrow skills subtree and keeps it reachable after selection", async () => {
    await renderView();

    const root = screen.getByTestId("skills-view");
    const snippetsPanel = screen.getByTestId("skills-panel-snippets");
    const snippetsSection = snippetsPanel.querySelector(".skills-view-snippets");
    expect(document.querySelector(".skills-view-content .skills-view-snippets")).toBeNull();
    expect(document.querySelectorAll(".skills-view-content .skills-view-section")).toHaveLength(2);
    expect(snippetsSection).not.toBeNull();
    expect(document.querySelector(".skills-view__list .skills-view-snippets")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View details for test-skill" }));
    expect(root).toHaveAttribute("data-selected", "true");
    expect(document.querySelector(".skills-view__list .skills-view-snippets")).toBeNull();

    fireEvent.click(screen.getByTestId("skills-tab-snippets"));
    const nameInput = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(nameInput, { target: { value: "reachable" } });
    expect(nameInput).toHaveValue("reachable");
  });

  it("keeps both panels mounted while exposing exactly one and retaining every ARIA relationship", async () => {
    await renderView();

    const skillsTab = screen.getByTestId("skills-tab-skills");
    const snippetsTab = screen.getByTestId("skills-tab-snippets");
    const skillsPanel = screen.getByTestId("skills-panel-skills");
    const snippetsPanel = screen.getByTestId("skills-panel-snippets");

    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(2);
    expect(skillsPanel).not.toHaveAttribute("hidden");
    expect(snippetsPanel).toHaveAttribute("hidden");
    expect(skillsTab).toHaveAttribute("aria-selected", "true");
    expect(snippetsTab).toHaveAttribute("aria-selected", "false");
    assertAriaRelationships();

    fireEvent.click(snippetsTab);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getAllByRole("tabpanel", { hidden: true })).toHaveLength(2);
    expect(skillsPanel).toHaveAttribute("hidden");
    expect(snippetsPanel).not.toHaveAttribute("hidden");
    expect(skillsTab).toHaveAttribute("aria-selected", "false");
    expect(snippetsTab).toHaveAttribute("aria-selected", "true");
    assertAriaRelationships();
  });

  it("preserves a snippet draft and selected skill across round trips", async () => {
    await renderView();

    const skill = screen.getByRole("button", { name: "View details for test-skill" });
    fireEvent.click(skill);
    expect(skill).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(mockFetchSkillContent).toHaveBeenCalledWith("npm::skills/test-skill", undefined));

    fireEvent.click(screen.getByTestId("skills-tab-snippets"));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), { target: { value: "Keep this prompt" } });
    fireEvent.click(screen.getByTestId("skills-tab-skills"));
    const retainedSelection = document.querySelector('.skills-view-item[aria-expanded="true"]');
    expect(retainedSelection).not.toBeNull();
    expect(retainedSelection).toHaveTextContent("test-skill");

    fireEvent.click(screen.getByTestId("skills-tab-snippets"));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("draft");
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue("Keep this prompt");
  });

  it("loads the inactive snippet count and routes header refresh to the active domain", async () => {
    await renderView([
      { name: "review", prompt: "Review the change" },
      { name: "verify", prompt: "Run focused verification" },
    ]);

    const snippetsTab = screen.getByTestId("skills-tab-snippets");
    expect(snippetsTab).toHaveTextContent("Snippets2");
    expect(screen.getByTestId("skills-panel-snippets")).toHaveAttribute("hidden");

    expect(mockFetchDiscoveredSkills).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
    await waitFor(() => expect(mockFetchDiscoveredSkills).toHaveBeenCalledTimes(2));

    fireEvent.click(snippetsTab);
    expect(screen.getByText("2 saved", { selector: ".skills-view-count" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh snippets" }));
    await waitFor(() => expect(mockFetchGlobalSettings).toHaveBeenCalledTimes(2));
  });

  it("supports arrow, Home, and End navigation with a roving tab stop", async () => {
    await renderView();

    const skillsTab = screen.getByTestId("skills-tab-skills");
    const snippetsTab = screen.getByTestId("skills-tab-snippets");
    skillsTab.focus();
    expect(skillsTab).toHaveAttribute("tabindex", "0");
    expect(snippetsTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(skillsTab, { key: "ArrowRight" });
    expect(snippetsTab).toHaveFocus();
    expect(snippetsTab).toHaveAttribute("aria-selected", "true");
    expect(snippetsTab).toHaveAttribute("tabindex", "0");
    expect(skillsTab).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(snippetsTab, { key: "ArrowLeft" });
    expect(skillsTab).toHaveFocus();
    fireEvent.keyDown(skillsTab, { key: "End" });
    expect(snippetsTab).toHaveFocus();
    fireEvent.keyDown(snippetsTab, { key: "Home" });
    expect(skillsTab).toHaveFocus();
    fireEvent.keyDown(skillsTab, { key: "ArrowLeft" });
    expect(snippetsTab).toHaveFocus();
    fireEvent.keyDown(snippetsTab, { key: "ArrowRight" });
    expect(skillsTab).toHaveFocus();
  });

  it("leaves no empty shells, duplicate landmark ids, or unnamed controls", async () => {
    await renderView();

    const ids = [
      "skills-tab-skills",
      "skills-tab-snippets",
      "skills-panel-skills",
      "skills-panel-snippets",
      "chat-snippets-title",
    ];
    for (const id of ids) {
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
    }

    const content = document.querySelector(".skills-view-content");
    expect(content?.firstElementChild).toHaveClass("skills-view-section-description");
    for (const section of document.querySelectorAll(".skills-view-section")) {
      expect(section.textContent?.trim()).not.toBe("");
    }

    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveAccessibleName();
      expect(within(tab).getByText(/\d+/).textContent).not.toBe("");
    }
    expect(screen.getByRole("button", { name: "Refresh skills" })).toHaveTextContent("Refresh");
    expect(document.querySelectorAll("#chat-snippets-title")).toHaveLength(1);
  });
});
