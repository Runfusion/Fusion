// @vitest-environment jsdom
import { fireEvent, cleanup, render, screen } from "@testing-library/react";
import * as jestDomMatchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemorySection } from "../MemorySection";
import type { MemorySectionMemoryProps } from "../MemorySection";
import type { SettingsFormState } from "../context";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

expect.extend(jestDomMatchers);

afterEach(() => cleanup());

beforeEach(() => {
  vi.clearAllMocks();
});

const memoryProps: MemorySectionMemoryProps = {
  memoryCapabilities: null,
  memoryBackendStatus: null,
  memoryBackendLoading: false,
  memoryBackendError: null,
  memoryFiles: [],
  selectedMemoryPath: "",
  setSelectedMemoryPath: vi.fn(),
  memoryContent: "",
  setMemoryContent: vi.fn(),
  memoryLoading: false,
  memoryDirty: false,
  setMemoryDirty: vi.fn(),
  memoryTestQuery: "",
  setMemoryTestQuery: vi.fn(),
  memoryTestLoading: false,
  memoryTestResult: null,
  qmdInstallLoading: false,
  dreamRunning: false,
  memoryCompactLoading: false,
  onInstallQmd: vi.fn(),
  onTestMemoryRetrieval: vi.fn(),
  onDreamNow: vi.fn(),
  onCompactMemory: vi.fn(),
  onSaveMemory: vi.fn(),
};

function applySetFormCalls(setForm: ReturnType<typeof vi.fn>, form: SettingsFormState): SettingsFormState {
  let current = form;
  for (const [updater] of vi.mocked(setForm).mock.calls) {
    current = (updater as (f: SettingsFormState) => SettingsFormState)(current);
  }
  return current;
}

function renderMemorySection(formOverrides: Partial<SettingsFormState> = {}) {
  const setForm = vi.fn();
  const form = {
    memoryEnabled: true,
    memoryPerTurnRecallEnabled: true,
    memoryPerTurnRecallTopK: 3,
    ...formOverrides,
  } as SettingsFormState;
  render(<MemorySection form={form} setForm={setForm} memory={memoryProps} />);
  return { form, setForm };
}

describe("MemorySection per-turn memory recall rows (RUFU-120 B.2)", () => {
  it("renders the per-turn recall toggle on by default after the memory tools toggle", () => {
    renderMemorySection();

    const memoryToolsToggle = document.getElementById("memoryEnabled") as HTMLInputElement;
    const recallToggle = document.getElementById("memoryPerTurnRecallEnabled") as HTMLInputElement;

    expect(memoryToolsToggle).toBeTruthy();
    expect(recallToggle).toBeTruthy();
    // The recall toggle sits directly below the memory-tools toggle in the section.
    expect(memoryToolsToggle.compareDocumentPosition(recallToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Schema default is ON: an unset form value renders as checked (value !== false).
    expect(recallToggle.checked).toBe(true);
  });

  it("toggling the per-turn recall row updates form state", () => {
    const { form, setForm } = renderMemorySection();

    const recallToggle = document.getElementById("memoryPerTurnRecallEnabled") as HTMLInputElement;
    fireEvent.click(recallToggle);

    expect(setForm).toHaveBeenCalledTimes(1);
    const next = applySetFormCalls(setForm, form);
    expect(next.memoryPerTurnRecallEnabled).toBe(false);
  });

  it("shows the top K row with the schema default (3) while the toggle is on", () => {
    renderMemorySection();

    const topK = document.getElementById("memoryPerTurnRecallTopK") as HTMLInputElement;
    expect(topK).toBeTruthy();
    expect(topK.type).toBe("number");
    expect(topK.value).toBe("3");
    // Unset form value still renders the schema default.
    cleanup();
    render(<MemorySection form={{ memoryEnabled: true, memoryPerTurnRecallEnabled: true } as SettingsFormState} setForm={vi.fn()} memory={memoryProps} />);
    const unsetTopK = document.getElementById("memoryPerTurnRecallTopK") as HTMLInputElement;
    expect(unsetTopK.value).toBe("3");
  });

  it("editing the top K row writes a number into form state", () => {
    const { form, setForm } = renderMemorySection();

    const topK = document.getElementById("memoryPerTurnRecallTopK") as HTMLInputElement;
    fireEvent.change(topK, { target: { value: "5" } });

    expect(setForm).toHaveBeenCalledTimes(1);
    const next = applySetFormCalls(setForm, form);
    expect(next.memoryPerTurnRecallTopK).toBe(5);
  });

  it("hides the top K row when the toggle is off", () => {
    renderMemorySection({ memoryPerTurnRecallEnabled: false });

    expect(document.getElementById("memoryPerTurnRecallTopK")).toBeNull();
  });

  it("hides the top K row after the operator turns the toggle off in the UI", () => {
    const { form, setForm } = renderMemorySection();

    const recallToggle = document.getElementById("memoryPerTurnRecallEnabled") as HTMLInputElement;
    expect(document.getElementById("memoryPerTurnRecallTopK")).not.toBeNull();

    fireEvent.click(recallToggle);
    const nextForm = applySetFormCalls(setForm, form);
    expect(nextForm.memoryPerTurnRecallEnabled).toBe(false);

    // Re-render with the toggled-off form: the gated row disappears.
    cleanup();
    render(<MemorySection form={nextForm} setForm={setForm} memory={memoryProps} />);
    expect(document.getElementById("memoryPerTurnRecallTopK")).toBeNull();
  });
});
