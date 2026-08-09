import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MergeSection } from "../MergeSection";
import { mergeSearchEntries } from "../MergeSection.search";
import type { MergeSectionProps } from "../MergeSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

function makeProps(overrides: Partial<MergeSectionProps["form"]> = {}): MergeSectionProps {
  return {
    scopeBanner: null,
    form: { autoMerge: true, planApprovalMode: "workflow", merger: { mode: "ai" }, testMode: false, mergeStrategy: "pull-request", ...overrides } as MergeSectionProps["form"],
    setForm: vi.fn(),
    integrationBranchOptions: ["main"],
    integrationBranchCustomMode: false,
    setIntegrationBranchCustomMode: vi.fn(),
  };
}

function RequiredChecksHarness(): JSX.Element {
  const [form, setForm] = useState(makeProps().form);
  return <>
    <MergeSection {...makeProps()} form={form} setForm={setForm} />
    <output data-testid="required-checks-value">{JSON.stringify(form.requiredChecks)}</output>
  </>;
}

describe("MergeSection requiredChecks", () => {
  it("round-trips comma-separated check names and clears to undefined", async () => {
    const user = userEvent.setup();
    render(<RequiredChecksHarness />);

    const input = screen.getByLabelText("Required pull-request checks");
    await user.type(input, "build, ci");
    expect(screen.getByTestId("required-checks-value")).toHaveTextContent('["build","ci"]');

    await user.clear(input);
    expect(screen.getByTestId("required-checks-value")).toHaveTextContent("");
  });

  it("renders an empty input for an unset setting and registers search copy", () => {
    render(<MergeSection {...makeProps({ requiredChecks: undefined })} />);
    expect(screen.getByLabelText("Required pull-request checks")).toHaveValue("");
    expect(mergeSearchEntries).toContainEqual(expect.objectContaining({ key: "requiredChecks" }));
  });
});
