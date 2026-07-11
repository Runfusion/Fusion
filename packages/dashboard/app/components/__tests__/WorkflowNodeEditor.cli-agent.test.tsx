import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import type { WorkflowDefinition } from "@fusion/core";

vi.mock("../../api", () => ({
  fetchWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  compileWorkflow: vi.fn(),
  fetchTraits: vi.fn(),
  fetchStepParsers: vi.fn(),
  fetchModels: vi.fn(),
  fetchAgents: vi.fn(),
  fetchDiscoveredSkills: vi.fn(),
  fetchWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchPluginWorkflowStepTemplates: vi.fn().mockResolvedValue({ templates: [] }),
  fetchConfig: vi.fn(),
  fetchSettings: vi.fn(),
  updateSettings: vi.fn(),
  updateGlobalSettings: vi.fn(),
  fetchWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
  updateWorkflowSettingValues: vi.fn().mockResolvedValue({ stored: {}, effective: {}, orphaned: [] }),
}));

import {
  fetchWorkflows,
  fetchTraits,
  fetchStepParsers,
  updateWorkflow,
  fetchModels,
  fetchConfig,
  fetchSettings,
} from "../../api";
import type { TraitCatalogEntry } from "../../api";
import { WorkflowNodeEditor } from "../WorkflowNodeEditor";

const TRAIT_CATALOG: TraitCatalogEntry[] = [
  { id: "intake", name: "Intake", builtin: true, flags: { intake: true } },
  { id: "complete", name: "Complete", builtin: true, flags: { complete: true } },
];

function promptDef(): WorkflowDefinition {
  return {
    id: "WF-CLI",
    name: "CLI",
    description: "",
    ir: {
      version: "v2",
      name: "CLI",
      columns: [
        { id: "triage", name: "Triage", traits: [{ trait: "intake" }] },
        { id: "done", name: "Done", traits: [{ trait: "complete" }] },
      ],
      nodes: [
        { id: "start", kind: "start", column: "triage" },
        { id: "step", kind: "prompt", column: "triage", config: { prompt: "do" } },
        { id: "end", kind: "end", column: "done" },
      ],
      edges: [
        { from: "start", to: "step", condition: "success" },
        { from: "step", to: "end", condition: "success" },
      ],
    },
    layout: {
      start: { x: 0, y: 20 },
      step: { x: 120, y: 60 },
      end: { x: 360, y: 240 },
    },
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

describe("WorkflowNodeEditor — cli-agent executor (U15)", () => {
  beforeEach(() => {
    // FNXC:WorkflowSimpleView 2026-07-10-12:00: this suite drives the advanced
    // canvas (wf-node-prompt cards); pin the persisted view mode since the
    // editor now defaults to the simplified view.
    localStorage.setItem("fusion:wf-editor-view-mode", "advanced");
    vi.mocked(fetchWorkflows).mockResolvedValue([promptDef()]);
    vi.mocked(fetchTraits).mockResolvedValue(TRAIT_CATALOG);
    vi.mocked(fetchStepParsers).mockResolvedValue([]);
    vi.mocked(fetchModels).mockResolvedValue({ models: [] });
    vi.mocked(fetchConfig).mockResolvedValue({ maxConcurrent: 2, rootDir: "/tmp/project" });
    vi.mocked(fetchSettings).mockResolvedValue({ autoMerge: true });
    vi.mocked(updateWorkflow).mockResolvedValue(promptDef());
    // Stub the adapter-catalog fetch.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.startsWith("/api/cli-agents")) {
          return {
            ok: true,
            json: async () => ({
              adapters: [
                { id: "claude-code", name: "Claude Code", tier: "native" },
                { id: "generic", name: "Generic CLI", tier: "generic" },
              ],
            }),
          } as Response;
        }
        return { ok: false, json: async () => ({}) } as Response;
      }),
    );
  });

  afterEach(() => {
    localStorage.removeItem("fusion:wf-editor-view-mode");
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  async function selectCliAgent() {
    render(<WorkflowNodeEditor isOpen onClose={() => {}} addToast={() => {}} />);
    const node = await screen.findByTestId("wf-node-prompt");
    fireEvent.click(node);
    const executorSel = (await screen.findByText("Executor")).parentElement!.querySelector(
      "select",
    )! as HTMLSelectElement;
    fireEvent.change(executorSel, { target: { value: "cli-agent" } });
    return executorSel;
  }

  it("surfaces adapter + notification fields when cli-agent is selected", async () => {
    await selectCliAgent();
    expect(await screen.findByTestId("cli-agent-config")).toBeInTheDocument();
    expect(screen.getByTestId("cli-agent-adapter")).toBeInTheDocument();
    expect(screen.getByTestId("cli-agent-notify")).toBeInTheDocument();
    expect(screen.getByTestId("cli-agent-autonomy")).toBeInTheDocument();
  });

  it("populates the adapter picker with tier labels from the API", async () => {
    await selectCliAgent();
    const adapterSel = (await screen.findByTestId("cli-agent-adapter")) as HTMLSelectElement;
    await waitFor(() => {
      expect(adapterSel.querySelectorAll("option").length).toBeGreaterThan(2);
    });
    const optionText = Array.from(adapterSel.querySelectorAll("option")).map((o) => o.textContent);
    expect(optionText.some((t) => t?.includes("Claude Code") && t.includes("native"))).toBe(true);
    expect(optionText.some((t) => t?.includes("Generic CLI") && t.includes("generic"))).toBe(true);
  });

  it("lands the selected adapter + notify config in the node config", async () => {
    await selectCliAgent();
    const adapterSel = (await screen.findByTestId("cli-agent-adapter")) as HTMLSelectElement;
    fireEvent.change(adapterSel, { target: { value: "claude-code" } });
    expect(adapterSel.value).toBe("claude-code");

    const notifySel = screen.getByTestId("cli-agent-notify") as HTMLSelectElement;
    fireEvent.change(notifySel, { target: { value: "banner+notify" } });
    expect(notifySel.value).toBe("banner+notify");

    // Save and assert the persisted IR carries the cli-agent node config.
    fireEvent.click(screen.getByText("Save").closest("button")!);
    await waitFor(() => expect(updateWorkflow).toHaveBeenCalled());
    const savedIr = vi.mocked(updateWorkflow).mock.calls.at(-1)![1] as {
      ir: { nodes: Array<{ id: string; config?: Record<string, unknown> }> };
    };
    const stepNode = savedIr.ir.nodes.find((n) => n.id === "step")!;
    expect(stepNode.config?.executor).toBe("cli-agent");
    expect(stepNode.config?.cliAdapterId).toBe("claude-code");
    expect(stepNode.config?.cliNotify).toEqual({ mode: "banner+notify" });
  });
});
