// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { GeneralSection } from "../GeneralSection";
import type { SettingsFormState } from "../context";
import { fetchWorkflows } from "../../../../api";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock("../../../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../api")>(),
  fetchWorkflows: vi.fn(),
}));

const WORKFLOWS = [
  { id: "builtin:coding", name: "Coding", ir: {} },
  { id: "builtin:quick-fix", name: "Quick Fix", ir: {} },
] as unknown as import("@fusion/core").WorkflowDefinition[];

function GeneralHost({ initialForm }: { initialForm: Partial<SettingsFormState> }) {
  const [form, setForm] = useState(initialForm as SettingsFormState);
  return (
    <GeneralSection
      form={form}
      setForm={setForm}
      addToast={vi.fn()}
      prefixError={null}
      setPrefixError={vi.fn()}
      projectTrackingRepoOptions={[]}
      projectTrackingRepoLoading={false}
      projectTrackingRepoError={null}
    />
  );
}

beforeEach(() => {
  vi.mocked(fetchWorkflows).mockReset();
  vi.mocked(fetchWorkflows).mockResolvedValue(WORKFLOWS);
});
afterEach(() => cleanup());

describe("GeneralSection built-in workflow enablement", () => {
  it("disables only the final checked workflow and prevents clearing it", async () => {
    render(<GeneralHost initialForm={{ enabledBuiltinWorkflowIds: ["builtin:coding", "builtin:quick-fix"] }} />);

    const coding = await screen.findByLabelText("Coding") as HTMLInputElement;
    const quickFix = await screen.findByLabelText("Quick Fix") as HTMLInputElement;
    expect(coding.disabled).toBe(false);
    expect(quickFix.disabled).toBe(false);

    fireEvent.click(quickFix);
    await waitFor(() => expect(coding.disabled).toBe(true));
    expect(quickFix.checked).toBe(false);
    expect(coding).toHaveAttribute("aria-describedby", "builtin-workflow-enablement-hint");

    fireEvent.click(coding);
    expect(coding.checked).toBe(true);
  });

  it("starts with a sole configured workflow disabled and explains the guard accessibly", async () => {
    render(<GeneralHost initialForm={{ enabledBuiltinWorkflowIds: ["builtin:coding"] }} />);

    const coding = await screen.findByLabelText("Coding") as HTMLInputElement;
    expect(coding.checked).toBe(true);
    expect(coding.disabled).toBe(true);
    expect(document.getElementById("builtin-workflow-enablement-hint")).toHaveTextContent("At least one built-in workflow must remain enabled");
  });
});
