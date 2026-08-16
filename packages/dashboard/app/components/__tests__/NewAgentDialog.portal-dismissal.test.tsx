// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NewAgentDialog } from "../NewAgentDialog";
import * as api from "../../api";

vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  fetchModels: vi.fn().mockResolvedValue({ models: [
    { id: "gpt-4o", provider: "openai", name: "GPT-4o" },
    { id: "claude-sonnet", provider: "anthropic", name: "Claude Sonnet" },
  ] }),
  fetchAgents: vi.fn().mockResolvedValue([]),
  fetchPluginRuntimes: vi.fn().mockResolvedValue({ runtimes: [] }),
}));
vi.mock("../SkillMultiselect", () => ({ SkillMultiselect: () => <div /> }));
vi.mock("../AgentGenerationModal", () => ({ AgentGenerationModal: () => null }));
vi.mock("../ExperimentalAgentOnboardingModal", () => ({ ExperimentalAgentOnboardingModal: () => null }));

function setViewport(mobile: boolean) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: mobile ? 375 : 1280 });
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({ matches: mobile && query.includes("max-width: 768px"), media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })) });
}

/**
 * FNXC:ModelDropdown 2026-08-15-13:11:
 * New Agent owns a real model picker, so its overlay must survive a filter gesture whose mobile
 * keyboard re-anchor sends the release or synthesized click to the backdrop.
 */
describe("NewAgentDialog portaled model menu", () => {
  beforeEach(() => { vi.clearAllMocks(); document.body.innerHTML = ""; });

  it.each([{ mobile: false }, { mobile: true }])("does not close after a $mobile filter-origin gesture ends on the overlay", async ({ mobile }) => {
    setViewport(mobile);
    const onClose = vi.fn();
    render(<NewAgentDialog isOpen onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-dialog-tab-custom"));
    fireEvent.click(await screen.findByLabelText("Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    const overlay = document.querySelector(".agent-dialog-overlay") as HTMLElement;

    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter); fireEvent.mouseDown(filter);
    fireEvent.change(filter, { target: { value: "no-match" } });
    if (mobile) fireEvent.touchEnd(overlay);
    fireEvent.mouseUp(overlay); fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Create new agent" })).toBeInTheDocument();
    expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument();
    expect(filter).toHaveValue("no-match");
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each([{ mobile: false }, { mobile: true }])("keeps the empty $mobile model menu attached to New Agent after a portal-origin gesture", async ({ mobile }) => {
    setViewport(mobile);
    vi.mocked(api.fetchModels).mockResolvedValueOnce({ models: [] } as Awaited<ReturnType<typeof api.fetchModels>>);
    const onClose = vi.fn();
    render(<NewAgentDialog isOpen onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-dialog-tab-custom"));
    fireEvent.click(await screen.findByLabelText("Model"));
    const filter = await screen.findByPlaceholderText("Filter models…");
    const overlay = document.querySelector(".agent-dialog-overlay") as HTMLElement;

    if (mobile) fireEvent.touchStart(filter);
    fireEvent.pointerDown(filter); fireEvent.mouseDown(filter);
    fireEvent.change(filter, { target: { value: "no-match" } });
    if (mobile) fireEvent.touchEnd(overlay);
    fireEvent.mouseUp(overlay); fireEvent.click(overlay);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId("model-combobox-portal")).toBeInTheDocument();
    expect(screen.getByText(/No models match/)).toBeInTheDocument();
  });
});
