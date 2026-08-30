import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Settings } from "@fusion/core";
import { GlobalGeneralSection } from "../GlobalGeneralSection";
import type { SettingsFormState } from "../context";
import { SETTINGS_SEARCH_ENTRIES } from "../../search/entries";
import { readAppFile } from "../../../../test/cssFixture";

const RETIRED_KEY = "autoReloadOnVersionChange";

function renderSection(formOverrides: Partial<Settings> = {}) {
  let form = { ...formOverrides } as SettingsFormState;
  const setForm = vi.fn((updater: SettingsFormState | ((previous: SettingsFormState) => SettingsFormState)) => {
    form = typeof updater === "function" ? updater(form) : updater;
  });

  render(<GlobalGeneralSection form={form} setForm={setForm} />);
}

describe("GlobalGeneralSection auto-reload removal", () => {
  it("renders no auto-reload control", () => {
    renderSection();

    expect(document.getElementById(RETIRED_KEY)).toBeNull();
    expect(screen.queryByLabelText(/auto-reload/i)).toBeNull();
  });

  it("does not expose the retired control through settings search", () => {
    expect(SETTINGS_SEARCH_ENTRIES.some((entry) => entry.key === RETIRED_KEY)).toBe(false);
  });

  it("removes the retired Basic-mode CSS selector", () => {
    expect(readAppFile("components/SettingsModal.css")).not.toContain(`#${RETIRED_KEY}`);
  });

  it("does not mention the retired key in direct non-test section sources", () => {
    const sectionsDir = join(__dirname, "..");
    // Do not recurse: __tests__ contains this assertion's required needle.
    const sourceFiles = readdirSync(sectionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name));

    for (const sourceFile of sourceFiles) {
      expect(readFileSync(join(sectionsDir, sourceFile.name), "utf8")).not.toContain(RETIRED_KEY);
    }
  });
});
