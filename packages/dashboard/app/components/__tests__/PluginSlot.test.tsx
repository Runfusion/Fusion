import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginSlot } from "../PluginSlot";
import type { PluginUiSlotEntry } from "../../api";
import { usePluginUiSlots } from "../../hooks/usePluginUiSlots";
import { resolvePluginSlotComponent } from "../../plugins/pluginSlotRegistry";

vi.mock("../../hooks/usePluginUiSlots");
vi.mock("../../plugins/pluginSlotRegistry", () => ({
  resolvePluginSlotComponent: vi.fn(),
}));

function createSlotEntry(slotId: string, pluginId = "test-plugin"): PluginUiSlotEntry {
  return {
    pluginId,
    slot: {
      slotId,
      label: `Test slot ${slotId}`,
      componentPath: `./components/${slotId}.js`,
    },
  };
}

describe("PluginSlot", () => {
  beforeEach(() => {
    vi.mocked(usePluginUiSlots).mockReset();
    vi.mocked(resolvePluginSlotComponent).mockReset();
  });

  it("renders resolved slot content", () => {
    const entry = createSlotEntry("settings-provider-card", "plugin-a");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entry],
      getSlotsForId: vi.fn(() => [entry]),
      loading: false,
      error: null,
    });
    vi.mocked(resolvePluginSlotComponent).mockReturnValue(({ entry: slotEntry }) => (
      <div data-testid={`resolved-${slotEntry.pluginId}`}>Resolved</div>
    ));

    render(<PluginSlot slotId="settings-provider-card" />);

    expect(screen.getByTestId("resolved-plugin-a")).toBeInTheDocument();
  });

  it("filters by pluginIds", () => {
    const entryA = createSlotEntry("task-detail-tab", "plugin-a");
    const entryB = createSlotEntry("task-detail-tab", "plugin-b");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entryA, entryB],
      getSlotsForId: vi.fn(() => [entryA, entryB]),
      loading: false,
      error: null,
    });
    vi.mocked(resolvePluginSlotComponent).mockReturnValue(({ entry: slotEntry }) => (
      <div data-testid={`resolved-${slotEntry.pluginId}`} />
    ));

    render(<PluginSlot slotId="task-detail-tab" pluginIds={["plugin-b"]} />);

    expect(screen.queryByTestId("resolved-plugin-a")).not.toBeInTheDocument();
    expect(screen.getByTestId("resolved-plugin-b")).toBeInTheDocument();
  });

  it("shows explicit missing-component shell when unresolved", () => {
    const entry = createSlotEntry("task-detail-tab", "plugin-a");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entry],
      getSlotsForId: vi.fn(() => [entry]),
      loading: false,
      error: null,
    });
    vi.mocked(resolvePluginSlotComponent).mockReturnValue(null);

    const { container } = render(<PluginSlot slotId="task-detail-tab" />);

    const shell = container.querySelector("[data-plugin-slot-state='missing-component']");
    expect(shell).not.toBeNull();
    expect(shell?.textContent).toContain("Plugin component unavailable");
  });

  it("hides unresolved entries when placeholders disabled", () => {
    const entry = createSlotEntry("task-detail-tab", "plugin-a");
    vi.mocked(usePluginUiSlots).mockReturnValue({
      slots: [entry],
      getSlotsForId: vi.fn(() => [entry]),
      loading: false,
      error: null,
    });
    vi.mocked(resolvePluginSlotComponent).mockReturnValue(null);

    const { container } = render(<PluginSlot slotId="task-detail-tab" renderPlaceholder={false} />);

    expect(container.firstChild).toBeNull();
  });
});
