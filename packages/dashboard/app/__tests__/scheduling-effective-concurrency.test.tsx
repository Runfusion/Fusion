// @vitest-environment jsdom

import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SchedulingSection } from "../components/settings/sections/SchedulingSection";
import type { SettingsFormState } from "../components/settings/sections/context";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

function SchedulingHarness({ initial }: { initial: Partial<SettingsFormState> }) {
  const [form, setForm] = useState<SettingsFormState>(initial as SettingsFormState);
  return (
    <SchedulingSection
      form={form}
      setForm={setForm}
      onOverlapIgnorePathChange={() => {}}
      onOpenOverlapPathPicker={() => {}}
      onRemoveOverlapIgnorePath={() => {}}
      onAddOverlapIgnorePath={() => {}}
    />
  );
}

describe("SchedulingSection independent agent concurrency affordance", () => {
  it("accepts the shared 1–50 range through the rendered settings control", async () => {
    const user = userEvent.setup();
    render(<SchedulingHarness initial={{}} />);

    const input = screen.getByLabelText("Max Concurrent Tasks");
    await user.type(input, "12");

    expect(input).toHaveValue(12);
    expect(input).toHaveAttribute("max", "50");
    expect(screen.getByText("Default: 2. Caps every AI-active task, including planning, independently of Max Worktrees.")).toBeInTheDocument();
  });

  it("never presents Max Worktrees as a binding agent ceiling", () => {
    const { rerender } = render(<SchedulingHarness initial={{ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: true }} />);
    expect(screen.queryByText(/Effective concurrency ceiling/)).not.toBeInTheDocument();

    rerender(<SchedulingHarness key="worktree-limit-off" initial={{ maxConcurrent: 8, maxWorktrees: 4, worktreeLimitEnabled: false }} />);
    expect(screen.queryByText(/Effective concurrency ceiling/)).not.toBeInTheDocument();
  });
});
